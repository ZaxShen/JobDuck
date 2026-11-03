import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type Sandbox, migratedDb, sandbox } from './helpers'
import type { Db } from '../src/db/client'
import {
  type ApplicationStatus, createApplication, deleteEvent, getApplication, listEvents, setStatus, TERMINAL_STATUSES,
  UNDO_LATEST_ONLY, updateEvent,
} from '../src/db/applications'
import { addStage } from '../src/db/interviews'
import { applyOutcomeMatch, insertOutcome } from '../src/db/outcomes'
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

const application = (status: ApplicationStatus = 'saved') => {
  seq += 1
  const posting = upsertPosting(db, { source: 'manual', url: `https://acme.com/jobs/${seq}`, title: 'Engineer', company: 'Acme' })
  return createApplication(db, {
    postingId: posting.id, status, pendingReason: status === 'pending' ? 'Enter the emailed code on the form.' : undefined,
  })
}

const storedOccurredAt = (eventId: number) =>
  (db.prepare('SELECT occurred_at FROM application_events WHERE id = ?').get(eventId) as { occurred_at: string | null }).occurred_at

test('setStatus stores occurred_at on the event and uses it for applied_at and closed_at', () => {
  const app = application()
  const applied = setStatus(db, app.id, 'applied', { occurredAt: '2026-03-01' })
  expect(applied.applied_at).toBe('2026-03-01')
  const appliedEvent = listEvents(db, app.id).at(-1)!
  expect(appliedEvent).toMatchObject({ to_status: 'applied', occurred_at: '2026-03-01' })
  expect(storedOccurredAt(appliedEvent.id)).toBe('2026-03-01')

  const interviewing = setStatus(db, app.id, 'interviewing', { occurredAt: '2026-03-10T15:00:00Z' })
  expect(interviewing.applied_at).toBe('2026-03-01')
  const closed = setStatus(db, app.id, 'deny_by_employer', { occurredAt: '2026-03-20' })
  expect(closed).toMatchObject({ closed_at: '2026-03-20', applied_at: '2026-03-01' })
  expect(storedOccurredAt(listEvents(db, app.id).at(-1)!.id)).toBe('2026-03-20')
})

test('setStatus without occurredAt stores a null occurred_at and stamps now', () => {
  const app = application()
  const applied = setStatus(db, app.id, 'applied')
  expect(applied.applied_at).not.toBeNull()
  expect(listEvents(db, app.id).at(-1)?.occurred_at).toBeNull()
})

test('setStatus refuses an invalid occurred_at and writes nothing', () => {
  const app = application()
  for (const bad of ['yesterday', '2026-13-01', '2026-02-30T25:00:00Z', '03/01/2026']) {
    expect(() => setStatus(db, app.id, 'applied', { occurredAt: bad })).toThrow('occurred_at must be an ISO date')
  }
  expect(getApplication(db, app.id)?.status).toBe('saved')
  expect(listEvents(db, app.id)).toHaveLength(1)
})

test('the forward-only guard refuses backwards moves', () => {
  const applied = application('applied')
  expect(() => setStatus(db, applied.id, 'saved')).toThrow(`cannot move application ${applied.id} back from applied to saved`)
  expect(() => setStatus(db, applied.id, 'pending', { pendingReason: 'Wait.' })).toThrow('back from applied to pending')

  const interviewing = application('interviewing')
  expect(() => setStatus(db, interviewing.id, 'applied')).toThrow('back from interviewing to applied; undo the later entry instead')

  const offered = application('offered')
  expect(() => setStatus(db, offered.id, 'interviewing')).toThrow('back from offered to interviewing')
  for (const app of [applied, interviewing, offered]) expect(listEvents(db, app.id)).toHaveLength(2)
})

test('the forward-only guard refuses any move out of a terminal status', () => {
  for (const terminal of TERMINAL_STATUSES) {
    const app = application(terminal)
    for (const target of ['saved', 'applied', 'offered', 'accepted', 'no_response'] as const) {
      expect(() => setStatus(db, app.id, target)).toThrow(`application ${app.id} is closed (${terminal}); undo its latest entry instead`)
    }
    expect(() => setStatus(db, app.id, 'pending', { pendingReason: 'Wait.' })).toThrow('is closed')
    expect(getApplication(db, app.id)?.status).toBe(terminal)
  }
})

