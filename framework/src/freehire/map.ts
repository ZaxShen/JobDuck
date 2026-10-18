import type { PostingInput } from '../db/postings'
import type { FreehireJob } from './client'

export function stripUtmSource(url: string): string {
  const hashAt = url.indexOf('#')
  const fragment = hashAt === -1 ? '' : url.slice(hashAt)
  const withoutFragment = hashAt === -1 ? url : url.slice(0, hashAt)
  const queryAt = withoutFragment.indexOf('?')
  if (queryAt === -1) return url
  const base = withoutFragment.slice(0, queryAt)
  const kept = withoutFragment.slice(queryAt + 1).split('&')
    .filter((param) => param !== '' && param.split('=')[0] !== 'utm_source')
  return `${base}${kept.length > 0 ? `?${kept.join('&')}` : ''}${fragment}`
}

const GARBAGE_LOCATION = /^(\w+), \1\b/i

const str = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

function locationOf(job: FreehireJob, cities: string[], country: string | null): string | null {
  if (cities.length > 0) return country ? `${cities.join(', ')}, ${country}` : cities.join(', ')
  const location = str(job.location)
  return location !== null && !GARBAGE_LOCATION.test(location) ? location : country
}

export function toPostingInput(job: FreehireJob): PostingInput {
  const cities = Array.isArray(job.cities) ? job.cities.map(str).filter((city): city is string => city !== null) : []
  const country = job.countries?.[0]?.toUpperCase() ?? null
  const enrichment = job.enrichment ?? {}
  return {
    source: 'freehire',
    source_id: job.external_id,
    url: stripUtmSource(job.url),
    title: job.title,
    company: job.company,
    location: locationOf(job, cities, country),
    country,
    city: cities[0] ?? null,
    work_mode: str(job.work_mode),
    job_type: enrichment.employment_type ?? null,
    posted_at: job.posted_at ?? null,
    pay_min: num(enrichment.salary_min),
    pay_max: num(enrichment.salary_max),
    currency: str(enrichment.salary_currency),
    pay_period: str(enrichment.salary_period),
    description: job.description ?? null,
    raw: JSON.stringify(job),
  }
}
