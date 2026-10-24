import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { type Sandbox, sandbox } from './helpers'
import { type Db, openDb } from '../src/db/client'
import { getApplicationWithPosting } from '../src/db/applications'
import { findPostingByUrl, type Posting, upsertPosting } from '../src/db/postings'
import { type FetchLike, FREEHIRE_JOB_URL, FREEHIRE_SEARCH_URL } from '../src/freehire/client'
import { createServer, type JobduckServer } from '../src/mcp/server'
import { dbPath, resolveWorkspace } from '../src/paths'
import { acceptAgentFields } from '../src/posting/evidence'
import { type LookupLike, type PinnedFetch, pinnedFetch, safeFetch } from '../src/posting/fetch'

const PUBLIC = '93.184.215.14'
const GREENHOUSE_API = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/7002?pay_transparency=true'
const CAPTCHA_URL = 'https://careers.example.com/jobs/2'
const GONE_URL = 'https://careers.example.com/jobs/gone'

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', 'postings', name), 'utf8')
const record = (name: string) => JSON.parse(fixture(name)) as Record<string, any>

const FULL = record('freehire-full.json')
const GAPS = record('freehire-gaps.json')
const EXCERPT_CHARS = 200
const asSearchResult = (job: Record<string, any>) => {
  const { closed_at: _closed, requires_clearance: _clearance, ...rest } = job
  const { education_level: _education, experience_years_min: _years, summary: _summary, requirements: _requirements, ...enrichment } =
    job.enrichment ?? {}
  return { ...rest, description: String(job.description).slice(0, EXCERPT_CHARS), enrichment }
}

let box: Sandbox
let jobduck: JobduckServer
let client: Client
let calls: string[]
let unexpected: string[]
let searchResults: Record<string, any>[]
let routes: Record<string, () => Response>

const json = (body: unknown) => () => Response.json(body)
const html = (body: string, status = 200) => () =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })

const fetch: FetchLike = async (url) => {
  calls.push(url)
  if (url.startsWith(`${FREEHIRE_SEARCH_URL}?`)) {
    return Response.json({ data: searchResults, meta: { limit: 50, offset: 0, total: searchResults.length } })
  }
  const route = routes[url]
  if (!route) {
    unexpected.push(url)
    throw new Error(`unexpected URL ${url}`)
  }
  return route()
}

const lookup: LookupLike = async (hostname) => {
  if (hostname === 'boards-api.greenhouse.io' || hostname === 'careers.example.com') return [{ address: PUBLIC, family: 4 }]
  unexpected.push(`lookup ${hostname}`)
  throw new Error(`unexpected lookup ${hostname}`)
}

beforeEach(async () => {
  box = sandbox()
  calls = []
  unexpected = []
  searchResults = []
  routes = {}
  jobduck = createServer({ home: box.home, fetch, lookup, sleep: async () => {} })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'jobduck-test', version: '0.0.0' })
  await Promise.all([jobduck.server.connect(serverTransport), client.connect(clientTransport)])
  const permissions = join(box.home, 'permissions.toml')
  writeFileSync(permissions, readFileSync(permissions, 'utf8').replace('track = false', 'track = true'))
})

afterEach(async () => {
  expect(unexpected).toEqual([])
  await client.close()
  await jobduck.close()
  box.cleanup()
})

interface ToolResult { isError?: boolean; content: { type: string; text: string }[] }

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult
}

