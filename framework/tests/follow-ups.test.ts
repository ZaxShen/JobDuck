import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type Sandbox, migratedDb, sandbox } from './helpers'
import type { Db } from '../src/db/client'
import {
  type ApplicationStatus, createApplication, deleteEvent, getApplication, listEvents, setStatus, UNDO_LATEST_ONLY,
  updateApplicationFields,
} from '../src/db/applications'
import {
  addBusinessDays, DEFAULT_FOLLOW_UP_WAIT, FOLLOW_UP_WAIT_KEY, FOLLOW_UP_WAIT_MESSAGE, followUpsDue, getFollowUpWait,
  listFollowUpsDue, recordFollowUp, setFollowUpWait,
} from '../src/db/follow-ups'
import { addStage, deleteStage, getStage, listStages, updateStage } from '../src/db/interviews'
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

const FRIDAY = '2025-01-03T10:00:00.000Z'
const at = (iso: string) => new Date(iso)

const application = (company = 'Acme', status: ApplicationStatus = 'applied') => {
  seq += 1
  const posting = upsertPosting(db, {
    source: 'manual', url: `https://jobs.example.com/${seq}`, title: 'Platform Engineer', company,
  })
  return createApplication(db, { postingId: posting.id, status })
}

const round = (applicationId: number, scheduledAt: string | null = FRIDAY) =>
  addStage(db, applicationId, { kind: 'interviewing', stageType: 'technical', scheduledAt }).stage

const kinds = (now: string) => listFollowUpsDue(db, at(now)).map((item) => [item.kind, item.round_id])

test('addBusinessDays skips weekends and counts a weekend start from Monday 00:00 UTC', () => {
  expect(addBusinessDays(FRIDAY, 3)).toBe('2025-01-08T10:00:00.000Z')
  expect(addBusinessDays(FRIDAY, 1)).toBe('2025-01-06T10:00:00.000Z')
  expect(addBusinessDays(FRIDAY, 0)).toBe(FRIDAY)
  expect(addBusinessDays('2025-01-04T15:30:00Z', 1)).toBe('2025-01-07T00:00:00.000Z')
  expect(addBusinessDays('2025-01-05T23:00:00Z', 3)).toBe('2025-01-09T00:00:00.000Z')
  expect(addBusinessDays('2025-01-04T15:30:00Z', 0)).toBe('2025-01-06T00:00:00.000Z')
  expect(addBusinessDays('2025-01-06', 5)).toBe('2025-01-13T00:00:00.000Z')
  expect(addBusinessDays('2025-01-03T10:00', 3)).toBe('2025-01-08T10:00:00.000Z')
  expect(() => addBusinessDays('soon', 3)).toThrow()
  expect(() => addBusinessDays(FRIDAY, -1)).toThrow()
})

test('thank_you is due within 24 hours of the round and carries the overridden company and title', () => {
  const app = application('Acme')
  updateApplicationFields(db, app.id, { company_override: 'Acme Robotics', title_override: 'Staff Platform Engineer' })
  const stage = round(app.id)
  expect(listFollowUpsDue(db, at('2025-01-03T09:59:59Z'))).toEqual([])
  expect(listFollowUpsDue(db, at('2025-01-03T20:00:00Z'))).toEqual([{
    kind: 'thank_you', application_id: app.id, round_id: stage.id, company: 'Acme Robotics',
    title: 'Staff Platform Engineer', stage_type: 'technical', round_at: FRIDAY, due_at: '2025-01-04T10:00:00.000Z',
    follow_ups_sent: 0, suggest_ghosted: false,
  }])
  expect(kinds(FRIDAY)).toEqual([['thank_you', stage.id]])
  expect(kinds('2025-01-04T10:00:00Z')).toEqual([])
})

test('a recorded thank_you_sent suppresses the thank_you and stores kind and round_id', () => {
  const stage = round(application().id)
  const event = recordFollowUp(db, { roundId: stage.id, kind: 'thank_you_sent', sentAt: '2025-01-03T12:00:00Z' })
  expect(event).toMatchObject({
    kind: 'thank_you_sent', round_id: stage.id, occurred_at: '2025-01-03T12:00:00Z', stage_type: null, outcome: null,
    from_status: 'interviewing', to_status: 'interviewing',
  })
  const row = db.prepare('SELECT kind, round_id FROM application_events WHERE id = ?').get(event.id) as Record<string, unknown>
  expect(row.kind).not.toBeNull()
  expect(row.round_id).not.toBeNull()
  expect(kinds('2025-01-03T20:00:00Z')).toEqual([])
})

test('follow_up is due 3 business days after the round, not before', () => {
  const stage = round(application('Globex').id)
  expect(kinds('2025-01-08T09:59:59Z')).toEqual([])
  const [due] = listFollowUpsDue(db, at('2025-01-08T10:00:00Z'))
  expect(due).toMatchObject({ kind: 'follow_up', round_id: stage.id, company: 'Globex', due_at: '2025-01-08T10:00:00.000Z' })
  expect(listFollowUpsDue(db, at('2025-01-08T10:00:00Z'))).toHaveLength(1)
})

test('a newer round suppresses the older follow_up, and a follow_up_sent re-arms it N business days later', () => {
  const app = application()
  const first = round(app.id)
  const second = round(app.id, '2025-01-06T10:00:00Z')
  expect(kinds('2025-01-08T10:00:00Z')).toEqual([])
  expect(kinds('2025-01-09T10:00:00Z')).toEqual([['follow_up', first.id], ['follow_up', second.id]])
  updateStage(db, second.id, { outcome: 'advanced' })

  recordFollowUp(db, { roundId: first.id, kind: 'follow_up_sent', sentAt: '2025-01-09T12:00:00Z' })
  expect(kinds('2025-01-14T11:59:59Z')).toEqual([])
  const [rearmed] = listFollowUpsDue(db, at('2025-01-14T12:00:00Z'))
  expect(rearmed).toMatchObject({
    kind: 'follow_up', round_id: first.id, due_at: '2025-01-14T12:00:00.000Z', follow_ups_sent: 1, suggest_ghosted: false,
  })
})

