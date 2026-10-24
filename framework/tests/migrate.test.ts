import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { type Sandbox, migratedDb, sandbox } from './helpers'
import { openDb } from '../src/db/client'
import { currentVersion, loadMigrations, migrate } from '../src/db/migrate'
import { dbPath } from '../src/paths'

let box: Sandbox
beforeEach(() => { box = sandbox() })
afterEach(() => box.cleanup())

test('migrations apply once and are idempotent', () => {
  const db = migratedDb(box.home)
  expect(currentVersion(db)).toBe(2)
  expect(migrate(db)).toEqual([])
  expect(currentVersion(db)).toBe(2)
  const rows = db.prepare('SELECT version FROM schema_migrations').all()
  expect(rows).toEqual([{ version: 1 }, { version: 2 }])
  db.close()
})

test('migration files are numbered and ordered', () => {
  expect(loadMigrations().map((m) => m.version)).toEqual([1, 2])
  const loaded = loadMigrations([
    { name: '010_ten.sql', sql: 'ten' }, { name: 'notes.txt', sql: 'x' }, { name: '002_two.sql', sql: 'two' },
  ])
  expect(loaded).toEqual([{ version: 2, name: '002_two.sql', sql: 'two' }, { version: 10, name: '010_ten.sql', sql: 'ten' }])
})

test('schema v1 creates the expected tables', () => {
  const db = migratedDb(box.home)
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map((row) => row.name)
  expect(tables).toEqual(['application_events', 'applications', 'outcomes', 'postings', 'schema_migrations', 'settings'])
  expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
  db.close()
})

test('check constraints reject unknown vocabularies', () => {
  const db = migratedDb(box.home)
  const now = new Date().toISOString()
  expect(() => db.prepare(`INSERT INTO postings (source, url, url_key, title, company, created_at, updated_at)
    VALUES ('scraper', 'u', 'k', 't', 'c', ?, ?)`).run(now, now)).toThrow()
  expect(() => db.prepare(`INSERT INTO outcomes (message_id, kind, received_at, status, created_at)
    VALUES ('m', 'offer', ?, 'pending', ?)`).run(now, now)).toThrow()
  db.close()
})

const columns = (db: ReturnType<typeof migratedDb>, table: string) =>
  (db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).map((row) => row.name)

const STAGE_COLUMNS = ['stage_type', 'scheduled_at', 'outcome']
const APPLICATION_COLUMNS = ['salary_min', 'salary_max', 'salary_offered', 'rsu', 'options', 'bonus', 'sign_on',
  'relocation_fee', 'currency', 'country_override', 'state_override', 'city_override']

test('a fresh database reaches version 2 with the stage and pay columns', () => {
  const db = migratedDb(box.home)
  expect(currentVersion(db)).toBe(2)
  for (const column of STAGE_COLUMNS) expect(columns(db, 'application_events')).toContain(column)
  for (const column of APPLICATION_COLUMNS) expect(columns(db, 'applications')).toContain(column)
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[])
    .map((row) => row.name)
  expect(indexes).toContain('application_events_scheduled')
  db.close()
})

test('a version 1 database with rows migrates to version 2 and keeps its rows', () => {
  mkdirSync(box.home, { recursive: true })
  const db = openDb(dbPath(box.home))
  expect(migrate(db, loadMigrations().filter((m) => m.version === 1))).toEqual([1])
  const now = '2026-01-02T03:04:05.000Z'
  db.prepare(`INSERT INTO postings (id, source, url, url_key, title, company, created_at, updated_at)
    VALUES (1, 'manual', 'https://acme.com/jobs/1', 'acme.com/jobs/1', 'Engineer', 'Acme', ?, ?)`).run(now, now)
  db.prepare(`INSERT INTO applications (id, posting_id, status, applied_at, note, created_at, updated_at)
    VALUES (1, 1, 'interviewing', ?, 'phone screen', ?, ?)`).run(now, now, now)
  db.prepare(`INSERT INTO application_events (id, application_id, from_status, to_status, source, metadata, created_at)
    VALUES (1, 1, 'applied', 'interviewing', 'user', '{"stage":"phone_screen"}', ?)`).run(now)
  const before = {
    applications: db.prepare('SELECT * FROM applications').all(),
    events: db.prepare('SELECT * FROM application_events').all(),
  }

  expect(migrate(db)).toEqual([2])
  expect(currentVersion(db)).toBe(2)
  const applications = db.prepare('SELECT * FROM applications').all() as Record<string, unknown>[]
  const events = db.prepare('SELECT * FROM application_events').all() as Record<string, unknown>[]
  expect(applications).toEqual((before.applications as Record<string, unknown>[]).map((row) => ({
    ...row, ...Object.fromEntries(APPLICATION_COLUMNS.map((column) => [column, null])),
  })))
  expect(events).toEqual((before.events as Record<string, unknown>[]).map((row) => ({
    ...row, ...Object.fromEntries(STAGE_COLUMNS.map((column) => [column, null])),
  })))
  db.close()
})

test('schema v2 check constraints reject bad stage and pay values', () => {
  const db = migratedDb(box.home)
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO postings (id, source, url, url_key, title, company, created_at, updated_at)
    VALUES (1, 'manual', 'u', 'k', 't', 'c', ?, ?)`).run(now, now)
  db.prepare(`INSERT INTO applications (id, posting_id, status, created_at, updated_at)
    VALUES (1, 1, 'applied', ?, ?)`).run(now, now)
  const event = (column: string, value: string) => db.prepare(`INSERT INTO application_events
    (application_id, to_status, source, ${column}, created_at) VALUES (1, 'interviewing', 'user', ?, ?)`).run(value, now)
  expect(() => event('stage_type', 'lunch')).toThrow()
  expect(() => event('outcome', 'maybe')).toThrow()
  event('stage_type', 'technical')
  const update = (column: string, value: unknown) =>
    db.prepare(`UPDATE applications SET ${column} = ? WHERE id = 1`).run(value)
  expect(() => update('salary_min', -1)).toThrow()
  expect(() => update('currency', 'US')).toThrow()
  expect(() => update('country_override', 'us')).toThrow()
  expect(() => update('country_override', 'USA')).toThrow()
  update('country_override', 'US')
  update('currency', 'USD')
  db.close()
})
