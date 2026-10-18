import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { type Sandbox, sandbox } from './helpers'
import { type Db, openDb } from '../src/db/client'
import { listEvents } from '../src/db/applications'
import { upsertPosting } from '../src/db/postings'
import type { FetchLike } from '../src/freehire/client'
import { createServer, type JobduckServer } from '../src/mcp/server'
import { ISO_DATE_MESSAGE, TEXT_CAP, TOOL_NAMES, TRACK_DISABLED } from '../src/mcp/tools'
import { dbPath } from '../src/paths'

const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'freehire-search.json'), 'utf8')) as {
  pages: { headers: Record<string, string>; body: unknown }[]
}

let box: Sandbox
let jobduck: JobduckServer
let client: Client
let requests: string[]

const fixtureFetch: FetchLike = async (input) => {
  requests.push(input)
  const offset = Number(new URL(input).searchParams.get('offset'))
  const page = fixture.pages[offset === 0 ? 0 : 1]!
  return new Response(JSON.stringify(page.body), { status: 200, headers: page.headers })
}

beforeEach(async () => {
  box = sandbox()
  requests = []
  jobduck = createServer({ home: box.home, fetch: fixtureFetch, sleep: async () => {} })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'jobduck-test', version: '0.0.0' })
  await Promise.all([jobduck.server.connect(serverTransport), client.connect(clientTransport)])
})

afterEach(async () => {
  await client.close()
  await jobduck.close()
  box.cleanup()
})

interface ToolResult { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: unknown }

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult
}

