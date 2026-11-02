import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type Sandbox, closeWithoutWalFiles, migratedDb, sandbox } from './helpers'
import { openDb } from '../src/db/client'
import { upsertPosting } from '../src/db/postings'

let box: Sandbox
let path: string

beforeEach(() => {
  box = sandbox()
  const db = migratedDb(box.home)
  upsertPosting(db, { source: 'manual', url: 'https://jobs.example.com/acme/1', title: 'AI Engineer', company: 'Acme' })
  path = closeWithoutWalFiles(db, box.home)
})
afterEach(() => box.cleanup())

test('readonly open reads a WAL database with no -shm or -wal file', () => {
  expect(existsSync(`${path}-shm`)).toBe(false)
  expect(existsSync(`${path}-wal`)).toBe(false)
  const db = openDb(path, { readonly: true })
  try {
    expect(db.prepare('SELECT company FROM postings').all()).toEqual([{ company: 'Acme' }])
  } finally {
    db.close()
  }
})

test('readonly open refuses writes', () => {
  const db = openDb(path, { readonly: true })
  try {
    expect(() => db.prepare("UPDATE postings SET company = 'Other'").run()).toThrow()
    expect(() => upsertPosting(db, { source: 'manual', url: 'https://jobs.example.com/acme/2', title: 'Designer', company: 'Acme' })).toThrow()
  } finally {
    db.close()
  }
  const check = openDb(path, { readonly: true })
  try {
    expect(check.prepare('SELECT company FROM postings').all()).toEqual([{ company: 'Acme' }])
  } finally {
    check.close()
  }
})

test('readonly open of a missing path throws without creating it', () => {
  const missing = join(box.root, 'missing.db')
  expect(() => openDb(missing, { readonly: true })).toThrow()
  expect(existsSync(missing)).toBe(false)
})
