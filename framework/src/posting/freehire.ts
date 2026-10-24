import type { FreehireJob } from '../freehire/client'
import {
  cleanString, finiteNumber, normalizeCurrency, normalizeJobType, normalizeMoment, normalizePayPeriod,
  normalizeRequirements, normalizeSeniority, normalizeSkills, normalizeWorkMode, type PostingFields,
} from './fields'
import { richText } from './html'
import { countryCode } from './places'
import { parseLocation } from './text'

const GARBAGE_LOCATION = /^(\w+), \1\b/i

const booleanOf = (value: unknown) => (typeof value === 'boolean' ? value : undefined)

export function freehireFields(job: FreehireJob): PostingFields {
  const record = job as Record<string, unknown>
  const enrichment = (job.enrichment ?? {}) as Record<string, unknown>
  const fields: PostingFields = {}
  const set = <K extends keyof PostingFields>(field: K, value: PostingFields[K] | undefined) => {
    if (value !== undefined) fields[field] = value
  }
  set('title', cleanString(job.title))
  set('company', cleanString(job.company))
  const location = cleanString(job.location)
  const usable = location !== undefined && !GARBAGE_LOCATION.test(location) ? location : undefined
  const country = countryCode(job.countries?.[0])
  const parsed = usable ? parseLocation(usable) : {}
  const consistent = country === undefined || parsed.country === undefined || parsed.country === country
  const cities = Array.isArray(record.cities) ? record.cities.map(cleanString).filter((city) => city !== undefined) : []
  set('location', usable)
  set('country', country ?? parsed.country)
  set('city', cities[0] ?? (consistent ? parsed.city : undefined))
  if (consistent) set('state', parsed.state)
  set('work_mode', normalizeWorkMode(record.work_mode))
  set('job_type', normalizeJobType(enrichment.employment_type))
  set('seniority', normalizeSeniority(enrichment.seniority))
  set('education_level', cleanString(enrichment.education_level))
  set('min_experience_years', finiteNumber(enrichment.experience_years_min))
  set('pay_min', finiteNumber(enrichment.salary_min))
  set('pay_max', finiteNumber(enrichment.salary_max))
  set('pay_period', normalizePayPeriod(enrichment.salary_period))
  set('currency', normalizeCurrency(enrichment.salary_currency))
  set('summary', cleanString(enrichment.summary))
  set('requirements', normalizeRequirements(enrichment.requirements))
  set('skills', normalizeSkills(job.skills))
  set('requires_clearance', booleanOf(record.requires_clearance) ?? booleanOf(enrichment.requires_clearance))
  set('posted_at', normalizeMoment(job.posted_at))
  set('closed_at', normalizeMoment(record.closed_at))
  set('description', richText(job.description))
  return fields
}
