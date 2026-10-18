import { MIGRATIONS } from '../assets'
import { type Db, nowIso, one, transaction } from './client'

export interface Migration {
  version: number
  name: string
  sql: string
}

export function loadMigrations(files: { name: string; sql: string }[] = MIGRATIONS): Migration[] {
  return files
    .map(({ name, sql }) => ({ name, sql, match: /^(\d+)_.+\.sql$/.exec(name) }))
    .filter((entry): entry is { name: string; sql: string; match: RegExpExecArray } => entry.match !== null)
    .map(({ name, sql, match }) => ({ version: Number(match[1]), name, sql }))
    .sort((a, b) => a.version - b.version)
}

function hasMigrationsTable(db: Db): boolean {
  return one(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")) !== undefined
}

export function currentVersion(db: Db): number {
  if (!hasMigrationsTable(db)) return 0
  return one<{ v: number | null }>(db.prepare('SELECT MAX(version) AS v FROM schema_migrations'))?.v ?? 0
}

export function pendingMigrations(db: Db | null, migrations = loadMigrations()): Migration[] {
  const version = db ? currentVersion(db) : 0
  return migrations.filter((m) => m.version > version)
}

export function migrate(db: Db, migrations = loadMigrations()): number[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
  const applied: number[] = []
  for (const migration of pendingMigrations(db, migrations)) {
    transaction(db, () => {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, nowIso())
    })
    applied.push(migration.version)
  }
  return applied
}