async function data<T = Record<string, any>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await call(name, args)
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`)
  expect(result.content).toHaveLength(1)
  const text = result.content[0]!.text
  expect(text).toBe(JSON.stringify(JSON.parse(text)))
  expect(result.structuredContent).toEqual(JSON.parse(text))
  return JSON.parse(text) as T
}

const enableTrack = () => {
  const path = join(box.home, 'permissions.toml')
  writeFileSync(path, readFileSync(path, 'utf8').replace('track = false', 'track = true'))
}

const inspect = (fn: (db: Db) => void) => {
  const db = openDb(dbPath(box.home))
  try { fn(db) } finally { db.close() }
}

const application = { url: 'https://jobs.lever.co/acme/abc-123/apply', title: 'Staff Engineer', company: 'Acme' }

test('tools/list returns the eight tools', async () => {
  const { tools } = await client.listTools()
  expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort())
})

test('get_profile and get_permissions read the home files', async () => {
  const profile = await data('get_profile')
  expect(profile).toHaveProperty('frontMatter')
  expect(profile).toHaveProperty('body')
  const all = await data('get_permissions')
  expect(all.modules.track).toBe(false)
  expect(await data('get_permissions', { module: 'track' })).toEqual({
    module: 'track', enabled: false, settings: { sync_url: '', sync_token: '' },
  })
  enableTrack()
  expect((await data('get_permissions', { module: 'track' })).enabled).toBe(true)
})

test('update_profile writes fields and sections, and refuses a stale revision or unknown key', async () => {
  const before = await data('get_profile')
  expect(before.revision).toMatch(/^[0-9a-f]{16}$/)
  const written = await data('update_profile', {
    front_matter: { name: '<your name>', work_modes: ['remote'] },
    sections: { Summary: 'Builds at Acme.' },
    revision: before.revision,
  })
  expect(written.frontMatter.name).toBe('<your name>')
  expect(written.frontMatter.work_modes).toEqual(['remote'])
  expect(written.body).toContain('# Summary\n\nBuilds at Acme.')
  expect(written.sections_written).toEqual(['Summary'])
  expect((await data('get_profile')).revision).toBe(written.revision)

  const stale = await call('update_profile', { front_matter: { name: 'x' }, revision: before.revision })
  expect(stale.isError).toBe(true)
  expect(stale.content[0]?.text).toContain('changed since')
  const unknown = await call('update_profile', { front_matter: { nickname: 'x' } })
  expect(unknown.isError).toBe(true)
  expect(unknown.content[0]?.text).toContain('nickname')
  expect((await data('get_profile')).frontMatter.name).toBe('<your name>')
})

test('record_application is refused while track is off and writes once enabled', async () => {
  const refused = await call('record_application', application)
  expect(refused.isError).toBe(true)
  expect(refused.content[0]?.text).toBe(TRACK_DISABLED)
  inspect((db) => expect(db.prepare('SELECT COUNT(*) AS n FROM postings').get()).toEqual({ n: 0 }))

  enableTrack()
  const recorded = await data('record_application', {
    ...application,
    note: 'via agent',
    extracted: { title_clean: 'Staff Engineer', pay_min: 200000, secret: 'drop me', locations: [{ city: 'SF', junk: 1 }] },
  })
  expect(recorded.application.status).toBe('applied')
  expect(recorded.posting.source).toBe('agent')
  expect(recorded.marker).toBe(`JobDuck-Application-Id: ${recorded.application.id}`)
  expect(JSON.parse(recorded.application.extracted)).toEqual({
    title_clean: 'Staff Engineer', pay_min: 200000, locations: [{ city: 'SF' }],
  })
  inspect((db) => {
    const events = listEvents(db, recorded.application.id)
    expect(events.map((event) => [event.from_status, event.to_status, event.source])).toEqual([[null, 'applied', 'agent']])
  })

  const duplicate = await data('record_application', { ...application, url: 'https://jobs.lever.co/acme/abc-123' })
  expect(duplicate).toEqual({ duplicate: true, application: recorded.application })

  const badExtracted = await call('record_application', { ...application, url: 'https://x.io/j/2', extracted: ['nope'] })
  expect(badExtracted.isError).toBe(true)
  expect(badExtracted.content[0]?.text).toBe('extracted must be an object')
})

test('update_status is gated on track and writes an event', async () => {
  enableTrack()
  const { application: created } = await data('record_application', application)
  const path = join(box.home, 'permissions.toml')
  writeFileSync(path, readFileSync(path, 'utf8').replace('track = true', 'track = false'))
  const refused = await call('update_status', { id: created.id, status: 'interviewing' })
  expect(refused.isError).toBe(true)
  expect(refused.content[0]?.text).toBe(TRACK_DISABLED)

  enableTrack()
  const { application: updated } = await data('update_status', { id: created.id, status: 'interviewing', note: 'phone screen' })
  expect(updated.status).toBe('interviewing')
  inspect((db) => {
    const events = listEvents(db, created.id)
    expect(events.at(-1)).toMatchObject({ from_status: 'applied', to_status: 'interviewing', note: 'phone screen', source: 'agent' })
  })

  const { application: offered } = await data('update_status', { id: created.id, status: 'offered', note: 'verbal offer' })
  expect(offered.note).toBe('phone screen\nverbal offer')
  const listed = (await data('list_applications')).applications.find((row: any) => row.id === created.id)
  expect(listed.note).toBe('phone screen\nverbal offer')

  const missing = await call('update_status', { id: 9999, status: 'offered' })
  expect(missing.isError).toBe(true)
  expect(missing.content[0]?.text).toBe('application 9999 not found')
})

test('search_jobs upserts postings and reports known and application_status', async () => {
  const first = await data('search_jobs', { q: 'engineer' })
  expect(requests).toHaveLength(2)
  expect(new URL(requests[0]!).searchParams.get('countries')).toBe('US')
  expect(new URL(requests[0]!).searchParams.get('posted_within_days')).toBe('7')
  expect(new URL(requests[0]!).searchParams.get('sort')).toBe('posted_at')
  expect(first.total).toBe(3)
  expect(first.returned).toBe(3)
  expect(first.jobs.every((job: any) => job.known === false && job.application_id === null)).toBe(true)
  expect(first.jobs[0]).toMatchObject({
    title: 'Staff Engineer', company: 'Acme', url: 'https://job-boards.greenhouse.io/acme/jobs/1001',
    source_ats: 'greenhouse', seniority: 'staff', employment_type: 'full_time',
    skills: ['typescript', 'postgres'], reality_class: 'fresh', application_status: null,
    location: 'San Francisco, US', work_mode: 'hybrid', pay_min: 200000, pay_max: 250000, currency: 'USD',
  })
  expect(first.jobs[1]).toMatchObject({ location: 'US', work_mode: null, pay_min: null, pay_max: null, currency: null })
  expect(JSON.stringify(first)).not.toContain('Build things')

  enableTrack()
  const { application: applied } = await data('record_application', {
    url: 'https://job-boards.greenhouse.io/acme/jobs/1001', title: 'Staff Engineer', company: 'Acme',
  })
  const second = await data('search_jobs', { q: 'engineer' })
  expect(second.jobs.every((job: any) => job.known === true)).toBe(true)
  expect(second.jobs[0]).toMatchObject({ application_id: applied.id, application_status: 'applied' })
  expect(second.jobs[1]).toMatchObject({ application_id: null, application_status: null })
  inspect((db) => {
    expect(db.prepare('SELECT COUNT(*) AS n FROM postings').get()).toEqual({ n: 3 })
    expect(db.prepare("SELECT source, source_id, country, job_type FROM postings WHERE source_id = 'initech:3003'").get())
      .toEqual({ source: 'freehire', source_id: 'initech:3003', country: 'CA', job_type: 'full_time' })
  })

  const tooMany = await call('search_jobs', { max_results: 501 })
  expect(tooMany.isError).toBe(true)
})

test('find_application by url and by company/title', async () => {
  expect(await data('find_application', { url: application.url })).toEqual({ found: false })
  enableTrack()
  const { application: created } = await data('record_application', application)
  const byUrl = await data('find_application', { url: 'https://jobs.lever.co/acme/abc-123' })
  expect(byUrl.found).toBe(true)
  expect(byUrl.application.id).toBe(created.id)
  expect(byUrl.posting.company).toBe('Acme')
  const byName = await data('find_application', { company: 'ACME', title: 'staff engineer' })
  expect(byName.application.id).toBe(created.id)
  expect((await data('find_application', { company: 'Acme', title: 'Designer' })).found).toBe(false)
  expect((await call('find_application', {})).isError).toBe(true)
})

test('find_application returns a compact posting by default and plain text with with_text', async () => {
  await data('search_jobs', { q: 'engineer' })
  const url = 'https://job-boards.greenhouse.io/acme/jobs/1001'
  const compact = await data('find_application', { url })
  expect(compact.found).toBe(false)
  expect(compact.posting).not.toHaveProperty('description')
  expect(compact.posting).not.toHaveProperty('raw')
  expect(compact.posting).not.toHaveProperty('text')
  expect(compact.posting).toMatchObject({ work_mode: 'hybrid', pay_min: 200000, pay_max: 250000, currency: 'USD', job_type: 'full_time' })

  const full = await data('find_application', { url, with_text: true })
  expect(full.posting).toMatchObject({
    text: 'Build things.', truncated: false, work_mode: 'hybrid', pay_min: 200000, pay_max: 250000, currency: 'USD',
    job_type: 'full_time',
  })
  expect(full.posting).not.toHaveProperty('description')
  expect(full.posting).not.toHaveProperty('raw')

  enableTrack()
  const { application: created } = await data('record_application', { url, title: 'Staff Engineer', company: 'Acme' })
  const byName = await data('find_application', { company: 'Acme', title: 'Staff Engineer', with_text: true })
  expect(byName.application.id).toBe(created.id)
  expect(byName.posting.text).toBe('Build things.')
  expect((await data('find_application', { company: 'Acme' })).posting).not.toHaveProperty('description')
})

test('find_application with_text strips HTML, decodes entities and caps the text', async () => {
  const html = '<div>\n  <p>Fish &amp; chips&nbsp;&#8212;&#x2019;s</p><script>alert(1)</script><ul><li>A</li><li>B</li></ul></div>'
  const long = `<p>${'word '.repeat(4000)}</p>`
  inspect((db) => {
    upsertPosting(db, { source: 'manual', url: 'https://example.com/jobs/html', title: 'T', company: 'C', description: html })
    upsertPosting(db, { source: 'manual', url: 'https://example.com/jobs/long', title: 'T', company: 'C', description: long })
  })
  const short = await data('find_application', { url: 'https://example.com/jobs/html', with_text: true })
  expect(short.posting).toMatchObject({ text: 'Fish & chips \u2014\u2019s A B', truncated: false })
  const capped = await data('find_application', { url: 'https://example.com/jobs/long', with_text: true })
  expect(capped.posting.text).toHaveLength(TEXT_CAP)
  expect(capped.posting.truncated).toBe(true)
})

test('list_applications joins postings and filters', async () => {
  enableTrack()
  const { application: a } = await data('record_application', application)
  const { application: b } = await data('record_application', {
    url: 'https://jobs.ashbyhq.com/initech/3003', title: 'ML Engineer', company: 'Initech', location: 'Toronto', status: 'saved',
  })
  inspect((db) => db.prepare("UPDATE applications SET company_override = 'Acme Corp' WHERE id = ?").run(a.id))

  const { applications } = await data('list_applications')
  expect(applications.map((row: any) => row.id).sort()).toEqual([a.id, b.id].sort())
  const acme = applications.find((row: any) => row.id === a.id)
  expect(acme).toEqual({
    id: a.id, status: 'applied', title: 'Staff Engineer', company: 'Acme Corp', location: null,
    url: application.url, applied_at: a.applied_at, closed_at: null, updated_at: a.updated_at, note: null,
  })
  const saved = await data('list_applications', { status: 'saved' })
  expect(saved.applications.map((row: any) => row.id)).toEqual([b.id])
  expect((await data('list_applications', { limit: 1 })).applications).toHaveLength(1)
  expect((await data('list_applications', { since: '2999-01-01T00:00:00Z' })).applications).toEqual([])
  expect((await data('list_applications', { since: '2000-01-01' })).applications).toHaveLength(2)
  for (const since of ['yesterday', '2026/10/01', '10-01-2026']) {
    const bad = await call('list_applications', { since })
    expect(bad.isError).toBe(true)
    expect(bad.content[0]?.text).toContain(ISO_DATE_MESSAGE)
  }
})
