import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type Sandbox, migratedDb, sandbox } from './helpers'
import { createApplication, getApplication, listEvents, setStatus } from '../src/db/applications'
import { BUSY_TIMEOUT_MS, type Db, openDb } from '../src/db/client'
import { upsertPosting } from '../src/db/postings'
import { dbPath } from '../src/paths'

const HOLD_MS = 500

let box: Sandbox
let db: Db
let id: number

beforeEach(() => {
  box = sandbox()
  db = migratedDb(box.home)
  const posting = upsertPosting(db, { source: 'manual', url: 'https://jobs.example.com/1', title: 'AI Engineer', company: 'Acme' })
  id = createApplication(db, { postingId: posting.id, status: 'applied' }).id
})

afterEach(() => {
  db.close()
  box.cleanup()
})

const holder = `
  import { Database } from 'bun:sqlite'
  const [path, id, hold] = process.argv.slice(-3)
  const db = new Database(path)
  db.exec('BEGIN IMMEDIATE')
  db.prepare("UPDATE applications SET note = 'held by another process' WHERE id = ?").run(Number(id))
  console.log('locked')
  Bun.sleepSync(Number(hold))
  db.exec('COMMIT')
  db.close()
`

async function waitForLine(stream: ReadableStream<Uint8Array>, line: string): Promise<void> {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of stream) {
    text += decoder.decode(chunk)
    if (text.split('\n').includes(line)) return
  }
  throw new Error(`child exited before printing ${line}: ${text}`)
}

test('a write waits for another process holding the write lock instead of failing with SQLITE_BUSY', async () => {
  const child = Bun.spawn([process.execPath, '-e', holder, dbPath(box.home), String(id), String(HOLD_MS)], {
    stdout: 'pipe', stderr: 'inherit',
  })
  await waitForLine(child.stdout, 'locked')
  const started = performance.now()
  const updated = setStatus(db, id, 'interviewing', { source: 'dashboard' })
  const waited = performance.now() - started
  expect(await child.exited).toBe(0)

  expect(waited).toBeGreaterThan(HOLD_MS / 4)
  expect(waited).toBeLessThan(BUSY_TIMEOUT_MS)
  expect(updated.status).toBe('interviewing')
  expect(getApplication(db, id)).toMatchObject({ status: 'interviewing', note: 'held by another process' })
  expect(listEvents(db, id).map((event) => event.to_status)).toEqual(['saved', 'applied', 'interviewing'])
})

test('every connection sets busy_timeout, readonly ones included', () => {
  const timeout = (conn: Db) => Object.values(conn.prepare('PRAGMA busy_timeout').get() as Record<string, number>)[0]
  expect(BUSY_TIMEOUT_MS).toBe(5000)
  expect(timeout(db)).toBe(5000)
  const readonly = openDb(dbPath(box.home), { readonly: true })
  try {
    expect(timeout(readonly)).toBe(5000)
  } finally {
    readonly.close()
  }
})