async function data(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const result = await call(name, args)
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`)
  return JSON.parse(result.content[0]!.text) as Record<string, any>
}

const inspect = <T>(fn: (db: Db) => T): T => {
  const db = openDb(dbPath(box.home))
  try { return fn(db) } finally { db.close() }
}

const stored = (url: string) => inspect((db) => findPostingByUrl(db, url)) as Posting
const sourcesOf = (posting: Posting) => JSON.parse(posting.field_sources ?? '{}') as Record<string, string>
const detailUrl = (job: Record<string, any>) => `${FREEHIRE_JOB_URL}/${job.public_slug}`
const searchUrls = () => calls.filter((url) => url.startsWith(FREEHIRE_SEARCH_URL))

describe('record_application resolves the posting it saves', () => {
  test('a complete freehire record makes only the detail call and stores every detail field', async () => {
    searchResults = [asSearchResult(FULL)]
    routes = { [detailUrl(FULL)]: json({ data: FULL }) }
    await data('search_jobs', { q: 'platform' })
    expect(calls).toEqual(searchUrls())
    expect(stored(FULL.url)).toMatchObject({ summary: null, requirements: null, education_level: null, resolved_at: null })

    calls = []
    const saved = await data('record_application', { url: FULL.url, title: FULL.title, company: 'Acme' })
    expect(calls).toEqual([detailUrl(FULL)])
    expect(saved.resolution).toMatchObject({ missing: [], next: 'done', quality: 'ok', pay_stated: true, fetched: [], rejected: [] })
    expect(saved.resolution.sources).toMatchObject({ work_mode: 'freehire', summary: 'freehire', pay_min: 'freehire' })
    expect(saved.marker).toBe(`JobDuck-Application-Id: ${saved.application.id}`)

    const posting = stored(FULL.url)
    for (const column of ['seniority', 'skills', 'summary', 'requirements', 'requires_clearance', 'education_level',
      'min_experience_years', 'closed_at', 'resolved_at'] as const) {
      expect(posting[column]).not.toBeNull()
    }
    expect(posting).toMatchObject({
      state: 'MD', seniority: 'staff', education_level: 'bachelor', min_experience_years: 8, requires_clearance: 0,
      pay_stated: 1, closed_at: '2026-12-01T00:00:00.000Z', summary: 'Run the platform every Acme team ships on.',
    })
    expect(JSON.parse(posting.skills!)).toEqual(['typescript', 'postgres', 'kubernetes'])
    expect(JSON.parse(posting.requirements!)).toHaveLength(2)
    expect(posting.description!.length).toBeGreaterThan(EXCERPT_CHARS)

    const joined = inspect((db) => getApplicationWithPosting(db, saved.application.id))!
    expect(joined).toMatchObject({
      posting_country: 'US', posting_state: 'MD', posting_city: 'Laurel', posting_pay_min: 180000, posting_pay_max: 220000,
      posting_pay_period: 'year', posting_currency: 'USD', posting_pay_stated: 1,
    })
    expect((await data('get_application', { id: saved.application.id })).application.posting_country).toBe('US')

    calls = []
    const full = posting.description
    await data('search_jobs', { q: 'platform' })
    expect(calls).toEqual(searchUrls())
    expect(stored(FULL.url).description).toBe(full)
  })

  test('an ATS fetch fills work mode and pay, and unstated fields stay null', async () => {
    searchResults = [GAPS]
    routes = { [detailUrl(GAPS)]: json({ data: GAPS }), [GREENHOUSE_API]: json(JSON.parse(fixture('greenhouse-7002.json'))) }
    await data('search_jobs', { q: 'backend' })
    calls = []
    const saved = await data('record_application', { url: GAPS.url, title: GAPS.title, company: 'Acme' })
    expect(calls).toEqual([detailUrl(GAPS), GREENHOUSE_API])
    expect(saved.resolution).toMatchObject({ next: 'done', pay_stated: true, fetched: [GREENHOUSE_API] })

    const posting = stored(GAPS.url)
    expect(sourcesOf(posting)).toMatchObject({ work_mode: 'ats', pay_min: 'ats', country: 'freehire', seniority: 'freehire' })
    expect(posting).toMatchObject({ work_mode: 'hybrid', pay_min: 150000, pay_max: 190000, pay_stated: 1 })
    expect(posting.resolved_at).not.toBeNull()
    expect(posting).toMatchObject({ closed_at: null, requires_clearance: null, education_level: null })
    expect(inspect((db) => getApplicationWithPosting(db, saved.application.id))!.posting_country).toBe('US')
  })

  test('a captcha page hands off to the agent browser, and resolve_posting fills from its text with no fetch', async () => {
    routes = { [CAPTCHA_URL]: html(fixture('captcha.html')) }
    const saved = await data('record_application', { url: CAPTCHA_URL, title: 'Data Engineer', company: 'Acme' })
    expect(calls).toEqual([CAPTCHA_URL])
    expect(saved.resolution).toMatchObject({ quality: 'blocked', next: 'agent_browser', pay_stated: null })
    expect(saved.resolution.missing).toEqual(['country', 'city', 'work_mode', 'pay'])

    calls = []
    const text = 'Data Engineer at Acme. Location: Toronto, ON, Canada. This is a fully remote role. The salary range for '
      + 'this position is CA$110,000 - CA$135,000 per year. Acme builds data tools for example.com customers.'
    const fromText = await data('resolve_posting', { application_id: saved.application.id, text })
    expect(calls).toEqual([])
    expect(fromText.resolution).toMatchObject({ next: 'agent_fill', missing: ['country', 'city'], fetched: [] })
    expect(fromText.posting).toMatchObject({ work_mode: 'remote', pay_min: 110000, pay_max: 135000, currency: 'CAD' })

    const filled = await data('resolve_posting', {
      url: CAPTCHA_URL,
      text,
      fields: [
        { field: 'country', value: 'CA', quote: 'Toronto, ON, Canada' },
        { field: 'state', value: 'ON', quote: 'Toronto, ON' },
        { field: 'city', value: 'Toronto', quote: 'Location: Toronto' },
        { field: 'work_mode', value: 'hybrid', quote: 'fully remote role' },
      ],
    })
    expect(calls).toEqual([])
    expect(filled.resolution).toMatchObject({ next: 'done', missing: [] })
    expect(filled.resolution.rejected).toEqual([{
      proposal: { field: 'work_mode', value: 'hybrid', quote: 'fully remote role' },
      reason: 'work_mode is already set by an earlier layer',
    }])
    expect(filled.resolution.sources).toMatchObject({ country: 'agent', state: 'agent', city: 'agent', work_mode: 'text' })
    expect(filled.posting).toMatchObject({ country: 'CA', state: 'ON', city: 'Toronto', work_mode: 'remote' })

    const neither = await call('resolve_posting', { text })
    expect(neither.isError).toBe(true)
    expect(neither.content[0]?.text).toContain('exactly one of url or application_id')
    expect((await call('resolve_posting', { url: 'https://careers.example.com/jobs/unknown' })).content[0]?.text)
      .toContain('no saved posting')
  })

  test('a page that answers 404 is gone and is not handed to the agent', async () => {
    routes = { [GONE_URL]: html('<p>This job is no longer available.</p>', 404) }
    const saved = await data('record_application', { url: GONE_URL, title: 'Data Engineer', company: 'Acme' })
    expect(calls).toEqual([GONE_URL])
    expect(saved.resolution).toMatchObject({ quality: 'gone', next: 'done' })
  })

  test('find_application with_text fetches the freehire detail once and never the page', async () => {
    searchResults = [asSearchResult(FULL)]
    routes = { [detailUrl(FULL)]: json({ data: FULL }) }
    await data('search_jobs', { q: 'platform' })
    calls = []
    const first = await data('find_application', { url: FULL.url, with_text: true })
    expect(calls).toEqual([detailUrl(FULL)])
    expect(first.posting.text).toContain('About the role\n\n')
    expect(first.posting.text.length).toBeGreaterThan(EXCERPT_CHARS)
    expect(sourcesOf(stored(FULL.url)).description).toBe('freehire')
    await data('find_application', { url: FULL.url, with_text: true })
    expect(calls).toEqual([detailUrl(FULL)])
  })
})

describe('field precedence', () => {
  test('a stored freehire work mode survives a page value', () => {
    inspect((db) => {
      upsertPosting(db, { source: 'freehire', url: FULL.url, title: FULL.title, company: 'Acme', work_mode: 'hybrid' })
      const after = upsertPosting(db, {
        source: 'agent', url: FULL.url, title: FULL.title, company: 'Acme', work_mode: 'remote', city: 'Laurel',
        sources: { work_mode: 'page', city: 'page' },
      })
      expect(after).toMatchObject({ work_mode: 'hybrid', city: 'Laurel' })
      expect(sourcesOf(after)).toMatchObject({ work_mode: 'freehire', city: 'page' })
    })
  })

  test('a user value survives a freehire re-search', async () => {
    searchResults = [asSearchResult(FULL)]
    await data('search_jobs', { q: 'platform' })
    inspect((db) => upsertPosting(db, { source: 'manual', url: FULL.url, title: FULL.title, company: 'Acme', work_mode: 'onsite' }))
    await data('search_jobs', { q: 'platform' })
    const posting = stored(FULL.url)
    expect(posting.work_mode).toBe('onsite')
    expect(sourcesOf(posting).work_mode).toBe('user')
    expect(posting.seniority).toBe('staff')
  })

  test('a row without field_sources counts as its own source', () => {
    inspect((db) => {
      const legacy = upsertPosting(db, { source: 'manual', url: GAPS.url, title: GAPS.title, company: 'Acme', work_mode: 'onsite' })
      db.prepare('UPDATE postings SET field_sources = NULL WHERE id = ?').run(legacy.id)
      const after = upsertPosting(db, {
        source: 'freehire', url: GAPS.url, title: 'Backend Engineer', company: 'Acme', work_mode: 'remote', city: 'Austin',
      })
      expect(after).toMatchObject({ title: GAPS.title, work_mode: 'onsite', city: 'Austin' })
      expect(sourcesOf(after)).toMatchObject({ work_mode: 'user', city: 'freehire' })
    })
  })
})

describe('fold-ins', () => {
  test('<ws>/..odd resolves inside the workspace', () => {
    const workspace = join(box.root, 'ws')
    mkdirSync(join(workspace, '.jobduck'), { recursive: true })
    writeFileSync(join(workspace, '.jobduck', 'permissions.toml'), '')
    const odd = join(workspace, '..odd')
    mkdirSync(odd)
    const previous = process.env.JOBDUCK_HOME
    delete process.env.JOBDUCK_HOME
    try {
      expect(resolveWorkspace(odd, box.userHome)).toBe(workspace)
      expect(resolveWorkspace(join(box.root, 'elsewhere'), box.userHome)).toBe(join(box.root, 'elsewhere'))
    } finally {
      process.env.JOBDUCK_HOME = previous
    }
  })

  test('a second proposal for a field is rejected as a duplicate', () => {
    const text = 'Acme works hybrid from Austin, with two office days a week.'
    const evidence = acceptAgentFields(text, [
      { field: 'work_mode', value: 'hybrid', quote: 'Acme works hybrid' },
      { field: 'work_mode', value: 'onsite', quote: 'two office days a week' },
    ])
    expect(evidence.accepted.map((item) => [item.field, item.value])).toEqual([['work_mode', 'hybrid']])
    expect(evidence.rejected.map((item) => item.reason)).toEqual(['duplicate proposal for work_mode'])
  })
})

describe('the guarded fetch pins the address it checked', () => {
  test('safeFetch connects to the checked IP even when a second DNS answer differs', async () => {
    const answers = [PUBLIC, '10.0.0.8']
    const lookups: string[] = []
    const rebinding: LookupLike = async (hostname) => {
      lookups.push(hostname)
      return [{ address: answers[Math.min(lookups.length - 1, answers.length - 1)]!, family: 4 }]
    }
    const targets: string[] = []
    const pinned: PinnedFetch = async (url, target) => {
      targets.push(`${url.hostname} ${target.address}`)
      await rebinding(url.hostname)
      return new Response('<p>ok</p>', { headers: { 'content-type': 'text/html' } })
    }
    const response = await safeFetch('https://careers.example.com/jobs/1', { pinned, lookup: rebinding })
    expect(response.body).toBe('<p>ok</p>')
    expect(targets).toEqual([`careers.example.com ${PUBLIC}`])
    expect(lookups).toEqual(['careers.example.com', 'careers.example.com'])
  })

  test('pinnedFetch sends the request to the pinned address, not to DNS', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => new Response(`host=${request.headers.get('host')}`, { headers: { 'content-type': 'text/plain' } }),
    })
    try {
      const url = new URL(`http://posting.invalid:${server.port}/jobs/1`)
      const response = await pinnedFetch(url, { address: '127.0.0.1', family: 4 }, {
        headers: { Accept: 'text/plain' }, signal: AbortSignal.timeout(5_000),
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(`host=posting.invalid:${server.port}`)
    } finally {
      await server.stop(true)
    }
  })
})
