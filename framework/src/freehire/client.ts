import { z } from 'zod'
import { PACKAGE_VERSION } from '../paths'

export const FREEHIRE_SEARCH_URL = 'https://freehire.me/api/v1/jobs/search'
export const PAGE_LIMIT = 50
export const MAX_WINDOW = 10_000
export const MAX_RATE_LIMIT_SLEEP_MS = 5_000
export { PACKAGE_VERSION }
export const USER_AGENT = `jobduck/${PACKAGE_VERSION} (+https://www.npmjs.com/package/jobduck)`

const nullableString = z.string().nullish()

export const FreehireJob = z.looseObject({
  external_id: z.string(),
  url: z.string(),
  title: z.string(),
  company: z.string(),
  company_slug: nullableString,
  location: nullableString,
  countries: z.array(z.string()).nullish(),
  posted_at: nullableString,
  last_seen_at: nullableString,
  source: nullableString,
  skills: z.array(z.string()).nullish(),
  description: nullableString,
  enrichment: z.looseObject({
    seniority: nullableString,
    employment_type: nullableString,
    category: nullableString,
  }).nullish(),
  reality: z.looseObject({
    class: nullableString,
    repost_count: z.number().nullish(),
  }).nullish(),
})
export type FreehireJob = z.infer<typeof FreehireJob>

export const FreehireSearchResponse = z.object({
  data: z.array(FreehireJob),
  meta: z.object({ limit: z.number(), offset: z.number(), total: z.number() }),
})

export interface SearchParams {
  q?: string
  countries?: string[]
  posted_within_days?: number
  company_slug?: string
  skills?: string[]
  is_tech?: string
  seniority?: string
  employment_type?: string
  sort?: 'posted_at' | 'created_at'
  max_results: number
  offset?: number
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface SearchOptions {
  fetch?: FetchLike
  userAgent?: string
  sleep?: (ms: number) => Promise<void>
}

export interface SearchResult {
  total: number
  jobs: FreehireJob[]
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function rateLimitWaitMs(headers: Headers): number {
  const reset = Number(headers.get('x-ratelimit-reset') ?? '1')
  const seconds = Number.isFinite(reset) && reset > 0 ? reset : 1
  return Math.min(seconds * 1000, MAX_RATE_LIMIT_SLEEP_MS)
}

export function buildSearchUrl(params: SearchParams, offset: number, limit: number): string {
  const query = new URLSearchParams()
  const set = (name: string, value: string | number | undefined) => {
    if (value !== undefined && value !== '') query.set(name, String(value))
  }
  set('q', params.q)
  set('countries', params.countries?.join(','))
  set('posted_within_days', params.posted_within_days)
  set('company_slug', params.company_slug)
  set('skills', params.skills?.join(','))
  set('is_tech', params.is_tech)
  set('seniority', params.seniority)
  set('employment_type', params.employment_type)
  set('sort', params.sort)
  query.set('limit', String(limit))
  query.set('offset', String(offset))
  return `${FREEHIRE_SEARCH_URL}?${query.toString()}`
}

export async function searchJobs(params: SearchParams, options: SearchOptions = {}): Promise<SearchResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const sleep = options.sleep ?? defaultSleep
  const headers = { 'User-Agent': options.userAgent ?? USER_AGENT, Accept: 'application/json' }
  const jobs: FreehireJob[] = []
  let offset = params.offset ?? 0
  let total = 0

  while (jobs.length < params.max_results && offset < MAX_WINDOW) {
    const limit = Math.min(PAGE_LIMIT, params.max_results - jobs.length, MAX_WINDOW - offset)
    const url = buildSearchUrl(params, offset, limit)
    let response = await fetchImpl(url, { headers })
    if (response.status === 429) {
      await sleep(rateLimitWaitMs(response.headers))
      response = await fetchImpl(url, { headers })
    }
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200)
      throw new Error(`freehire search failed: HTTP ${response.status}: ${body}`)
    }
    const page = FreehireSearchResponse.parse(await response.json())
    total = page.meta.total
    jobs.push(...page.data.slice(0, params.max_results - jobs.length))
    offset += page.data.length
    if (page.data.length === 0 || offset >= total) break
    if (response.headers.get('x-ratelimit-remaining') === '0') await sleep(rateLimitWaitMs(response.headers))
  }
  return { total, jobs }
}
