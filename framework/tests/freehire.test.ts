import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type FetchLike, type FreehireJob, searchJobs, USER_AGENT } from '../src/freehire/client'
import { stripUtmSource, toPostingInput } from '../src/freehire/map'

interface FixturePage { headers: Record<string, string>; body: { data: FreehireJob[]; meta: Record<string, number> } }
const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'freehire-search.json'), 'utf8')) as { pages: FixturePage[] }

interface Call { url: URL; headers: Record<string, string> }

function fixtureFetch(responses: (() => Response)[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: new URL(input), headers: (init?.headers ?? {}) as Record<string, string> })
    const next = responses[calls.length - 1]
    if (!next) throw new Error(`unexpected request ${calls.length}: ${input}`)
    return next()
  }
  return { fetch, calls }
}

const pageResponse = (page: FixturePage) => () =>
  new Response(JSON.stringify(page.body), { status: 200, headers: page.headers })

test('pages the fixture, sends the UA and Accept headers, and waits when the rate limit is spent', async () => {
  const { fetch, calls } = fixtureFetch(fixture.pages.map(pageResponse))
  const sleeps: number[] = []
  const result = await searchJobs(
    { q: 'engineer', countries: ['US'], posted_within_days: 7, sort: 'posted_at', max_results: 50 },
    { fetch, sleep: async (ms) => { sleeps.push(ms) } },
  )
  expect(result.total).toBe(3)
  expect(result.jobs.map((job) => job.external_id)).toEqual(['acme:1001', 'globex:2002', 'initech:3003'])
  expect(calls).toHaveLength(2)
  expect(calls.map((call) => call.url.searchParams.get('offset'))).toEqual(['0', '2'])
  expect(calls[0]?.url.searchParams.get('limit')).toBe('50')
  expect(`${calls[0]?.url.origin}${calls[0]?.url.pathname}`).toBe('https://freehire.me/api/v1/jobs/search')
  expect(calls[0]?.url.searchParams.get('q')).toBe('engineer')
  expect(calls[0]?.url.searchParams.get('countries')).toBe('US')
  expect(calls[0]?.url.searchParams.get('posted_within_days')).toBe('7')
  expect(calls[0]?.headers['User-Agent']).toBe(USER_AGENT)
  expect(USER_AGENT).toMatch(/^jobduck\/\d+\.\d+\.\d+ \(\+https:\/\/www\.npmjs\.com\/package\/jobduck\)$/)
  expect(calls[0]?.headers.Accept).toBe('application/json')
  expect(sleeps).toEqual([2000])
  expect((result.jobs[0] as Record<string, unknown>).public_slug).toBe('staff-engineer-acme-1')
})

test('stops at max_results and asks only for what it needs', async () => {
  const { fetch, calls } = fixtureFetch(fixture.pages.map(pageResponse))
  const result = await searchJobs({ max_results: 1 }, { fetch, sleep: async () => {} })
  expect(calls).toHaveLength(1)
  expect(calls[0]?.url.searchParams.get('limit')).toBe('1')
  expect(result.jobs).toHaveLength(1)
})

test('never requests past offset + limit = 10000', async () => {
  const template = fixture.pages[0]!.body.data[0]!
  const calls: URL[] = []
  const fetch: FetchLike = async (input) => {
    const url = new URL(input)
    calls.push(url)
    const limit = Number(url.searchParams.get('limit'))
    const offset = Number(url.searchParams.get('offset'))
    const data = Array.from({ length: limit }, (_, i) => ({ ...template, external_id: `x:${offset + i}` }))
    return new Response(JSON.stringify({ data, meta: { limit, offset, total: 50_000 } }), { status: 200 })
  }
  const result = await searchJobs({ max_results: 500, offset: 9_930 }, { fetch, sleep: async () => {} })
  expect(calls.map((url) => [url.searchParams.get('offset'), url.searchParams.get('limit')]))
    .toEqual([['9930', '50'], ['9980', '20']])
  expect(result.jobs).toHaveLength(70)
  for (const url of calls) {
    expect(Number(url.searchParams.get('offset')) + Number(url.searchParams.get('limit'))).toBeLessThanOrEqual(10_000)
  }
})

test('retries once after a 429 and throws on other errors', async () => {
  const sleeps: number[] = []
  const limited = () => new Response('slow down', { status: 429, headers: { 'x-ratelimit-reset': '30' } })
  const retried = fixtureFetch([limited, pageResponse({ ...fixture.pages[1]!, body: { ...fixture.pages[1]!.body, meta: { limit: 50, offset: 0, total: 1 } } })])
  const result = await searchJobs({ max_results: 10 }, { fetch: retried.fetch, sleep: async (ms) => { sleeps.push(ms) } })
  expect(result.jobs).toHaveLength(1)
  expect(retried.calls).toHaveLength(2)
  expect(sleeps).toEqual([5000])

  const twice = fixtureFetch([limited, limited])
  await expect(searchJobs({ max_results: 10 }, { fetch: twice.fetch, sleep: async () => {} })).rejects.toThrow('HTTP 429')

  const broken = fixtureFetch([() => new Response('upstream exploded', { status: 502 })])
  await expect(searchJobs({ max_results: 10 }, { fetch: broken.fetch })).rejects.toThrow('HTTP 502: upstream exploded')
})

test('maps a job to a posting and strips utm_source only', () => {
  const [first, second] = fixture.pages[0]!.body.data
  const third = fixture.pages[1]!.body.data[0]!
  expect(toPostingInput(first!)).toMatchObject({
    source: 'freehire',
    source_id: 'acme:1001',
    url: 'https://job-boards.greenhouse.io/acme/jobs/1001',
    title: 'Staff Engineer',
    company: 'Acme',
    country: 'US',
    job_type: 'full_time',
    posted_at: '2026-10-16T10:00:00Z',
    description: '<p>Build things.</p>',
  })
  expect(JSON.parse(toPostingInput(first!).raw ?? '{}').public_slug).toBe('staff-engineer-acme-1')
  expect(toPostingInput(second!).url)
    .toBe('https://www.whatjobs.com/pub_api__cpl__2002?geoID=1&utm_campaign=publisher&utm_medium=api')
  expect(toPostingInput(third).country).toBe('CA')
  expect(toPostingInput(first!)).toMatchObject({
    work_mode: 'hybrid', city: 'San Francisco', country: 'US', location: 'San Francisco, US',
    pay_min: 200000, pay_max: 250000, currency: 'USD', pay_period: 'year',
  })
  expect(toPostingInput(first!).state).toBeUndefined()
  expect(toPostingInput(second!)).toMatchObject({
    work_mode: null, city: null, location: 'US', pay_min: null, pay_max: null, currency: null, pay_period: null,
  })
  expect(toPostingInput(third)).toMatchObject({
    work_mode: 'remote', city: 'Toronto', location: 'Toronto, CA', pay_min: 150000, pay_max: 180000,
    currency: 'CAD', pay_period: null,
  })
  expect(toPostingInput({ ...second!, location: 'Remote - United States' }).location).toBe('Remote - United States')
  expect(toPostingInput({ ...first!, cities: ['Seattle', 'Bellevue'] }).location).toBe('Seattle, Bellevue, US')
  expect(stripUtmSource('https://x.io/a?utm_source=freehire.me#top')).toBe('https://x.io/a#top')
  expect(stripUtmSource('https://x.io/a')).toBe('https://x.io/a')
})
