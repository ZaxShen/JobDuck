import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { type Sandbox, migratedDb, sandbox } from './helpers'
import { runSync } from '../src/commands/sync'
import { type ApplicationStatus, createApplication, getApplication, listEvents } from '../src/db/applications'
import type { Db } from '../src/db/client'
import { listOutcomes } from '../src/db/outcomes'
import { upsertPosting } from '../src/db/postings'
import { permissionsPath } from '../src/paths'
import { createSyncClient, type FetchLike, type SyncOutcome } from '../src/sync/client'

const SYNC_URL = 'https://script.example.com/macros/s/abc/exec'
const TOKEN = 'test-sync-token-0123456789'

interface Recorded {
  url: string
  init: RequestInit
  body: { token: string; action: string; messageIds?: string[] }
}

let box: Sandbox
let db: Db
let out: string[]
let err: string[]
let requests: Recorded[]

beforeEach(() => {
  box = sandbox()
  db = migratedDb(box.home)
  out = []
  err = []
  requests = []
  configure()
})
afterEach(() => {
  db.close()
  box.cleanup()
})

function configure(track = true, url = SYNC_URL, token = TOKEN) {
  writeFileSync(permissionsPath(box.home), `[modules]\ntrack = ${track}\n\n[track]\nsync_url = "${url}"\nsync_token = "${token}"\n`)
}

type Reply = Record<string, unknown> | ((body: Recorded['body']) => Response)

function server(outcomes: SyncOutcome[], pending?: Reply): FetchLike {
  return async (url, init) => {
    const body = JSON.parse(String(init.body)) as Recorded['body']
    requests.push({ url, init, body })
    if (body.action === 'pending') {
      if (typeof pending === 'function') return pending(body)
      return Response.json(pending ?? { ok: true, scriptVersion: '4', outcomes })
    }
    if (body.action === 'ack') return Response.json({ ok: true, acked: body.messageIds?.length ?? 0 })
    return Response.json({ ok: false, error: 'bad_request' })
  }
}

const run = (outcomes: SyncOutcome[], extra: { dryRun?: boolean; json?: boolean; pending?: Reply } = {}) =>
  runSync({
    home: box.home, dryRun: extra.dryRun, json: extra.json, fetch: server(outcomes, extra.pending),
    out: (line) => { out.push(line) }, err: (line) => { err.push(line) },
  })

let seq = 0
function application(company: string, title: string, options: { status?: ApplicationStatus; url?: string; sourceId?: string; appliedAt?: string } = {}) {
  const posting = upsertPosting(db, {
    source: 'manual', url: options.url ?? `https://jobs.example.com/${company.toLowerCase()}/${++seq}`,
    title, company, source_id: options.sourceId ?? null,
  })
  return createApplication(db, {
    postingId: posting.id, status: options.status ?? 'applied', appliedAt: options.appliedAt ?? '2026-09-01T00:00:00.000Z',
  })
}

const outcome = (messageId: string, fields: Partial<SyncOutcome> = {}): SyncOutcome => ({
  messageId, receivedAt: '2026-10-01T12:00:00.000Z', senderDomain: 'example.com', subject: 'Your application',
  company: null, title: null, jobUrl: null, jobRef: null, applicationId: null, jobId: null,
  queuedAt: '2026-10-01T12:05:00.000Z', ...fields,
})

const acks = () => requests.filter((request) => request.body.action === 'ack')
const stored = (messageId: string) => listOutcomes(db).find((row) => row.message_id === messageId)!

test('marker match closes the application as deny_by_employer with a sync event', async () => {
  const app = application('Acme', 'AI Engineer')
  application('Acme', 'AI Engineer')
  expect(await run([outcome('m1', { applicationId: app.id, company: 'Acme' })])).toBe(0)
  expect(getApplication(db, app.id)?.status).toBe('deny_by_employer')
  const event = listEvents(db, app.id).at(-1)!
  expect(event).toMatchObject({ to_status: 'deny_by_employer', source: 'sync' })
  expect(stored('m1')).toMatchObject({ status: 'matched', matched_by: 'marker', application_id: app.id })
  expect(stored('m1').synced_at).not.toBeNull()
})