test('the forward-only guard refuses a second applied, including legacy data back at saved', () => {
  const app = application('applied')
  expect(() => setStatus(db, app.id, 'applied')).toThrow(`application ${app.id} is already applied`)

  const legacy = application('applied')
  db.prepare("UPDATE applications SET status = 'saved' WHERE id = ?").run(legacy.id)
  db.prepare(`INSERT INTO application_events (application_id, from_status, to_status, source, created_at)
    VALUES (?, 'applied', 'saved', 'user', ?)`).run(legacy.id, new Date().toISOString())
  expect(() => setStatus(db, legacy.id, 'applied')).toThrow(`application ${legacy.id} is already applied`)
  expect(listEvents(db, legacy.id).filter((event) => event.to_status === 'applied')).toHaveLength(1)
})

test('the forward-only guard refuses same-status moves except a pending reason update', () => {
  for (const status of ['saved', 'interviewing', 'offered'] as const) {
    const app = application(status)
    expect(() => setStatus(db, app.id, status)).toThrow(`application ${app.id} is already ${status}`)
  }
  const pending = application('pending')
  expect(setStatus(db, pending.id, 'pending', { pendingReason: 'Upload the transcript.' }))
    .toMatchObject({ status: 'pending', pending_reason: 'Upload the transcript.' })
})

test('saved and pending move both ways and forward moves still work', () => {
  const app = application()
  expect(setStatus(db, app.id, 'pending', { pendingReason: 'Solve the CAPTCHA.' }).status).toBe('pending')
  expect(setStatus(db, app.id, 'saved')).toMatchObject({ status: 'saved', pending_reason: null, applied_at: null })
  expect(setStatus(db, app.id, 'pending', { pendingReason: 'Solve the CAPTCHA.' }).status).toBe('pending')
  expect(setStatus(db, app.id, 'applied').status).toBe('applied')
  expect(setStatus(db, app.id, 'offered').status).toBe('offered')
  expect(setStatus(db, app.id, 'accepted').status).toBe('accepted')
  expect(setStatus(db, application().id, 'no_response').status).toBe('no_response')
})

test('applyOutcomeMatch still closes non-terminal applications and leaves closed ones alone', () => {
  const outcome = (n: number) => insertOutcome(db, {
    message_id: `m-${n}`, kind: 'rejection', received_at: '2026-04-01T00:00:00Z', status: 'needs_match',
  })
  for (const status of ['saved', 'pending', 'applied', 'interviewing', 'offered'] as const) {
    const app = application(status)
    expect(applyOutcomeMatch(db, outcome(app.id).id, app.id, { source: 'sync' }).application.status).toBe('deny_by_employer')
  }
  const closed = application('deny_by_candidate')
  expect(applyOutcomeMatch(db, outcome(closed.id).id, closed.id, { source: 'sync' }).application.status).toBe('deny_by_candidate')
})

test('updateEvent stores a new occurred_at and note and syncs applied_at', () => {
  const app = application()
  setStatus(db, app.id, 'applied', { note: 'via ATS' })
  const event = listEvents(db, app.id).at(-1)!
  const before = getApplication(db, app.id)!
  const updated = updateEvent(db, event.id, { occurredAt: '2026-02-14', note: 'via the careers page' })
  expect(updated).toMatchObject({ id: event.id, occurred_at: '2026-02-14', note: 'via the careers page' })
  expect(storedOccurredAt(event.id)).toBe('2026-02-14')
  const after = getApplication(db, app.id)!
  expect(after.applied_at).toBe('2026-02-14')
  expect(after.updated_at >= before.updated_at).toBe(true)
  expect(updateEvent(db, event.id, { note: null }).note).toBeNull()
  expect(() => updateEvent(db, event.id, { occurredAt: 'soon' })).toThrow('occurred_at must be an ISO date')
})

