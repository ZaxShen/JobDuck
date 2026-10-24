import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type Sandbox, migratedDb, sandbox } from './helpers'
import { INBOX_EXTENSIONS, INBOX_MAX_FILE_BYTES, handleApi } from '../src/dashboard/api'
import { INBOX_TYPES, MAX_UPLOAD_BYTES } from '../web/src/lib/inbox'
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
  const html = await res.text()
  expect(html).toMatch(/<script type="module"[^>]* src="\/app\.js"/)
  expect(html).toMatch(/<link rel="stylesheet"[^>]* href="\/style\.css"/)
  expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>|<style|https?:\/\//)
  for (const asset of ['/app.js', '/style.css']) expect((await fetch(`${dash.url}${asset}`)).status).toBe(200)
  const css = await (await fetch(`${dash.url}/style.css`)).text()
  const fonts = [...css.matchAll(/url\((\/[^)]+\.woff2)\)/g)].map((match) => match[1]!)
  expect(fonts.length).toBeGreaterThan(0)
  for (const font of fonts) {
    const fontRes = await fetch(`${dash.url}${font}`)
    expect(fontRes.status).toBe(200)
    expect(fontRes.headers.get('content-type')).toBe('font/woff2')
    expect(new TextDecoder().decode((await fontRes.arrayBuffer()).slice(0, 4))).toBe('wOF2')
  }
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
  const huge = await mutate('PATCH', `/api/applications/${ids.acme}`, { note: 'x'.repeat(1100 * 1024) })
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

test('profile: GET shows template sections empty, PUT saves and a stale revision gets 409', async () => {
  const first = await get('/api/profile')
  expect(first.res.status).toBe(200)
  expect(first.body.front_matter.name).toBe('')
  const summary = first.body.sections.find((s: any) => s.title === 'Summary')
  expect(summary).toMatchObject({ content: '', standard: true })
  expect(summary.hint).toContain('Two or three sentences')

  const saved = await mutate('PUT', '/api/profile', {
    front_matter: { name: '<your name>' }, sections: { Summary: 'Builds at Acme.' }, revision: first.body.revision,
  })
  expect(saved.res.status).toBe(200)
  expect(saved.body.front_matter.name).toBe('<your name>')
  expect(saved.body.sections.find((s: any) => s.title === 'Summary').content).toBe('Builds at Acme.')
  expect(saved.body.revision).not.toBe(first.body.revision)

  const stale = await mutate('PUT', '/api/profile', { front_matter: { name: 'x' }, revision: first.body.revision })
  expect(stale.res.status).toBe(409)
  const bad = await mutate('PUT', '/api/profile', { front_matter: { nickname: 'x' } })
  expect(bad.res.status).toBe(400)
  expect(bad.body.error).toContain('nickname')
  expect((await get('/api/profile')).body.front_matter.name).toBe('<your name>')
})

test('permissions: PUT saves, rejects unknown keys and stale revisions, and needs the dashboard header', async () => {
  const first = await get('/api/permissions')
  expect(first.body.permissions.modules.track).toBe(false)
  const next = structuredClone(first.body.permissions)
  next.modules.track = true

  const bare = await fetch(`${dash.url}/api/permissions`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissions: next }),
  })
  expect(bare.status).toBe(403)

  const saved = await mutate('PUT', '/api/permissions', { permissions: next, revision: first.body.revision })
  expect(saved.res.status).toBe(200)
  expect(saved.body.permissions.modules.track).toBe(true)
  expect((await mutate('PUT', '/api/permissions', { permissions: next, revision: first.body.revision })).res.status).toBe(409)
  const unknown = await mutate('PUT', '/api/permissions', { permissions: { ...next, modules: { ...next.modules, fly: true } } })
  expect(unknown.res.status).toBe(400)
  expect((await get('/api/permissions')).body.permissions.modules.track).toBe(true)
})

