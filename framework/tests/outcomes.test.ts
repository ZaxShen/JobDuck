import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type Sandbox, migratedDb, sandbox } from './helpers'
import type { Db } from '../src/db/client'
import { createApplication, getApplication, listEvents, softDeleteApplication } from '../src/db/applications'
import {
  dismissOutcome, getOutcome, insertOutcome, listLiveApplicationsForMatching, listOutcomes, markSynced, matchOutcome, setNeedsMatch,
} from '../src/db/outcomes'
import { upsertPosting } from '../src/db/postings'

let box: Sandbox
let db: Db
beforeEach(() => {
  box = sandbox()
  db = migratedDb(box.home)
})
afterEach(() => {
  db.close()
  box.cleanup()
})

const application = (status: 'applied' | 'accepted' = 'applied') => {
  const posting = upsertPosting(db, { source: 'manual', url: `https://acme.com/jobs/${status}`, title: 'AI Engineer', company: 'Acme' })
  return createApplication(db, { postingId: posting.id, status })
}

const rejection = (messageId = 'msg-1') => insertOutcome(db, {
  message_id: messageId, kind: 'rejection', company: 'Acme', title: 'AI Engineer',
  received_at: '2026-10-01T12:00:00.000Z', status: 'needs_match', candidates: [{ id: 1 }],
})

test('insertOutcome is idempotent on message_id', () => {
  const first = rejection()
  const again = insertOutcome(db, { message_id: 'msg-1', kind: 'rejection', received_at: '2026-10-02T00:00:00.000Z', status: 'pending' })
  expect(again.id).toBe(first.id)
  expect(again.status).toBe('needs_match')
  expect(again.received_at).toBe('2026-10-01T12:00:00.000Z')
  expect(JSON.parse(first.candidates ?? 'null')).toEqual([{ id: 1 }])
  expect(listOutcomes(db)).toHaveLength(1)
  rejection('msg-2')
  expect(listOutcomes(db, { status: 'needs_match' })).toHaveLength(2)
  expect(listOutcomes(db, { status: 'matched' })).toHaveLength(0)
})

test('matchOutcome closes the application as deny_by_employer with a dashboard event', () => {
  const app = application()
  const outcome = rejection()
  const result = matchOutcome(db, outcome.id, app.id, { source: 'dashboard' })
  expect(result.outcome).toMatchObject({ status: 'matched', matched_by: 'dashboard', application_id: app.id })
  expect(result.application.status).toBe('deny_by_employer')
  expect(getApplication(db, app.id)?.closed_at).not.toBeNull()
  const last = listEvents(db, app.id).at(-1)!
  expect(last).toMatchObject({
    from_status: 'applied', to_status: 'deny_by_employer', source: 'dashboard',
    note: 'Rejection email 2026-10-01T12:00:00.000Z',
  })
  expect(JSON.parse(last.metadata ?? '{}')).toEqual({ outcome_id: outcome.id })
  expect(listOutcomes(db, { status: 'needs_match' })).toHaveLength(0)
})

test('matchOutcome leaves terminal applications untouched', () => {
  const app = application('accepted')
  const outcome = rejection()
  const result = matchOutcome(db, outcome.id, app.id, { source: 'dashboard' })
  expect(result.outcome.status).toBe('matched')
  expect(result.application.status).toBe('accepted')
  expect(getApplication(db, app.id)?.status).toBe('accepted')
  expect(listEvents(db, app.id)).toHaveLength(2)
})

test('matchOutcome rejects unknown ids without side effects', () => {
  const outcome = rejection()
  expect(() => matchOutcome(db, outcome.id, 999, { source: 'dashboard' })).toThrow('application 999 not found')
  expect(listOutcomes(db, { status: 'needs_match' })).toHaveLength(1)
  expect(() => matchOutcome(db, 999, application().id, { source: 'dashboard' })).toThrow('outcome 999 not found')
})

test('dismissOutcome removes the outcome from the queue', () => {
  const outcome = rejection()
  expect(dismissOutcome(db, outcome.id).status).toBe('dismissed')
  expect(listOutcomes(db, { status: 'needs_match' })).toHaveLength(0)
  expect(() => dismissOutcome(db, 999)).toThrow('outcome 999 not found')
})

test('matchOutcome records matched_by when given', () => {
  const app = application()
  const result = matchOutcome(db, rejection().id, app.id, { source: 'sync', matchedBy: 'url' })
  expect(result.outcome.matched_by).toBe('url')
  expect(listEvents(db, app.id).at(-1)?.source).toBe('sync')
})

test('markSynced stamps synced_at on the given outcomes only', () => {
  const a = rejection('msg-a')
  const b = rejection('msg-b')
  const c = rejection('msg-c')
  expect(markSynced(db, [a.id, c.id], '2026-10-02T00:00:00.000Z')).toBe(2)
  expect(getOutcome(db, a.id)?.synced_at).toBe('2026-10-02T00:00:00.000Z')
  expect(getOutcome(db, b.id)?.synced_at).toBeNull()
  expect(getOutcome(db, c.id)?.synced_at).toBe('2026-10-02T00:00:00.000Z')
  expect(markSynced(db, [], '2026-10-02T00:00:00.000Z')).toBe(0)
})

test('setNeedsMatch queues the outcome with its candidates', () => {
  const outcome = insertOutcome(db, { message_id: 'msg-n', kind: 'rejection', received_at: '2026-10-01T00:00:00.000Z', status: 'pending' })
  const candidates = [{ application_id: 1, company: 'Acme', title: 'AI Engineer', score: 0.5 }]
  const row = setNeedsMatch(db, outcome.id, candidates)
  expect(row.status).toBe('needs_match')
  expect(JSON.parse(row.candidates ?? 'null')).toEqual(candidates)
  expect(listOutcomes(db, { status: 'needs_match' }).map((o) => o.id)).toEqual([outcome.id])
  expect(() => setNeedsMatch(db, 999, [])).toThrow('outcome 999 not found')
})

test('listLiveApplicationsForMatching skips terminal and deleted applications', () => {
  const live = application()
  application('accepted')
  const gone = createApplication(db, {
    postingId: upsertPosting(db, { source: 'manual', url: 'https://acme.com/jobs/gone', title: 'AI Engineer', company: 'Acme' }).id,
    status: 'applied',
  })
  softDeleteApplication(db, gone.id)
  const rows = listLiveApplicationsForMatching(db)
  expect(rows.map((row) => row.id)).toEqual([live.id])
  expect(rows[0]).toMatchObject({ company: 'Acme', title: 'AI Engineer', url_key: 'acme.com/jobs/applied', source_id: null })
})