test('suggest_ghosted turns true after 2 follow-ups', () => {
  const stage = round(application().id)
  recordFollowUp(db, { roundId: stage.id, kind: 'follow_up_sent', sentAt: '2025-01-08T10:00:00Z' })
  recordFollowUp(db, { roundId: stage.id, kind: 'follow_up_sent', sentAt: '2025-01-13T10:00:00Z' })
  const [due] = listFollowUpsDue(db, at('2025-01-16T10:00:00Z'))
  expect(due).toMatchObject({ kind: 'follow_up', round_id: stage.id, follow_ups_sent: 2, suggest_ghosted: true })
})

test('a non-pending outcome, a closed application, a future round or a round with no time is never due', () => {
  const advanced = round(application('Acme').id)
  updateStage(db, advanced.id, { outcome: 'advanced' })
  const closedApp = application('Globex')
  round(closedApp.id)
  setStatus(db, closedApp.id, 'deny_by_employer')
  round(application('Acme').id, '2025-02-03T10:00:00Z')
  round(application('Globex').id, null)
  expect(kinds('2025-01-03T12:00:00Z')).toEqual([['thank_you', advanced.id]])
  expect(kinds('2025-01-20T10:00:00Z')).toEqual([])
})

test('items from several rounds are sorted by due_at ascending', () => {
  const globex = round(application('Globex').id, '2025-01-06T08:00:00Z')
  const acme = round(application('Acme').id, '2025-01-01T09:00:00Z')
  setFollowUpWait(db, 1)
  expect(listFollowUpsDue(db, at('2025-01-06T09:00:00Z')).map((item) => [item.kind, item.round_id, item.due_at])).toEqual([
    ['follow_up', acme.id, '2025-01-02T09:00:00.000Z'],
    ['thank_you', globex.id, '2025-01-07T08:00:00.000Z'],
  ])
})

test('follow_up_business_days defaults to 3, reads back after a set, rejects bad values and is honored', () => {
  expect(getFollowUpWait(db)).toBe(DEFAULT_FOLLOW_UP_WAIT)
  expect(DEFAULT_FOLLOW_UP_WAIT).toBe(3)
  expect(db.prepare('SELECT 1 FROM settings WHERE key = ?').get(FOLLOW_UP_WAIT_KEY)).toBeNull()
  expect(setFollowUpWait(db, 5)).toBe(5)
  expect(db.prepare('SELECT value FROM settings WHERE key = ?').get(FOLLOW_UP_WAIT_KEY)).toEqual({ value: '5' })
  expect(getFollowUpWait(db)).toBe(5)
  for (const bad of [0, 31, 2.5, Number.NaN]) expect(() => setFollowUpWait(db, bad)).toThrow(FOLLOW_UP_WAIT_MESSAGE)
  expect(getFollowUpWait(db)).toBe(5)

  const stage = round(application().id)
  expect(kinds('2025-01-09T10:00:00Z')).toEqual([])
  expect(kinds('2025-01-10T10:00:00Z')).toEqual([['follow_up', stage.id]])
  expect(followUpsDue(db, at('2025-01-10T10:00:00Z')).wait_business_days).toBe(5)

  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('ninety', FOLLOW_UP_WAIT_KEY)
  expect(getFollowUpWait(db)).toBe(DEFAULT_FOLLOW_UP_WAIT)
})

test('recordFollowUp rejects ids that are not interview rounds and bad input', () => {
  const app = application()
  const stage = round(app.id)
  const offer = addStage(db, app.id, { kind: 'offered', stageType: 'written' }).stage
  const statusEvent = listEvents(db, app.id).find((event) => event.stage_type === null)!
  const sent = recordFollowUp(db, { roundId: stage.id, kind: 'thank_you_sent' })
  for (const id of [statusEvent.id, offer.id, sent.id, 9999]) {
    expect(() => recordFollowUp(db, { roundId: id, kind: 'follow_up_sent' })).toThrow(`event ${id} is not an interview round`)
  }
  expect(() => recordFollowUp(db, { roundId: stage.id, kind: 'nudge' as never })).toThrow('kind must be one of')
  expect(() => recordFollowUp(db, { roundId: stage.id, kind: 'follow_up_sent', sentAt: 'yesterday' })).toThrow('sent_at')
})

test('a recorded follow-up leaves the status, the stage list and status undo unchanged', () => {
  const app = application()
  const stage = round(app.id)
  const offered = setStatus(db, app.id, 'offered')
  const stagesBefore = listStages(db, app.id)
  const offeredEvent = listEvents(db, app.id).at(-1)!
  const sent = recordFollowUp(db, { roundId: stage.id, kind: 'follow_up_sent', note: 'checked in' })

  expect(getApplication(db, app.id)?.status).toBe(offered.status)
  expect(listStages(db, app.id)).toEqual(stagesBefore)
  expect(() => getStage(db, sent.id)).toThrow('is not an interview or offer stage')
  expect(() => deleteEvent(db, sent.id)).toThrow(UNDO_LATEST_ONLY)

  deleteEvent(db, offeredEvent.id)
  expect(getApplication(db, app.id)?.status).toBe('interviewing')
  expect(listEvents(db, app.id).some((event) => event.id === sent.id)).toBe(true)

  deleteStage(db, stage.id)
  expect(getApplication(db, app.id)?.status).toBe('applied')
  expect(listEvents(db, app.id).some((event) => event.round_id !== null)).toBe(false)
})
