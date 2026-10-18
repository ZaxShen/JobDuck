import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type Sandbox, migratedDb, sandbox } from './helpers'
import type { Db } from '../src/db/client'
import { createApplication, listEvents } from '../src/db/applications'
import { insertOutcome, listOutcomes } from '../src/db/outcomes'
import { upsertPosting } from '../src/db/postings'
import { type Dashboard, startDashboard } from '../src/dashboard/server'

let box: Sandbox
let db: Db
let dash: Dashboard
let ids: { acme: number; beta: number; gamma: number }

beforeEach(async () => {
  box = sandbox()
  db = migratedDb(box.home)
  const make = (n: number, company: string, title: string, location: string, status: 'applied' | 'saved' | 'interviewing') => {
    const posting = upsertPosting(db, { source: 'manual', url: `https://jobs.example.com/${n}`, title, company, location })
    return createApplication(db, { postingId: posting.id, status }).id
  }
  ids = {
    acme: make(1, 'Acme', 'AI Engineer', 'Remote', 'applied'),
    beta: make(2, 'Beta Labs', 'ML Engineer', 'New York', 'saved'),
    gamma: make(3, 'Gamma', 'Data Scientist', 'Remote', 'interviewing'),
  }
  dash = await startDashboard({ home: box.home, port: 0, open: false, out: () => undefined })
})

afterEach(async () => {
  await dash.close()
  db.close()
  box.cleanup()
})

const get = async (path: string) => {
  const res = await fetch(`${dash.url}${path}`)
  return { res, body: await res.json() as any }
}

const mutate = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${dash.url}${path}`, {
    method,
    headers: { 'X-JobDuck-Dashboard': '1', 'Content-Type': 'application/json', Origin: dash.url, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { res, body: await res.json() as any }
}

test('binds to loopback only', () => {
  expect(dash.host).toBe('127.0.0.1')
  expect(dash.url).toBe(`http://127.0.0.1:${dash.port}`)
  expect(dash.port).toBeGreaterThan(0)
})

