import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type Sandbox, migratedDb, sandbox } from './helpers'
import type { Db } from '../src/db/client'
import {
  type ApplicationStatus, createApplication, getApplication, listEvents, PAY_FIELDS, setStatus, updateApplicationFields,
} from '../src/db/applications'
import { addStage, deleteStage, listStages, updateStage } from '../src/db/interviews'
import { upsertPosting } from '../src/db/postings'

let box: Sandbox
let db: Db
let seq = 0
beforeEach(() => {
  box = sandbox()
  db = migratedDb(box.home)
})
afterEach(() => {
  db.close()
  box.cleanup()
})

const application = (status: ApplicationStatus = 'applied') => {
  seq += 1
  const posting = upsertPosting(db, { source: 'manual', url: `https://acme.com/jobs/${seq}`, title: 'Engineer', company: 'Acme' })
  return createApplication(db, { postingId: posting.id, status })
}

test('addStage records an interview round with stage_type, scheduled_at and a pending outcome', () => {
  const app = application('applied')
  const { application: updated, stage } = addStage(db, app.id, {
    kind: 'interviewing', stageType: 'phone_screen', scheduledAt: '2026-11-03T17:00:00Z', note: 'recruiter call',
    contacts: [{ name: 'Alex Doe', title: 'Recruiter', email: 'alex@example.com' }],
  })
  expect(updated.status).toBe('interviewing')
  expect(stage).toMatchObject({
    application_id: app.id, from_status: 'applied', to_status: 'interviewing', stage_type: 'phone_screen',
    scheduled_at: '2026-11-03T17:00:00Z', outcome: 'pending', note: 'recruiter call', source: 'agent',
    contacts: [{ name: 'Alex Doe', title: 'Recruiter', email: 'alex@example.com' }],
  })
  const row = db.prepare('SELECT stage_type, scheduled_at, outcome FROM application_events WHERE id = ?').get(stage.id)
  expect(row).toEqual({ stage_type: 'phone_screen', scheduled_at: '2026-11-03T17:00:00Z', outcome: 'pending' })
  expect(listEvents(db, app.id)).toHaveLength(2)
})

test('addStage advances saved and applied forward and never regresses', () => {
  const saved = application('saved')
  expect(saved.applied_at).toBeNull()
  const first = addStage(db, saved.id, { kind: 'interviewing', stageType: 'information' }).application
  expect(first.status).toBe('interviewing')
  expect(first.applied_at).not.toBeNull()
  const offered = addStage(db, saved.id, { kind: 'offered', stageType: 'verbal' })
  expect(offered.application.status).toBe('offered')
  expect(offered.stage.outcome).toBeNull()
  expect(offered.stage.from_status).toBe('interviewing')
  const late = addStage(db, saved.id, { kind: 'interviewing', stageType: 'onsite', scheduledAt: '2026-10-01' })
  expect(late.application.status).toBe('offered')
  expect(late.stage.from_status).toBe('offered')
  expect(late.stage.scheduled_at).toBe('2026-10-01')
})

test('addStage never changes a terminal status', () => {
  for (const status of ['accepted', 'deny_by_employer', 'deny_by_candidate', 'no_response'] as const) {
    const app = application(status)
    const { application: after, stage } = addStage(db, app.id, { kind: 'offered', stageType: 'written' })
    expect(after.status).toBe(status)
    expect(after.closed_at).toBe(app.closed_at)
    expect(stage.from_status).toBe(status)
  }
})

test('addStage rejects a mismatched kind and stage_type, a bad outcome, date or contact', () => {
  const app = application()
  expect(() => addStage(db, app.id, { kind: 'interviewing', stageType: 'verbal' }))
    .toThrow('stage_type verbal is not valid for interviewing')
  expect(() => addStage(db, app.id, { kind: 'offered', stageType: 'technical' }))
    .toThrow('stage_type technical is not valid for offered')
  expect(() => addStage(db, app.id, { kind: 'applied' as never, stageType: 'technical' })).toThrow('kind must be one of')
  expect(() => addStage(db, app.id, { kind: 'interviewing', stageType: 'technical', outcome: 'maybe' as never }))
    .toThrow('outcome maybe is not valid')
  expect(() => addStage(db, app.id, { kind: 'interviewing', stageType: 'technical', scheduledAt: 'next tuesday' }))
    .toThrow('scheduled_at must be an ISO date')
  expect(() => addStage(db, app.id, { kind: 'interviewing', stageType: 'technical', contacts: [{ name: ' ' }] }))
    .toThrow('contacts')
  expect(() => addStage(db, app.id, {
    kind: 'interviewing', stageType: 'technical', contacts: [{ name: 'Alex', email: 'not-an-email' }],
  })).toThrow('email is invalid')
  expect(() => addStage(db, app.id, {
    kind: 'interviewing', stageType: 'technical', contacts: Array.from({ length: 21 }, (_, i) => ({ name: `P${i}` })),
  })).toThrow('at most 20 contacts')
  expect(() => addStage(db, 9999, { kind: 'interviewing', stageType: 'technical' })).toThrow('application 9999 not found')
  expect(listEvents(db, app.id)).toHaveLength(1)
  expect(getApplication(db, app.id)?.status).toBe('applied')
})

