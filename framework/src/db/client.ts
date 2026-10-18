import { Database, type SQLQueryBindings } from 'bun:sqlite'

export interface RunResult {
  changes: number | bigint
  lastInsertRowid: number | bigint
}

export interface Statement {
  run(...params: unknown[]): RunResult
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface Db {
  prepare(sql: string): Statement
  exec(sql: string): unknown
  close(): unknown
}

export interface OpenOptions {
  readonly?: boolean
}

function bunSqlite(path: string, options: OpenOptions): Db {
  const db = options.readonly ? new Database(path, { readonly: true }) : new Database(path, { create: true })
  const bind = (params: unknown[]) => params as SQLQueryBindings[]
  return {
    prepare: (sql) => {
      const stmt = db.prepare(sql)
      return {
        run: (...params) => stmt.run(...bind(params)),
        get: (...params) => stmt.get(...bind(params)),
        all: (...params) => stmt.all(...bind(params)),
      }
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  }
}

export function openDb(path: string, options: OpenOptions = {}): Db {
  const db = bunSqlite(path, options)
  if (!options.readonly) db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function one<T>(stmt: Statement, ...params: unknown[]): T | undefined {
  return (stmt.get(...params) ?? undefined) as T | undefined
}

export const nowIso = () => new Date().toISOString()
