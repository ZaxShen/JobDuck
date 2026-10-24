import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { type Sandbox, migratedDb, sandbox } from './helpers'
import { type Db, openDb } from '../src/db/client'
import {
  PENDING_REASON_ONLY_PENDING, PENDING_REASON_REQUIRED, createApplication, getApplication, listEvents, setStatus,
} from '../src/db/applications'
import { FOREIGN_KEYS_OFF, currentVersion, loadMigrations, migrate } from '../src/db/migrate'
import { upsertPosting } from '../src/db/postings'
import { createServer, type JobduckServer } from '../src/mcp/server'
import { dbPath } from '../src/paths'

const REASON = 'Enter the code emailed to you on the Acme form, then tell me to continue.'
const NOW = '2026-01-02T03:04:05.000Z'

let box: Sandbox
beforeEach(() => { box = sandbox() })
afterEach(() => box.cleanup())

const count = (db: Db, sql: string) => (db.prepare(sql).get() as { n: number }).n

function versionThreeDb(): Db {
  mkdirSync(box.home, { recursive: true })
  const db = openDb(dbPath(box.home))
  expect(migrate(db, loadMigrations().filter((m) => m.version <= 3))).toEqual([1, 2, 3])
  for (const [id, slug] of [[1, 'one'], [2, 'two']] as const) {
    db.prepare(`INSERT INTO postings (id, source, url, url_key, title, company, created_at, updated_at)
      VALUES (?, 'manual', ?, ?, 'Engineer', 'Acme', ?, ?)`).run(id, `https://acme.com/jobs/${slug}`, `acme.com/jobs/${slug}`, NOW, NOW)
  }
  db.prepare(`INSERT INTO applications (id, posting_id, status, note, salary_offered, currency, created_at, updated_at)
    VALUES (1, 1, 'saved', 'draft', 120000, 'USD', ?, ?)`).run(NOW, NOW)
  db.prepare(`INSERT INTO applications (id, posting_id, status, applied_at, created_at, updated_at)
    VALUES (2, 2, 'deny_by_employer', ?, ?, ?)`).run(NOW, NOW, NOW)
  db.prepare(`INSERT INTO application_events (application_id, from_status, to_status, source, created_at) VALUES
    (1, NULL, 'saved', 'agent', ?), (2, NULL, 'saved', 'agent', ?), (2, 'saved', 'applied', 'agent', ?),
    (2, 'applied', 'deny_by_employer', 'sync', ?)`).run(NOW, NOW, NOW, NOW)
  db.prepare(`INSERT INTO outcomes (message_id, kind, received_at, application_id, status, created_at)
    VALUES ('m1', 'rejection', ?, 2, 'matched', ?)`).run(NOW, NOW)
  return db
}

test('004 keeps saved rows and their events and outcomes unchanged', () => {
  const db = versionThreeDb()
  const events = db.prepare('SELECT * FROM application_events ORDER BY id').all()
  const outcomeLinks = db.prepare('SELECT id, application_id FROM outcomes ORDER BY id').all()

  expect(migrate(db)).toEqual([4])
  expect(currentVersion(db)).toBe(4)
  expect(getApplication(db, 1)).toMatchObject({
    status: 'saved', pending_reason: null, applied_at: null, note: 'draft', salary_offered: 120000, currency: 'USD',
  })
  expect(getApplication(db, 2)).toMatchObject({ status: 'deny_by_employer', pending_reason: null, applied_at: NOW })
  expect(count(db, 'SELECT COUNT(*) AS n FROM application_events')).toBe(events.length)
  expect(db.prepare('SELECT * FROM application_events ORDER BY id').all()).toEqual(events)
  expect(db.prepare('SELECT id, application_id FROM outcomes ORDER BY id').all()).toEqual(outcomeLinks)
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'applications'")
    .all() as { name: string }[]).map((row) => row.name).sort()
  expect(indexes).toEqual(['applications_live_posting', 'applications_status'])
  expect(() => db.prepare('INSERT INTO applications (posting_id, status, created_at, updated_at) VALUES (1, ?, ?, ?)')
    .run('applied', NOW, NOW)).toThrow()
  db.close()
})

