import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type Sandbox, migratedDb, sandbox } from './helpers'
import { currentVersion, loadMigrations, migrate } from '../src/db/migrate'

let box: Sandbox
beforeEach(() => { box = sandbox() })
afterEach(() => box.cleanup())

test('migrations apply once and are idempotent', () => {
  const db = migratedDb(box.home)
  expect(currentVersion(db)).toBe(1)
  expect(migrate(db)).toEqual([])
  expect(currentVersion(db)).toBe(1)
  const rows = db.prepare('SELECT version FROM schema_migrations').all()
  expect(rows).toEqual([{ version: 1 }])
  db.close()
})

test('migration files are numbered and ordered', () => {
  expect(loadMigrations().map((m) => m.version)).toEqual([1])
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
