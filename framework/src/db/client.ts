import { createRequire } from 'node:module'

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

export type Driver = (path: string, options: OpenOptions) => Db

const betterSqlite3: Driver = (path, options) => {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  return new Database(path, { readonly: options.readonly ?? false, fileMustExist: options.readonly ?? false })
}

let defaultDriver: Driver = betterSqlite3

export function setDriver(driver: Driver): void {
  defaultDriver = driver
}

export function openDb(path: string, options: OpenOptions = {}): Db {
  const db = defaultDriver(path, options)
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