test('the migrated CHECK rejects an unknown status and pending without a reason', () => {
  const db = versionThreeDb()
  migrate(db)
  const insert = (status: string, reason: string | null) => db.prepare(`INSERT INTO applications
    (posting_id, status, pending_reason, created_at, updated_at) VALUES (2, ?, ?, ?, ?)`).run(status, reason, NOW, NOW)
  db.prepare('UPDATE applications SET deleted_at = ? WHERE id = 2').run(NOW)
  expect(() => insert('withdrawn', null)).toThrow()
  expect(() => insert('pending', null)).toThrow()
  expect(() => db.prepare("UPDATE applications SET status = 'pending' WHERE id = 1").run()).toThrow()
  db.prepare("UPDATE applications SET status = 'pending', pending_reason = ? WHERE id = 1").run(REASON)
  expect(() => db.prepare('UPDATE applications SET pending_reason = NULL WHERE id = 1').run()).toThrow()
  db.close()
})

test('migrate refuses a foreign_keys=off migration inside an open transaction', () => {
  const db = versionThreeDb()
  db.exec('BEGIN')
  expect(() => migrate(db)).toThrow('inside a transaction')
  db.exec('ROLLBACK')
  expect(currentVersion(db)).toBe(3)
  expect(count(db, 'SELECT COUNT(*) AS n FROM application_events')).toBe(4)
  db.close()
})

test('a foreign_keys=off migration rolls back when it leaves a broken reference', () => {
  const db = versionThreeDb()
  const broken = { version: 4, name: '004_broken.sql', sql: `${FOREIGN_KEYS_OFF}\nDELETE FROM postings WHERE id = 1;` }
  expect(() => migrate(db, [...loadMigrations().filter((m) => m.version <= 3), broken])).toThrow('foreign key')
  expect(currentVersion(db)).toBe(3)
  expect(count(db, 'SELECT COUNT(*) AS n FROM postings')).toBe(2)
  expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
  db.close()
})

test('the data layer requires a reason to enter pending and clears it on the way out', () => {
  const db = migratedDb(box.home)
  const posting = (n: number) => upsertPosting(db, { source: 'manual', url: `https://acme.com/jobs/${n}`, title: 'Engineer', company: 'Acme' })
  expect(() => createApplication(db, { postingId: posting(1).id, pendingReason: REASON })).toThrow(PENDING_REASON_ONLY_PENDING)
  expect(() => createApplication(db, { postingId: posting(1).id, status: 'pending' })).toThrow(PENDING_REASON_REQUIRED)
  expect(() => createApplication(db, { postingId: posting(1).id, status: 'pending', pendingReason: ' ' })).toThrow(PENDING_REASON_REQUIRED)
  expect(() => createApplication(db, { postingId: posting(1).id, status: 'pending', pendingReason: 'x'.repeat(501) })).toThrow('500')
  expect(() => createApplication(db, { postingId: posting(1).id, status: 'applied', pendingReason: REASON }))
    .toThrow(PENDING_REASON_ONLY_PENDING)

  const created = createApplication(db, { postingId: posting(1).id, status: 'pending', pendingReason: REASON, appliedAt: NOW })
  expect(created).toMatchObject({ status: 'pending', pending_reason: REASON, applied_at: null })
  expect(listEvents(db, created.id).map((event) => [event.from_status, event.to_status]))
    .toEqual([[null, 'saved'], ['saved', 'pending']])
  const applied = setStatus(db, created.id, 'applied')
  expect(applied).toMatchObject({ status: 'applied', pending_reason: null })
  expect(applied.applied_at).not.toBeNull()

  expect(() => setStatus(db, created.id, 'pending')).toThrow(PENDING_REASON_REQUIRED)
  expect(getApplication(db, created.id)).toMatchObject({ status: 'applied', pending_reason: null })
  const back = setStatus(db, created.id, 'pending', { pendingReason: 'Confirm the start date with the recruiter.' })
  expect(back).toMatchObject({ status: 'pending', pending_reason: 'Confirm the start date with the recruiter.', applied_at: applied.applied_at })
  expect(setStatus(db, created.id, 'deny_by_candidate').pending_reason).toBeNull()

  const shortlisted = createApplication(db, { postingId: posting(2).id })
  expect(shortlisted).toMatchObject({ status: 'saved', pending_reason: null, applied_at: null })
  setStatus(db, shortlisted.id, 'pending', { pendingReason: REASON })
  expect(setStatus(db, shortlisted.id, 'saved')).toMatchObject({ status: 'saved', pending_reason: null, applied_at: null })
  db.close()
})