test('updateEvent syncs closed_at only from the newest entry for the current terminal status', () => {
  const app = application('applied')
  setStatus(db, app.id, 'interviewing', { occurredAt: '2026-03-02' })
  const interviewingEvent = listEvents(db, app.id).at(-1)!
  setStatus(db, app.id, 'deny_by_employer', { occurredAt: '2026-03-09' })
  const closing = listEvents(db, app.id).at(-1)!
  updateEvent(db, interviewingEvent.id, { occurredAt: '2026-03-03' })
  expect(getApplication(db, app.id)?.closed_at).toBe('2026-03-09')
  updateEvent(db, closing.id, { occurredAt: '2026-03-11' })
  expect(getApplication(db, app.id)).toMatchObject({ closed_at: '2026-03-11', status: 'deny_by_employer' })
})

test('updateEvent refuses stage events and unknown or deleted events', () => {
  const app = application('applied')
  const { stage } = addStage(db, app.id, { kind: 'interviewing', stageType: 'phone_screen' })
  expect(() => updateEvent(db, stage.id, { occurredAt: '2026-03-01' })).toThrow(`event ${stage.id} is an interview or offer stage`)
  expect(() => updateEvent(db, 9999, { note: 'x' })).toThrow('event 9999 not found')
  const first = listEvents(db, app.id)[0]!
  db.prepare('UPDATE applications SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), app.id)
  expect(() => updateEvent(db, first.id, { note: 'x' })).toThrow(`event ${first.id} not found`)
})

test('deleteEvent undoes applied back to saved and clears applied_at', () => {
  const app = application()
  setStatus(db, app.id, 'applied', { occurredAt: '2026-03-01' })
  const event = listEvents(db, app.id).at(-1)!
  expect(deleteEvent(db, event.id).id).toBe(event.id)
  expect(getApplication(db, app.id)).toMatchObject({ status: 'saved', applied_at: null, pending_reason: null })
  expect(listEvents(db, app.id).map((row) => row.to_status)).toEqual(['saved'])
  expect(setStatus(db, app.id, 'applied', { occurredAt: '2026-03-02' }).applied_at).toBe('2026-03-02')
})

test('deleteEvent undoes a terminal entry back to the previous status and clears closed_at', () => {
  const app = application('applied')
  setStatus(db, app.id, 'interviewing')
  setStatus(db, app.id, 'deny_by_employer', { occurredAt: '2026-03-09', closedBy: 'rejection_sync' })
  deleteEvent(db, listEvents(db, app.id).at(-1)!.id)
  const reverted = getApplication(db, app.id)!
  expect(reverted).toMatchObject({ status: 'interviewing', closed_at: null, closed_by: null })
  expect(reverted.applied_at).not.toBeNull()
  expect(listEvents(db, app.id)).toHaveLength(3)
})

test('deleteEvent maps an undo back to pending onto saved', () => {
  const app = application('pending')
  setStatus(db, app.id, 'applied')
  deleteEvent(db, listEvents(db, app.id).at(-1)!.id)
  expect(getApplication(db, app.id)).toMatchObject({ status: 'saved', pending_reason: null, applied_at: null })
})

test('deleteEvent refuses older entries, the creation entry, stage entries and unknown events', () => {
  const app = application()
  const created = listEvents(db, app.id)[0]!
  expect(() => deleteEvent(db, created.id)).toThrow(UNDO_LATEST_ONLY)
  setStatus(db, app.id, 'applied')
  const applied = listEvents(db, app.id).at(-1)!
  setStatus(db, app.id, 'offered')
  expect(() => deleteEvent(db, applied.id)).toThrow(UNDO_LATEST_ONLY)
  expect(() => deleteEvent(db, created.id)).toThrow(UNDO_LATEST_ONLY)
  const { stage } = addStage(db, app.id, { kind: 'offered', stageType: 'verbal' })
  expect(() => deleteEvent(db, stage.id)).toThrow(UNDO_LATEST_ONLY)
  expect(() => deleteEvent(db, 9999)).toThrow('event 9999 not found')
  expect(getApplication(db, app.id)?.status).toBe('offered')
  expect(listEvents(db, app.id)).toHaveLength(4)
})