test('url match', async () => {
  const app = application('Acme', 'AI Engineer', { url: 'https://boards.greenhouse.io/acme/jobs/42' })
  application('Acme', 'Data Scientist')
  expect(await run([outcome('m1', { jobUrl: 'https://job-boards.greenhouse.io/acme/jobs/42', company: 'Acme' })])).toBe(0)
  expect(stored('m1')).toMatchObject({ status: 'matched', matched_by: 'url', application_id: app.id })
  expect(getApplication(db, app.id)?.status).toBe('deny_by_employer')
})

test('ref match', async () => {
  const app = application('Globex', 'AI Engineer', { sourceId: 'JR-77' })
  application('Globex', 'AI Engineer')
  expect(await run([outcome('m1', { jobRef: 'JR-77', company: 'Globex' })])).toBe(0)
  expect(stored('m1')).toMatchObject({ status: 'matched', matched_by: 'ref', application_id: app.id })
})

test('company match with one candidate, and a title tie-break between several', async () => {
  const only = application('Initech', 'Platform Engineer')
  const engineer = application('Acme', 'Senior AI Engineer')
  const scientist = application('Acme', 'Data Scientist')
  expect(await run([
    outcome('m1', { company: 'Initech, Inc.', title: 'Something else' }),
    outcome('m2', { company: 'ACME', title: 'AI Engineer' }),
  ])).toBe(0)
  expect(stored('m1')).toMatchObject({ status: 'matched', matched_by: 'company_title', application_id: only.id })
  expect(stored('m2')).toMatchObject({ status: 'matched', matched_by: 'company_title', application_id: engineer.id })
  expect(getApplication(db, scientist.id)?.status).toBe('applied')
})

test('ambiguous outcome is queued as needs_match with three candidates', async () => {
  const apps = [1, 2, 3, 4].map(() => application('Acme', 'AI Engineer'))
  expect(await run([outcome('m1', { company: 'Acme', title: 'AI Engineer' })])).toBe(0)
  const row = stored('m1')
  expect(row.status).toBe('needs_match')
  const candidates = JSON.parse(row.candidates ?? '[]') as { application_id: number }[]
  expect(candidates).toHaveLength(3)
  expect(candidates.map((c) => c.application_id)).toEqual(apps.slice(0, 3).map((app) => app.id))
  for (const app of apps) expect(getApplication(db, app.id)?.status).toBe('applied')
})

test('terminal applications are never reopened or re-closed', async () => {
  const accepted = application('Acme', 'AI Engineer', { status: 'accepted', url: 'https://jobs.example.com/acme/accepted' })
  const live = application('Acme', 'Data Scientist')
  const closed = application('Globex', 'AI Engineer', { status: 'deny_by_candidate' })
  expect(await run([
    outcome('m1', { applicationId: accepted.id, company: 'Acme', title: 'AI Engineer' }),
    outcome('m2', { jobUrl: 'https://jobs.example.com/acme/accepted' }),
    outcome('m3', { company: 'Globex', title: 'AI Engineer' }),
  ])).toBe(0)
  expect(getApplication(db, accepted.id)?.status).toBe('accepted')
  expect(getApplication(db, closed.id)?.status).toBe('deny_by_candidate')
  expect(getApplication(db, live.id)?.status).toBe('applied')
  expect(listEvents(db, accepted.id)).toHaveLength(1)
  expect(listEvents(db, closed.id)).toHaveLength(1)
  expect(stored('m1')).toMatchObject({ status: 'matched', matched_by: 'marker', application_id: accepted.id })
  expect(stored('m2').status).toBe('needs_match')
  expect(stored('m3').status).toBe('needs_match')
})

test('a duplicate message id is counted as known and still acked', async () => {
  application('Acme', 'AI Engineer')
  expect(await run([outcome('m1', { company: 'Acme' })], { json: true })).toBe(0)
  out = []
  requests = []
  expect(await run([outcome('m1', { company: 'Acme' })], { json: true })).toBe(0)
  const report = JSON.parse(out.join('\n'))
  expect(report.totals).toMatchObject({ fetched: 1, known: 1, needs_match: 0, matched: { total: 0 } })
  expect(acks().map((request) => request.body.messageIds)).toEqual([['m1']])
  expect(listOutcomes(db)).toHaveLength(1)
})