interface ToolResult { isError?: boolean; content: { type: string; text: string }[] }

test('record_application starts as saved, stores pending_reason, and both tools refuse pending without one', async () => {
  const jobduck: JobduckServer = createServer({ home: box.home })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'jobduck-test', version: '0.0.0' })
  await Promise.all([jobduck.server.connect(serverTransport), client.connect(clientTransport)])
  const permissions = join(box.home, 'permissions.toml')
  writeFileSync(permissions, readFileSync(permissions, 'utf8').replace('track = false', 'track = true'))
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as ToolResult
  const data = async (name: string, args: Record<string, unknown>) => {
    const result = await call(name, args)
    if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`)
    return JSON.parse(result.content[0]!.text) as Record<string, any>
  }
  try {
    const posting = { url: 'https://jobs.lever.co/acme/abc-123', title: 'Staff Engineer', company: 'Acme' }
    const missing = await call('record_application', { ...posting, status: 'pending' })
    expect(missing.isError).toBe(true)
    expect(missing.content[0]?.text).toContain(PENDING_REASON_REQUIRED)

    const { application } = await data('record_application', { ...posting, status: 'pending', pending_reason: REASON })
    expect(application).toMatchObject({ status: 'pending', pending_reason: REASON, applied_at: null })
    const { application: saved } = await data('record_application', {
      url: 'https://example.com/jobs/acme-saved', title: 'Platform Engineer', company: 'Acme',
    })
    expect(saved).toMatchObject({ status: 'saved', pending_reason: null, applied_at: null })
    const { application: submitted } = await data('record_application', {
      url: 'https://example.com/jobs/acme-applied', title: 'Data Engineer', company: 'Acme', status: 'applied',
    })
    expect(submitted.status).toBe('applied')
    const db = openDb(dbPath(box.home))
    try {
      expect(db.prepare('SELECT pending_reason FROM applications WHERE id = ?').get(application.id)).toEqual({ pending_reason: REASON })
      expect(count(db, "SELECT COUNT(*) AS n FROM applications WHERE status = 'pending'")).toBeGreaterThan(0)
      expect(listEvents(db, application.id).map((event) => [event.from_status, event.to_status]))
        .toEqual([[null, 'saved'], ['saved', 'pending']])
      expect(listEvents(db, saved.id).map((event) => [event.from_status, event.to_status])).toEqual([[null, 'saved']])
      expect(listEvents(db, submitted.id).map((event) => [event.from_status, event.to_status]))
        .toEqual([[null, 'saved'], ['saved', 'applied']])
    } finally {
      db.close()
    }
    expect((await data('get_application', { id: application.id })).application.pending_reason).toBe(REASON)
    const listed = await data('list_applications', { status: 'pending' })
    expect(listed.applications.map((row: any) => [row.id, row.pending_reason])).toEqual([[application.id, REASON]])

    const refused = await call('update_status', { id: application.id, status: 'pending' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toContain(PENDING_REASON_REQUIRED)
    const applied = await data('update_status', { id: application.id, status: 'applied', note: 'Approval: yes' })
    expect(applied.application).toMatchObject({ status: 'applied', pending_reason: null })
    const reopened = await data('update_status', { id: application.id, status: 'pending', pending_reason: 'Upload the transcript.' })
    expect(reopened.application.pending_reason).toBe('Upload the transcript.')
    const interviewing = await data('record_interview', { application_id: application.id, stage_type: 'phone_screen' })
    expect(interviewing.application).toMatchObject({ status: 'interviewing', pending_reason: null })
  } finally {
    await client.close()
    await jobduck.close()
  }
})