test('wizard payloads save Career DNA, targets and modules through PUT /api/profile and /api/permissions', () => {
  const ctx = { db, home: box.home }
  const call = (method: string, path: string, body?: unknown) =>
    handleApi(ctx, { method, path, query: new URLSearchParams(), body }) as { status: number; body: any }

  const dna = '- Builder or Optimizer: 20/100, leans 0 → 1 Builder (0 = 0 → 1 Builder, 100 = 1 → 100 Optimizer)\n- Team size: Small teams'
  const first = call('GET', '/api/profile')
  const quiz = call('PUT', '/api/profile', {
    front_matter: { work_modes: ['remote'], company_stages: ['startup'] },
    sections: { 'Career DNA': dna },
    revision: first.body.revision,
  })
  expect(quiz.status).toBe(200)
  const targets = call('PUT', '/api/profile', {
    front_matter: { target_titles: ['Software Engineer'], locations: ['Remote'], seniority: ['senior'], pay_floor: 120000 },
    sections: {},
    revision: quiz.body.revision,
  })
  expect(targets.status).toBe(200)

  const profile = call('GET', '/api/profile').body
  expect(profile.front_matter).toMatchObject({
    work_modes: ['remote'], company_stages: ['startup'], target_titles: ['Software Engineer'],
    locations: ['Remote'], seniority: ['senior'], pay_floor: 120000,
  })
  expect(profile.sections.find((section: any) => section.title === 'Career DNA').content).toBe(dna)

  const current = call('GET', '/api/permissions').body
  const permissions = structuredClone(current.permissions)
  permissions.modules = { ...permissions.modules, apply: true, find: true, track: true }
  expect(call('PUT', '/api/permissions', { permissions, revision: current.revision }).status).toBe(200)
  expect(call('GET', '/api/permissions').body.permissions.modules).toMatchObject({ apply: true, find: true, track: true, cv: false })
})

const upload = (name: string, bytes: Buffer, origin = dash) => fetch(`${origin.url}/api/inbox`, {
  method: 'POST',
  headers: { 'X-JobDuck-Dashboard': '1', 'Content-Type': 'application/json', Origin: origin.url },
  body: JSON.stringify({ name, data: bytes.toString('base64') }),
})

test('a file at the wizard upload limit fits the inbox body limit after base64 and JSON encoding', async () => {
  expect(MAX_UPLOAD_BYTES).toBe(INBOX_MAX_FILE_BYTES)
  expect(INBOX_TYPES).toEqual(INBOX_EXTENSIONS)
  const inbox = join(box.workspace, 'inbox')
  mkdirSync(inbox)
  const withInbox = await startDashboard({ home: box.home, workspace: box.workspace, port: 0, open: false, out: () => undefined })
  try {
    const name = `${'a'.repeat(251)}.pdf`
    const res = await upload(name, Buffer.alloc(MAX_UPLOAD_BYTES, 0x61), withInbox)
    expect(res.status).toBe(200)
    expect(statSync(join(inbox, name)).size).toBe(MAX_UPLOAD_BYTES)
  } finally {
    await withInbox.close()
  }
})

test('POST /api/inbox is refused with 409 when the workspace has no inbox/', async () => {
  const res = await upload('resume.pdf', Buffer.from('%PDF-1.4'))
  expect(res.status).toBe(409)
  expect((await res.json() as any).error).toContain('inbox/')
})

test('POST /api/inbox writes the decoded file with mode 0600 and never overwrites', async () => {
  const inbox = join(box.workspace, 'inbox')
  mkdirSync(inbox)
  const withInbox = await startDashboard({ home: box.home, workspace: box.workspace, port: 0, open: false, out: () => undefined })
  try {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10])
    const first = await upload('Resume.PDF', bytes, withInbox)
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ path: join(inbox, 'Resume.PDF'), name: 'Resume.PDF' })
    expect(readFileSync(join(inbox, 'Resume.PDF'))).toEqual(bytes)
    expect(statSync(join(inbox, 'Resume.PDF')).mode & 0o777).toBe(0o600)

    const second = await upload('Resume.PDF', Buffer.from('again'), withInbox)
    expect((await second.json() as any).name).toBe('Resume-1.PDF')
    expect(readFileSync(join(inbox, 'Resume.PDF'))).toEqual(bytes)
    expect(readFileSync(join(inbox, 'Resume-1.PDF'), 'utf8')).toBe('again')
    expect(statSync(join(inbox, 'Resume-1.PDF')).mode & 0o777).toBe(0o600)

    const escaped = await upload('../../linkedin.zip', Buffer.from('PK'), withInbox)
    expect((await escaped.json() as any).path).toBe(join(inbox, 'linkedin.zip'))

    const large = await upload('export.csv', Buffer.alloc(2 * 1024 * 1024, 0x61), withInbox)
    expect(large.status).toBe(200)
    expect((await upload('huge.pdf', Buffer.alloc(16 * 1024 * 1024), withInbox)).status).toBe(413)

    for (const name of ['resume.exe', 'notes', '../../.bashrc', '..\\.profile', '.hidden.pdf', '', `${'é'.repeat(126)}.pdf`]) {
      const refused = await upload(name, Buffer.from('x'), withInbox)
      expect(refused.status).toBe(400)
    }
    const unsafe = await fetch(`${withInbox.url}/api/inbox`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'a.pdf', data: 'eA==' }),
    })
    expect(unsafe.status).toBe(403)
    expect(readdirSync(inbox).sort()).toEqual(['Resume-1.PDF', 'Resume.PDF', 'export.csv', 'linkedin.zip'])
    expect(existsSync(join(box.root, 'linkedin.zip'))).toBe(false)
  } finally {
    await withInbox.close()
  }
})