test('ack lists exactly the stored ids, in batches of 100, and the token stays out of URLs and output', async () => {
  const outcomes = Array.from({ length: 150 }, (_, i) => outcome(`m${i}`, { company: 'Nobody' }))
  expect(await run(outcomes)).toBe(0)
  const batches = acks().map((request) => request.body.messageIds!)
  expect(batches.map((ids) => ids.length)).toEqual([100, 50])
  expect(batches.flat()).toEqual(outcomes.map((o) => o.messageId))
  for (const request of requests) {
    expect(request.url).toBe(SYNC_URL)
    expect(request.url).not.toContain(TOKEN)
    expect(request.init.method).toBe('POST')
    expect(request.init.redirect).toBe('follow')
    expect(new Headers(request.init.headers).get('content-type')).toBe('text/plain;charset=utf-8')
    expect(request.body.token).toBe(TOKEN)
  }
  expect(listOutcomes(db).every((row) => row.synced_at !== null)).toBe(true)
  expect([...out, ...err].join('\n')).not.toContain(TOKEN)
})

test('--dry-run prints the plan, writes nothing and sends no ack', async () => {
  const app = application('Acme', 'AI Engineer')
  const before = listEvents(db, app.id).length
  expect(await run([outcome('m1', { applicationId: app.id }), outcome('m2', { company: 'Nobody' })], { dryRun: true })).toBe(0)
  expect(acks()).toHaveLength(0)
  expect(listOutcomes(db)).toHaveLength(0)
  expect(getApplication(db, app.id)?.status).toBe('applied')
  expect(listEvents(db, app.id)).toHaveLength(before)
  const text = out.join('\n')
  expect(text).toContain('Dry run: nothing stored or acknowledged.')
  expect(text).toContain(`would match #${app.id} (marker)`)
  expect(text).toContain('fetched 2 / matched 1 (marker 1, url 0, ref 0, company_title 0) / needs_match 1 / known 0')
})

test('unauthorized exits 1 without storing or leaking the token', async () => {
  const code = await run([outcome('m1')], { pending: { ok: false, error: 'unauthorized' } })
  expect(code).toBe(1)
  expect(err.join('\n')).toContain('sync_token rejected')
  expect([...out, ...err].join('\n')).not.toContain(TOKEN)
  expect(listOutcomes(db)).toHaveLength(0)
  expect(acks()).toHaveLength(0)
})

test('non-JSON and HTTP errors exit 1 with an excerpt', async () => {
  const html = () => new Response('<html>Sign in</html>', { status: 200 })
  expect(await run([], { pending: html })).toBe(1)
  expect(err.join('\n')).toContain('non-JSON: <html>Sign in</html>')
  err = []
  expect(await run([], { pending: () => new Response('x'.repeat(500), { status: 500 }) })).toBe(1)
  expect(err[0]).toBe(`sync pending failed: HTTP 500: ${'x'.repeat(200)}`)
})

test('missing config exits 2 before any request', async () => {
  configure(true, '')
  expect(await run([outcome('m1')])).toBe(2)
  configure(false)
  expect(await run([outcome('m1')])).toBe(2)
  configure(true, SYNC_URL, '')
  expect(await run([outcome('m1')])).toBe(2)
  expect(requests).toHaveLength(0)
  expect(err.every((line) => line.includes('setup'))).toBe(true)
})

test('--json prints rows and totals', async () => {
  const app = application('Acme', 'AI Engineer', { url: 'https://jobs.example.com/acme/x' })
  expect(await run([
    outcome('m1', { jobUrl: 'https://jobs.example.com/acme/x', company: 'Acme', title: 'AI Engineer' }),
    outcome('m2', { company: 'Nobody' }),
  ], { json: true })).toBe(0)
  const report = JSON.parse(out.join('\n'))
  expect(report).toEqual({
    dryRun: false,
    scriptVersion: '4',
    acked: 2,
    totals: {
      fetched: 2, matched: { total: 1, marker: 0, url: 1, ref: 0, company_title: 0 }, needs_match: 1, known: 0, failed: 0,
    },
    outcomes: [
      { messageId: 'm1', receivedAt: '2026-10-01T12:00:00.000Z', company: 'Acme', title: 'AI Engineer', result: 'matched', matchedBy: 'url', applicationId: app.id },
      { messageId: 'm2', receivedAt: '2026-10-01T12:00:00.000Z', company: 'Nobody', title: null, result: 'needs_match', candidates: [] },
    ],
  })
})

test('the client status call and unknown keys pass through', async () => {
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init.body))
    if (body.action === 'status') return Response.json({ ok: true, scriptVersion: '4', mode: 'serve', pending: 3 })
    return Response.json({ ok: true, scriptVersion: '4', outcomes: [{ ...outcome('m1'), extra: 'kept' }] })
  }
  const client = createSyncClient({ url: SYNC_URL, token: TOKEN, fetch })
  expect(await client.status()).toMatchObject({ mode: 'serve', pending: 3 })
  expect((await client.pending()).outcomes[0]).toMatchObject({ messageId: 'm1', extra: 'kept' })
})