test('GET / serves the page with security headers', async () => {
  const res = await fetch(`${dash.url}/`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')
  expect(res.headers.get('content-security-policy')).toBe("default-src 'self'")
  expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  expect(await res.text()).toContain('<script src="/app.js"')
  for (const asset of ['/app.js', '/style.css']) expect((await fetch(`${dash.url}${asset}`)).status).toBe(200)
  expect((await fetch(`${dash.url}/missing`)).status).toBe(404)
})

test('requests with a foreign Host header are refused', async () => {
  const res = await fetch(`${dash.url}/api/summary`, { headers: { Host: `evil.example:${dash.port}` } })
  expect(res.status).toBe(403)
})

test('summary and statuses describe the board', async () => {
  const { body: summary } = await get('/api/summary')
  expect(summary.counts).toMatchObject({ applied: 1, saved: 1, interviewing: 1, offered: 0 })
  expect(summary.needs_match).toBe(0)
  const { body: statuses } = await get('/api/statuses')
  expect(statuses.statuses).toContain('deny_by_employer')
  expect(statuses.terminal).toEqual(['accepted', 'deny_by_employer', 'deny_by_candidate', 'no_response'])
})

test('GET /api/applications filters by status and q', async () => {
  expect((await get('/api/applications')).body).toHaveLength(3)
  const applied = (await get('/api/applications?status=applied')).body
  expect(applied.map((row: any) => row.id)).toEqual([ids.acme])
  expect(applied[0]).toMatchObject({ company: 'Acme', title: 'AI Engineer', location: 'Remote' })
  const remote = (await get('/api/applications?q=REMOTE')).body
  expect(remote.map((row: any) => row.id).sort()).toEqual([ids.acme, ids.gamma].sort())
  expect((await get('/api/applications?q=beta')).body.map((row: any) => row.id)).toEqual([ids.beta])
  expect((await get('/api/applications?q=100%25')).body).toEqual([])
  expect((await get('/api/applications?status=withdrawn')).res.status).toBe(400)
  expect((await get('/api/applications?limit=1')).body).toHaveLength(1)
})

test('mutations without the dashboard header or from a foreign origin get 403', async () => {
  const bare = await fetch(`${dash.url}/api/applications/${ids.acme}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'offered' }),
  })
  expect(bare.status).toBe(403)
  expect((await bare.json() as any).error).toContain('X-JobDuck-Dashboard')
  const foreign = await mutate('PATCH', `/api/applications/${ids.acme}`, { status: 'offered' }, { Origin: 'https://evil.example' })
  expect(foreign.res.status).toBe(403)
  expect((await mutate('DELETE', `/api/applications/${ids.acme}`, undefined, { 'X-JobDuck-Dashboard': '0' })).res.status).toBe(403)
  expect(listEvents(db, ids.acme)).toHaveLength(1)
})

test('PATCH status writes a dashboard event and returns the joined row', async () => {
  const { res, body } = await mutate('PATCH', `/api/applications/${ids.acme}`, { status: 'interviewing', note: 'phone screen' })
  expect(res.status).toBe(200)
  expect(body).toMatchObject({ id: ids.acme, status: 'interviewing', company: 'Acme' })
  const last = listEvents(db, ids.acme).at(-1)!
  expect(last).toMatchObject({ from_status: 'applied', to_status: 'interviewing', source: 'dashboard', note: 'phone screen' })
  const detail = (await get(`/api/applications/${ids.acme}`)).body
  expect(detail.application.status).toBe('interviewing')
  expect(detail.events).toHaveLength(2)
})

test('note and override updates do not write events', async () => {
  const { body } = await mutate('PATCH', `/api/applications/${ids.beta}`, {
    note: 'Recruiter: Dana', title_override: 'Senior ML Engineer', company_override: 'Beta', location_override: '',
  })
  expect(body).toMatchObject({
    note: 'Recruiter: Dana', title: 'Senior ML Engineer', company: 'Beta', location: 'New York',
    posting_title: 'ML Engineer', location_override: null,
  })
  expect(listEvents(db, ids.beta)).toHaveLength(1)
  expect((await get('/api/applications?q=senior')).body.map((row: any) => row.id)).toEqual([ids.beta])
})

test('invalid bodies get 400 and unknown ids 404', async () => {
  expect((await mutate('PATCH', `/api/applications/${ids.acme}`, { status: 'withdrawn' })).res.status).toBe(400)
  expect((await mutate('PATCH', `/api/applications/${ids.acme}`, { surprise: true })).res.status).toBe(400)
  const broken = await fetch(`${dash.url}/api/applications/${ids.acme}`, {
    method: 'PATCH', headers: { 'X-JobDuck-Dashboard': '1' }, body: '{not json',
  })
  expect(broken.status).toBe(400)
  expect((await broken.json() as any).error).toBeString()
  const huge = await mutate('PATCH', `/api/applications/${ids.acme}`, { note: 'x'.repeat(70 * 1024) })
  expect(huge.res.status).toBe(413)
  expect((await mutate('PATCH', '/api/applications/999', { note: 'x' })).res.status).toBe(404)
  expect((await get('/api/applications/999')).res.status).toBe(404)
})

test('DELETE hides the row', async () => {
  const { res } = await mutate('DELETE', `/api/applications/${ids.gamma}`)
  expect(res.status).toBe(200)
  expect((await get('/api/applications')).body.map((row: any) => row.id)).not.toContain(ids.gamma)
  expect((await get(`/api/applications/${ids.gamma}`)).res.status).toBe(404)
  expect((await get('/api/summary')).body.counts.interviewing).toBe(0)
  expect((await mutate('DELETE', `/api/applications/${ids.gamma}`)).res.status).toBe(404)
})

test('outcomes queue: list, match and dismiss', async () => {
  const first = insertOutcome(db, {
    message_id: 'm1', kind: 'rejection', company: 'Acme', received_at: '2026-10-01T00:00:00.000Z', status: 'needs_match',
  })
  const second = insertOutcome(db, {
    message_id: 'm2', kind: 'rejection', company: 'Unknown', received_at: '2026-10-02T00:00:00.000Z', status: 'needs_match',
  })
  expect((await get('/api/summary')).body.needs_match).toBe(2)
  expect((await get('/api/outcomes?status=needs_match')).body).toHaveLength(2)

  const unsafe = await fetch(`${dash.url}/api/outcomes/${first.id}/match`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ application_id: ids.acme }),
  })
  expect(unsafe.status).toBe(403)

  expect((await mutate('POST', `/api/outcomes/${first.id}/match`, {})).res.status).toBe(400)
  const matched = await mutate('POST', `/api/outcomes/${first.id}/match`, { application_id: ids.acme })
  expect(matched.res.status).toBe(200)
  expect(matched.body.outcome).toMatchObject({ status: 'matched', matched_by: 'dashboard', application_id: ids.acme })
  expect(matched.body.application.status).toBe('deny_by_employer')
  expect(listEvents(db, ids.acme).at(-1)).toMatchObject({ to_status: 'deny_by_employer', source: 'dashboard' })

  expect((await mutate('POST', `/api/outcomes/${second.id}/dismiss`)).body.status).toBe('dismissed')
  expect((await get('/api/outcomes?status=needs_match')).body).toEqual([])
  expect(listOutcomes(db).map((o) => o.status).sort()).toEqual(['dismissed', 'matched'])
  expect((await mutate('POST', '/api/outcomes/999/dismiss')).res.status).toBe(404)
})

test('/api/outcomes returns candidates as an array', async () => {
  const candidates = [{ application_id: ids.acme, company: 'Acme', title: 'AI Engineer', score: 0.5 }]
  insertOutcome(db, {
    message_id: 'c1', kind: 'rejection', company: 'Acme', received_at: '2026-10-01T00:00:00.000Z',
    status: 'needs_match', candidates,
  })
  insertOutcome(db, { message_id: 'c2', kind: 'rejection', received_at: '2026-10-02T00:00:00.000Z', status: 'needs_match' })
  const body = (await get('/api/outcomes')).body as { message_id: string; candidates: unknown }[]
  expect(Object.fromEntries(body.map((row) => [row.message_id, row.candidates]))).toEqual({ c1: candidates, c2: [] })
})
