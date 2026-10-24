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
  expect(currentVersion(db)).toBe(5)
  expect(migrate(db)).toEqual([])
  expect(currentVersion(db)).toBe(5)
  const rows = db.prepare('SELECT version FROM schema_migrations').all()
  expect(rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }])
  db.close()
})

test('migration files are numbered and ordered', () => {
  expect(loadMigrations().map((m) => m.version)).toEqual([1, 2, 3, 4, 5])
  const loaded = loadMigrations([
    { name: '010_ten.sql', sql: 'ten' }, { name: 'notes.txt', sql: 'x' }, { name: '002_two.sql', sql: 'two' },
  ])
  expect(loaded).toEqual([{ version: 2, name: '002_two.sql', sql: 'two' }, { version: 10, name: '010_ten.sql', sql: 'ten' }])
})

test('the schema creates the expected tables', () => {
  const db = migratedDb(box.home)
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map((row) => row.name)
  expect(tables).toEqual([
    'application_events', 'applications', 'outcomes', 'postings', 'profile_facts', 'schema_migrations', 'settings',
  ])
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
const FACT_COLUMNS = ['id', 'slug', 'company', 'role', 'project', 'category', 'action', 'outcome', 'metrics', 'skills',
  'tools', 'basis', 'confidence', 'rationale', 'status', 'sort_order', 'created_at', 'updated_at']
const POSTING_COLUMNS = ['seniority', 'education_level', 'min_experience_years', 'closed_at', 'summary', 'skills',
  'requirements', 'requires_clearance', 'pay_stated', 'field_sources', 'resolved_at']
const APPLICATION_COLUMNS = ['salary_min', 'salary_max', 'salary_offered', 'rsu', 'options', 'bonus', 'sign_on',
  'relocation_fee', 'currency', 'country_override', 'state_override', 'city_override']

test('a fresh database reaches version 5 with the stage, pay, pending, profile fact and posting field columns', () => {
  const db = migratedDb(box.home)
  expect(currentVersion(db)).toBe(5)
  expect(columns(db, 'applications')).toContain('pending_reason')
  for (const column of STAGE_COLUMNS) expect(columns(db, 'application_events')).toContain(column)
  for (const column of APPLICATION_COLUMNS) expect(columns(db, 'applications')).toContain(column)
  for (const column of POSTING_COLUMNS) expect(columns(db, 'postings')).toContain(column)
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[])
    .map((row) => row.name)
  expect(indexes).toContain('application_events_scheduled')
  expect(indexes).toContain('profile_facts_status')
  expect(columns(db, 'profile_facts')).toEqual(FACT_COLUMNS)
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

  expect(migrate(db, loadMigrations().filter((m) => m.version <= 2))).toEqual([2])
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

test('a version 2 database with rows migrates to version 3 and keeps its rows', () => {
  mkdirSync(box.home, { recursive: true })
  const db = openDb(dbPath(box.home))
  expect(migrate(db, loadMigrations().filter((m) => m.version <= 2))).toEqual([1, 2])
  const now = '2026-01-02T03:04:05.000Z'
  db.prepare(`INSERT INTO postings (id, source, url, url_key, title, company, created_at, updated_at)
    VALUES (1, 'manual', 'https://acme.com/jobs/1', 'acme.com/jobs/1', 'Engineer', 'Acme', ?, ?)`).run(now, now)
  db.prepare(`INSERT INTO applications (id, posting_id, status, salary_offered, currency, created_at, updated_at)
    VALUES (1, 1, 'offered', 150000, 'USD', ?, ?)`).run(now, now)
  db.prepare(`INSERT INTO application_events (id, application_id, to_status, source, stage_type, scheduled_at, outcome, created_at)
    VALUES (1, 1, 'interviewing', 'user', 'technical', '2026-01-05', 'advanced', ?)`).run(now)
  const tables = ['postings', 'applications', 'application_events', 'outcomes', 'settings']
  const before = Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]))

  expect(migrate(db, loadMigrations().filter((m) => m.version <= 3))).toEqual([3])
  expect(currentVersion(db)).toBe(3)
  for (const table of tables) expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(before[table]!)
  expect(db.prepare('SELECT COUNT(*) AS n FROM profile_facts').get()).toEqual({ n: 0 })
  db.close()
})

test('schema v3 check constraints reject bad profile fact values', () => {
  const db = migratedDb(box.home)
  const now = new Date().toISOString()
  const insert = (overrides: Record<string, unknown> = {}) => {
    const row = { slug: null, project: 'Pipeline Migration', category: 'action', action: 'Moved jobs.', basis: 'stated', ...overrides }
    const keys = Object.keys(row)
    db.prepare(`INSERT INTO profile_facts (${keys.join(', ')}, created_at, updated_at)
      VALUES (${keys.map(() => '?').join(', ')}, ?, ?)`).run(...Object.values(row), now, now)
  }
  expect(() => insert({ category: 'hobby' })).toThrow()
  expect(() => insert({ basis: 'guessed' })).toThrow()
  expect(() => insert({ confidence: 'certain' })).toThrow()
  expect(() => insert({ status: 'done' })).toThrow()
  expect(() => insert({ skills: 'sql' })).toThrow()
  expect(() => insert({ tools: '{"a":1}' })).toThrow()
  expect(() => insert({ project: null })).toThrow()
  insert({ slug: 'pm-001', skills: '["sql"]' })
  expect(() => insert({ slug: 'pm-001' })).toThrow()
  insert()
  insert()
  expect(db.prepare("SELECT status, sort_order FROM profile_facts WHERE slug = 'pm-001'").get())
    .toEqual({ status: 'proposed', sort_order: 0 })
  db.close()
})