test('updateStage edits stage fields and contacts, keeping other metadata keys', () => {
  const app = application()
  const { stage } = addStage(db, app.id, { kind: 'interviewing', stageType: 'technical' })
  db.prepare('UPDATE application_events SET metadata = ? WHERE id = ?').run('{"imported_from":"pg"}', stage.id)
  const updated = updateStage(db, stage.id, {
    stageType: 'system_design', scheduledAt: '2026-11-05', outcome: 'advanced', note: 'went well',
    contacts: [{ name: 'Sam Roe', linkedin: 'https://www.linkedin.com/in/example', phone: '' }],
  })
  expect(updated).toMatchObject({
    stage_type: 'system_design', scheduled_at: '2026-11-05', outcome: 'advanced', note: 'went well',
    contacts: [{ name: 'Sam Roe', linkedin: 'https://www.linkedin.com/in/example' }],
  })
  expect(JSON.parse(updated.metadata!)).toEqual({
    imported_from: 'pg', contacts: [{ name: 'Sam Roe', linkedin: 'https://www.linkedin.com/in/example' }],
  })
  const cleared = updateStage(db, stage.id, { scheduledAt: null, outcome: null })
  expect(cleared).toMatchObject({ scheduled_at: null, outcome: null, stage_type: 'system_design' })
  expect(() => updateStage(db, stage.id, { stageType: 'written' })).toThrow('not valid for interviewing')
  expect(() => updateStage(db, stage.id, { outcome: 'won' as never })).toThrow('outcome won is not valid')
  expect(getApplication(db, app.id)?.status).toBe('interviewing')
})

test('updateStage and deleteStage refuse non-stage events', () => {
  const app = application()
  const created = listEvents(db, app.id)[0]!
  setStatus(db, app.id, 'interviewing', { metadata: { stage: 'phone_screen' } })
  const plain = listEvents(db, app.id).at(-1)!
  for (const id of [created.id, plain.id]) {
    expect(() => deleteStage(db, id)).toThrow(`event ${id} is not an interview or offer stage`)
    expect(() => updateStage(db, id, { outcome: 'advanced' })).toThrow('is not an interview or offer stage')
  }
  expect(() => deleteStage(db, 9999)).toThrow('event 9999 not found')
  expect(listEvents(db, app.id)).toHaveLength(2)
})

test('deleteStage removes the stage and leaves the application status alone', () => {
  const app = application()
  const { stage } = addStage(db, app.id, { kind: 'offered', stageType: 'verbal' })
  expect(deleteStage(db, stage.id).id).toBe(stage.id)
  expect(listStages(db, app.id)).toEqual([])
  expect(getApplication(db, app.id)?.status).toBe('offered')
})

test('listStages orders by scheduled_at, falling back to created_at, then id', () => {
  const app = application()
  const late = addStage(db, app.id, { kind: 'interviewing', stageType: 'onsite', scheduledAt: '2999-12-01' }).stage
  const early = addStage(db, app.id, { kind: 'interviewing', stageType: 'phone_screen', scheduledAt: '2000-01-01' }).stage
  const unscheduled = addStage(db, app.id, { kind: 'interviewing', stageType: 'take_home' }).stage
  setStatus(db, app.id, 'deny_by_employer')
  expect(listStages(db, app.id).map((stage) => stage.id)).toEqual([early.id, unscheduled.id, late.id])
})

test('updateApplicationFields sets and reads back every pay and override column', () => {
  const app = application('offered')
  const pay = Object.fromEntries(PAY_FIELDS.map((key, i) => [key, (i + 1) * 1000]))
  const text = { currency: 'USD', country_override: 'US', state_override: 'CA', city_override: 'San Francisco' }
  const updated = updateApplicationFields(db, app.id, { ...pay, ...text })
  expect(updated).toMatchObject({ ...pay, ...text })
  expect(getApplication(db, app.id)).toMatchObject({ ...pay, ...text })
  expect(updateApplicationFields(db, app.id, { salary_min: null }).salary_min).toBeNull()
})

test('updateApplicationFields rejects bad pay, currency and country values cleanly', () => {
  const app = application()
  expect(() => updateApplicationFields(db, app.id, { salary_min: -1 })).toThrow('salary_min: must be 0 or more')
  expect(() => updateApplicationFields(db, app.id, { bonus: 1.5 })).toThrow('bonus: must be a whole number')
  expect(() => updateApplicationFields(db, app.id, { currency: 'US' })).toThrow('currency: must be a 3-letter')
  expect(() => updateApplicationFields(db, app.id, { country_override: 'us' })).toThrow('country_override: must be 2')
  expect(() => updateApplicationFields(db, app.id, { stage: 'x' } as never)).toThrow()
  expect(getApplication(db, app.id)).toMatchObject({ salary_min: null, bonus: null, currency: null, country_override: null })
})
