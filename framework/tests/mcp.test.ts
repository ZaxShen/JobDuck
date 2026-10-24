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
import { CV_DISABLED, ISO_DATE_MESSAGE, MAX_FACTS_PER_SAVE, TEXT_CAP, TOOL_NAMES, TRACK_DISABLED } from '../src/mcp/tools'
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

const enableCv = () => {
  const path = join(box.home, 'permissions.toml')
  writeFileSync(path, readFileSync(path, 'utf8').replace('cv = false', 'cv = true'))
}

const inspect = (fn: (db: Db) => void) => {
  const db = openDb(dbPath(box.home))
  try { fn(db) } finally { db.close() }
}

const application = { url: 'https://jobs.lever.co/acme/abc-123/apply', title: 'Staff Engineer', company: 'Acme' }

test('tools/list returns every tool', async () => {
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

test('interview and application writers are gated on track', async () => {
  const writers: [string, Record<string, unknown>][] = [
    ['record_interview', { application_id: 1, stage_type: 'technical' }],
    ['update_interview', { event_id: 1, outcome: 'advanced' }],
    ['delete_interview', { event_id: 1 }],
    ['update_application', { id: 1, salary_offered: 1000 }],
  ]
  for (const [name, args] of writers) {
    const refused = await call(name, args)
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toBe(TRACK_DISABLED)
  }
  const { tools } = await client.listTools()
  expect(tools.find((tool) => tool.name === 'delete_interview')?.annotations?.destructiveHint).toBe(true)
  expect(tools.find((tool) => tool.name === 'get_application')?.annotations?.readOnlyHint).toBe(true)
})

test('record_interview, update_interview and delete_interview manage stages; get_application reads them', async () => {
  enableTrack()
  const { application: created } = await data('record_application', application)
  const recorded = await data('record_interview', {
    application_id: created.id, stage_type: 'phone_screen', scheduled_at: '2000-11-03',
    contacts: [{ name: 'Alex Doe', title: 'Recruiter' }],
  })
  expect(recorded.application.status).toBe('interviewing')
  expect(recorded.stage).toMatchObject({
    to_status: 'interviewing', stage_type: 'phone_screen', scheduled_at: '2000-11-03', outcome: 'pending', source: 'agent',
    contacts: [{ name: 'Alex Doe', title: 'Recruiter' }],
  })

  const { stage: updated } = await data('update_interview', { event_id: recorded.stage.id, outcome: 'advanced' })
  expect(updated.outcome).toBe('advanced')

  const offer = await data('record_interview', { application_id: created.id, kind: 'offered', stage_type: 'written' })
  expect(offer.application.status).toBe('offered')
  expect(offer.stage.outcome).toBeNull()

  const { application: paid } = await data('update_application', {
    id: created.id, salary_offered: 200000, bonus: 20000, currency: 'USD', country_override: 'US', city_override: 'Austin',
  })
  expect(paid).toMatchObject({ salary_offered: 200000, bonus: 20000, currency: 'USD', country_override: 'US', city_override: 'Austin' })

  const read = await data('get_application', { id: created.id })
  expect(read.application).toMatchObject({
    id: created.id, title: 'Staff Engineer', company: 'Acme', url: application.url, salary_offered: 200000, currency: 'USD',
  })
  expect(read.stages.map((stage: any) => [stage.stage_type, stage.outcome])).toEqual([['phone_screen', 'advanced'], ['written', null]])
  expect(read.stages[0].contacts).toEqual([{ name: 'Alex Doe', title: 'Recruiter' }])

  const { deleted } = await data('delete_interview', { event_id: offer.stage.id })
  expect(deleted.id).toBe(offer.stage.id)
  expect((await data('get_application', { id: created.id })).stages).toHaveLength(1)
  expect((await data('get_application', { id: created.id })).application.status).toBe('offered')
})

test('interview tools reject mismatched stages, bad values and non-stage events', async () => {
  enableTrack()
  const { application: created } = await data('record_application', application)
  const mismatched = await call('record_interview', { application_id: created.id, kind: 'offered', stage_type: 'technical' })
  expect(mismatched.isError).toBe(true)
  expect(mismatched.content[0]?.text).toContain('stage_type technical is not valid for offered')
  const badDate = await call('record_interview', { application_id: created.id, stage_type: 'technical', scheduled_at: 'soon' })
  expect(badDate.isError).toBe(true)
  const badContact = await call('record_interview', { application_id: created.id, stage_type: 'technical', contacts: [{ name: '' }] })
  expect(badContact.isError).toBe(true)
  const badPay = await call('update_application', { id: created.id, salary_min: -5 })
  expect(badPay.isError).toBe(true)
  const badCurrency = await call('update_application', { id: created.id, currency: 'dollars' })
  expect(badCurrency.isError).toBe(true)
  expect(badCurrency.content[0]?.text).toContain('currency: must be a 3-letter currency code')
  const { application: noNote } = await data('update_application', { id: created.id, note: 'x', rsu: 0 })
  expect(noNote).toMatchObject({ note: null, rsu: 0 })

  let firstEvent = 0
  inspect((db) => { firstEvent = listEvents(db, created.id)[0]!.id })
  const refused = await call('delete_interview', { event_id: firstEvent })
  expect(refused.isError).toBe(true)
  expect(refused.content[0]?.text).toBe(`event ${firstEvent} is not an interview or offer stage`)
  expect((await data('get_application', { id: created.id })).posting_description).toBeNull()
  const missing = await call('get_application', { id: 9999 })
  expect(missing.isError).toBe(true)
  expect(missing.content[0]?.text).toBe('application 9999 not found')
})

test('get_application returns the posting description, list_applications does not', async () => {
  enableTrack()
  const description = '<p>Build data pipelines at Acme.</p>'
  inspect((db) => { upsertPosting(db, { source: 'manual', ...application, description }) })
  const { application: created } = await data('record_application', application)
  expect((await data('get_application', { id: created.id })).posting_description).toBe(description)
  const { applications } = await data('list_applications')
  expect(applications[0]).not.toHaveProperty('posting_description')
  expect(applications[0]).not.toHaveProperty('description')
})

const fact = {
  slug: 'pm-001', company: 'Acme', role: 'Data Engineer', project: 'Pipeline Migration', category: 'action',
  action: 'Migrated 14 nightly batch jobs to a workflow orchestrator.', metrics: '14 jobs', skills: ['data_migration'],
  tools: ['airflow'], basis: 'stated',
}
const inferredFact = {
  slug: 'pm-002', company: 'Acme', role: 'Data Engineer', project: 'Pipeline Migration', category: 'methodology',
  action: 'Ran migrated jobs alongside cron before cutting over.', basis: 'inferred', confidence: 'medium',
  rationale: 'Parallel runs are the usual way to retire cron jobs safely.', sort_order: 20,
}

test('profile fact tools are registered, with list read-only and delete destructive', async () => {
  const { tools } = await client.listTools()
  const names = tools.map((tool) => tool.name)
  for (const name of ['list_profile_facts', 'save_profile_facts', 'update_profile_fact', 'delete_profile_fact']) {
    expect(names).toContain(name)
  }
  expect(tools.find((tool) => tool.name === 'list_profile_facts')?.annotations?.readOnlyHint).toBe(true)
  expect(tools.find((tool) => tool.name === 'delete_profile_fact')?.annotations?.destructiveHint).toBe(true)
})

test('profile fact writers are refused while cv is off', async () => {
  const writers: [string, Record<string, unknown>][] = [
    ['save_profile_facts', { facts: [fact] }],
    ['update_profile_fact', { id: 1, status: 'accepted' }],
    ['delete_profile_fact', { id: 1 }],
  ]
  for (const [name, args] of writers) {
    const refused = await call(name, args)
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toBe(CV_DISABLED)
  }
  inspect((db) => expect(db.prepare('SELECT COUNT(*) AS n FROM profile_facts').get()).toEqual({ n: 0 }))
})

test('save_profile_facts, list_profile_facts, update_profile_fact and delete_profile_fact round-trip', async () => {
  enableCv()
  const saved = await data('save_profile_facts', { facts: [fact, inferredFact] })
  expect(saved).toMatchObject({ inserted: 2, updated: 0 })
  expect(saved.facts.map((f: any) => f.status)).toEqual(['proposed', 'proposed'])

  const { facts } = await data('list_profile_facts', { company: 'acme' })
  expect(facts).toHaveLength(2)
  expect(facts[0]).toMatchObject({ ...fact, confidence: null, rationale: null, status: 'proposed' })
  expect(facts[1]).toMatchObject({ ...inferredFact, status: 'proposed' })

  const again = await data('save_profile_facts', { facts: [{ ...fact, outcome: 'Fewer failed runs.' }] })
  expect(again).toMatchObject({ inserted: 0, updated: 1 })
  expect(again.facts[0].id).toBe(facts[0].id)

  const { fact: accepted } = await data('update_profile_fact', { id: facts[0].id, status: 'accepted' })
  expect(accepted).toMatchObject({ status: 'accepted', outcome: 'Fewer failed runs.' })
  expect((await data('list_profile_facts', { status: 'accepted' })).facts.map((f: any) => f.id)).toEqual([facts[0].id])
  expect((await data('list_profile_facts', { status: ['proposed', 'archived'] })).facts).toHaveLength(1)

  const { deleted } = await data('delete_profile_fact', { id: facts[1].id })
  expect(deleted.slug).toBe('pm-002')
  expect((await data('list_profile_facts')).facts).toHaveLength(1)
})

test('profile fact tools reject invalid facts and missing ids without writing', async () => {
  enableCv()
  const noConfidence = await call('save_profile_facts', { facts: [fact, { ...inferredFact, confidence: undefined }] })
  expect(noConfidence.isError).toBe(true)
  expect(noConfidence.content[0]?.text).toContain('facts[1]: confidence: inferred facts need a confidence')
  const badTag = await call('save_profile_facts', { facts: [{ ...fact, tools: ['Air Flow'] }] })
  expect(badTag.isError).toBe(true)
  expect(badTag.content[0]?.text).toContain('lowercase snake_case')
  const tooMany = await call('save_profile_facts', { facts: Array.from({ length: MAX_FACTS_PER_SAVE + 1 }, () => fact) })
  expect(tooMany.isError).toBe(true)
  expect((await data('list_profile_facts')).facts).toEqual([])
  const missing = await call('update_profile_fact', { id: 9999, status: 'archived' })
  expect(missing.isError).toBe(true)
  expect(missing.content[0]?.text).toBe('fact 9999 not found')
})