const cli = join(import.meta.dir, '..', 'src', 'cli.ts')

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bun', [cli, ...args], {
      env: { ...process.env, JOBDUCK_HOME: box.home, HOME: box.userHome }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

test('the CLI syncs in a child process through a 302 redirect', async () => {
  const app = application('Acme', 'AI Engineer')
  db.close()
  const queue = new Map<string, string>()
  const posts: { url: string; body: Recorded['body'] }[] = []
  let next = 0
  const stub = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
      if (req.method === 'POST') {
        const body = JSON.parse(raw) as Recorded['body']
        posts.push({ url: req.url ?? '', body })
        const reply = body.action === 'pending'
          ? { ok: true, scriptVersion: '4', outcomes: [outcome('m1', { applicationId: app.id }), outcome('m2', { company: 'Nobody' })] }
          : { ok: true, acked: body.messageIds?.length ?? 0 }
        const key = String(++next)
        queue.set(key, JSON.stringify(reply))
        res.writeHead(302, { Location: `/echo?user_content_key=${key}` }).end()
        return
      }
      const key = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('user_content_key') ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(queue.get(key) ?? '{}')
    })
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/macros/s/abc/exec`
    configure(true, url)

    const dry = await runCli(['sync', '--dry-run', '--json'])
    expect(dry.code).toBe(0)
    expect(JSON.parse(dry.stdout).totals).toMatchObject({ fetched: 2, matched: { marker: 1 }, needs_match: 1 })
    expect(posts.map((post) => post.body.action)).toEqual(['pending'])

    const real = await runCli(['sync'])
    expect(real.code).toBe(0)
    expect(real.stdout).toContain('fetched 2 / matched 1 (marker 1, url 0, ref 0, company_title 0) / needs_match 1 / known 0')
    expect(posts.map((post) => post.body.action)).toEqual(['pending', 'pending', 'ack'])
    expect(posts.at(-1)!.body.messageIds).toEqual(['m1', 'm2'])
    for (const post of posts) expect(post.url).not.toContain(TOKEN)
    expect(real.stdout + real.stderr + dry.stdout + dry.stderr).not.toContain(TOKEN)
  } finally {
    stub.close()
    db = migratedDb(box.home)
  }
  expect(getApplication(db, app.id)?.status).toBe('deny_by_employer')
})

test('every quoted response body is cut to 200 chars', async () => {
  const long = 'y'.repeat(5000)
  const client = (reply: () => Response) => createSyncClient({ url: SYNC_URL, token: TOKEN, fetch: async () => reply() })
  const message = async (reply: () => Response, call: 'pending' | 'status' | 'ack' = 'pending') => {
    const c = client(reply)
    const promise = call === 'ack' ? c.ack(['m1']) : c[call]()
    return promise.then(() => '', (error: Error) => error.message)
  }
  const cut = 'y'.repeat(200)
  expect(await message(() => new Response(long, { status: 502 }))).toBe(`sync pending failed: HTTP 502: ${cut}`)
  expect(await message(() => new Response(long, { status: 200 }))).toBe(`sync pending failed: HTTP 200 returned non-JSON: ${cut}`)
  expect(await message(() => Response.json({ ok: false, error: long }), 'ack')).toBe(`sync ack failed: ${cut}`)
  const unexpected = await message(() => Response.json({ ok: true, note: long }), 'ack')
  expect(unexpected.startsWith('sync ack failed: unexpected response: {"ok":true,"note":"yyy')).toBe(true)
  expect(unexpected.length).toBe('sync ack failed: unexpected response: '.length + 200)

  application('Acme', 'AI Engineer')
  const ackFails = (body: Recorded['body']) => body.action === 'ack'
    ? Response.json({ ok: false, error: long })
    : Response.json({ ok: true, scriptVersion: '4', outcomes: [outcome('m1', { company: 'Acme', title: 'AI Engineer' })] })
  expect(await runSync({
    home: box.home, fetch: async (url, init) => ackFails(JSON.parse(String(init.body)) as Recorded['body']),
    out: (line) => { out.push(line) }, err: (line) => { err.push(line) },
  })).toBe(1)
  expect(err).toEqual([`sync ack failed: ${cut}`])
})
