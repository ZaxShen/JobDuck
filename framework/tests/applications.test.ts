import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type Sandbox, migratedDb, sandbox } from './helpers'
import type { Db } from '../src/db/client'
import { createApplication, listApplications, listEvents, setStatus } from '../src/db/applications'
import { findPostingByUrl, upsertPosting } from '../src/db/postings'

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

const posting = () => upsertPosting(db, {
  source: 'manual', url: 'https://www.acme.com/jobs/1/', title: 'AI Engineer', company: 'Acme', location: 'Remote',
})

test('upsertPosting dedupes on url_key, keeps known fields and replaces them only from an equal or higher source', () => {
  const first = posting()
  const second = upsertPosting(db, { source: 'agent', url: 'http://acme.com/jobs/1', title: 'AI Engineer II', company: 'Acme' })
  expect(second.id).toBe(first.id)
  expect(second.title).toBe('AI Engineer')
  expect(second.location).toBe('Remote')
  expect(upsertPosting(db, { source: 'manual', url: 'https://acme.com/jobs/1', title: 'AI Engineer II', company: 'Acme' }).title)
    .toBe('AI Engineer II')
  expect(findPostingByUrl(db, 'acme.com/jobs/1?utm=x')?.id).toBe(first.id)
  expect(findPostingByUrl(db, 'https://acme.com/jobs/2')).toBeUndefined()
})

test('createApplication starts as saved and moves to the requested status with a second event', () => {
  const app = createApplication(db, { postingId: posting().id, status: 'applied', note: 'via agent' })
  expect(app.status).toBe('applied')
  expect(app.note).toBe('via agent')
  expect(app.applied_at).not.toBeNull()
  expect(app.closed_at).toBeNull()
  expect(listEvents(db, app.id).map(({ from_status, to_status, source, note }) => ({ from_status, to_status, source, note })))
    .toEqual([
      { from_status: null, to_status: 'saved', source: 'agent', note: null },
      { from_status: 'saved', to_status: 'applied', source: 'agent', note: 'via agent' },
    ])

  const saved = createApplication(db, {
    postingId: upsertPosting(db, { source: 'manual', url: 'https://acme.com/jobs/2', title: 'PM', company: 'Acme' }).id,
    note: 'shortlisted', appliedAt: '2026-01-02T03:04:05.000Z',
  })
  expect(saved).toMatchObject({ status: 'saved', applied_at: null, pending_reason: null, note: 'shortlisted' })
  expect(listEvents(db, saved.id).map((event) => [event.from_status, event.to_status, event.note]))
    .toEqual([[null, 'saved', 'shortlisted']])

  const closed = createApplication(db, {
    postingId: upsertPosting(db, { source: 'manual', url: 'https://acme.com/jobs/3', title: 'QA', company: 'Acme' }).id,
    status: 'no_response', source: 'user',
  })
  expect(closed).toMatchObject({ status: 'no_response', closed_by: 'user' })
  expect(closed.closed_at).not.toBeNull()
})

test('a posting has at most one live application', () => {
  const { id } = posting()
  const app = createApplication(db, { postingId: id })
  expect(() => createApplication(db, { postingId: id })).toThrow()
  expect(listEvents(db, app.id)).toHaveLength(1)
  db.prepare('UPDATE applications SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), app.id)
  expect(createApplication(db, { postingId: id }).id).not.toBe(app.id)
})

test('setStatus records events and closes terminal statuses', () => {
  const app = createApplication(db, { postingId: posting().id })
  const interviewing = setStatus(db, app.id, 'interviewing', { source: 'user', metadata: { stage: 'phone_screen' } })
  expect(interviewing.closed_at).toBeNull()
  expect(interviewing.applied_at).not.toBeNull()

  const denied = setStatus(db, app.id, 'deny_by_employer', { source: 'sync', closedBy: 'rejection_sync' })
  expect(denied.status).toBe('deny_by_employer')
  expect(denied.closed_at).not.toBeNull()
  expect(denied.closed_by).toBe('rejection_sync')

  const reopened = setStatus(db, app.id, 'offered')
  expect(reopened.closed_at).toBeNull()
  expect(reopened.closed_by).toBeNull()

  const events = listEvents(db, app.id).map((e) => [e.from_status, e.to_status, e.source])
  expect(events).toEqual([
    [null, 'saved', 'agent'],
    ['saved', 'interviewing', 'user'],
    ['interviewing', 'deny_by_employer', 'sync'],
    ['deny_by_employer', 'offered', 'agent'],
  ])
  expect(JSON.parse(listEvents(db, app.id)[1]!.metadata ?? '{}')).toEqual({ stage: 'phone_screen' })
})

test('setStatus rejects unknown applications and statuses', () => {
  expect(() => setStatus(db, 999, 'applied')).toThrow('application 999 not found')
  const app = createApplication(db, { postingId: posting().id })
  expect(() => setStatus(db, app.id, 'withdrawn' as never)).toThrow()
  expect(listEvents(db, app.id)).toHaveLength(1)
})

test('listApplications filters by status and since', () => {
  const a = createApplication(db, { postingId: posting().id, status: 'applied' })
  const other = upsertPosting(db, { source: 'manual', url: 'https://beta.io/jobs/9', title: 'MLE', company: 'Beta' })
  const b = createApplication(db, { postingId: other.id })
  expect(listApplications(db).map((x) => x.id).sort()).toEqual([a.id, b.id].sort())
  expect(listApplications(db, { status: 'applied' }).map((x) => x.id)).toEqual([a.id])
  expect(listApplications(db, { status: ['saved', 'applied'] })).toHaveLength(2)
  expect(listApplications(db, { since: '2999-01-01T00:00:00.000Z' })).toEqual([])
})

test('setStatus appends its note to the application note in order and keeps it on the event', () => {
  const app = createApplication(db, { postingId: posting().id, status: 'saved' })
  expect(app.note).toBeNull()
  const applied = setStatus(db, app.id, 'applied', { note: 'Approval: yes' })
  expect(applied.note).toBe('Approval: yes')
  const interviewing = setStatus(db, app.id, 'interviewing', { note: 'phone screen' })
  expect(interviewing.note).toBe('Approval: yes\nphone screen')
  expect(setStatus(db, app.id, 'offered').note).toBe('Approval: yes\nphone screen')
  expect(listEvents(db, app.id).map((event) => event.note)).toEqual([null, 'Approval: yes', 'phone screen', null])

  const withNote = createApplication(db, {
    postingId: upsertPosting(db, { source: 'manual', url: 'https://acme.com/jobs/2', title: 'PM', company: 'Acme' }).id,
    status: 'saved', note: 'full note',
  })
  expect(setStatus(db, withNote.id, 'applied', { note: 'Approval: ok' }).note).toBe('full note\nApproval: ok')
})
