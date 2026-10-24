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

export const FOREIGN_KEYS_OFF = '-- jobduck:foreign_keys=off'

export const runsWithForeignKeysOff = (migration: Migration) => migration.sql.split('\n', 1)[0]?.trim() === FOREIGN_KEYS_OFF

function apply(db: Db, migration: Migration): void {
  db.exec(migration.sql)
  db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, nowIso())
}

function applyWithForeignKeysOff(db: Db, migration: Migration): void {
  if (db.inTransaction) {
    throw new Error(`migration ${migration.name} needs foreign keys off, which SQLite ignores inside a transaction; `
      + 'run migrate() outside one')
  }
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    transaction(db, () => {
      apply(db, migration)
      const violations = db.prepare('PRAGMA foreign_key_check').all()
      if (violations.length > 0) {
        throw new Error(`migration ${migration.name} broke ${violations.length} foreign key(s): ${JSON.stringify(violations)}`)
      }
    })
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}

export function migrate(db: Db, migrations = loadMigrations()): number[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
  const applied: number[] = []
  for (const migration of pendingMigrations(db, migrations)) {
    if (runsWithForeignKeysOff(migration)) applyWithForeignKeysOff(db, migration)
    else transaction(db, () => apply(db, migration))
    applied.push(migration.version)
  }
  return applied
}
