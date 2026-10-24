import {
  cleanString, finiteNumber, normalizeCurrency, normalizeJobType, normalizeMoment, normalizePayPeriod,
  normalizeSeniority, normalizeWorkMode, type PayPeriod, type PostingFields, type Seniority,
} from './fields'
import { addressFields, microsoftRead, placeFields, richText, type SiteRead } from './html'
import { countryCode } from './places'
import { extractPay, parseLocation } from './text'

export type AtsKind = 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'smartrecruiters' | 'microsoft'

export interface AtsEndpoint {
  kind: AtsKind
  apiUrl: string
  parse(payload: unknown): SiteRead | undefined
}

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : [])
const strings = (values: unknown[]) => values.map(cleanString).filter((value): value is string => value !== undefined)

function compose(header: (string | undefined)[], sections: (string | undefined)[]): string | undefined {
  const head = strings(header).join('\n')
  const body = strings(sections).join('\n\n')
  return [head, body].filter(Boolean).join('\n\n') || undefined
}

function locationFields(locations: string[]): PostingFields {
  const unique = [...new Set(locations)]
  if (unique.length === 0) return {}
  const fields = placeFields(parseLocation(unique[0]!), unique.join('; '))
  const lower = unique.join(' ').toLowerCase()
  if (/\bhybrid\b/.test(lower)) fields.work_mode = 'hybrid'
  else if (/\bremote\b/.test(lower)) fields.work_mode = 'remote'
  return fields
}

const inferPeriod = (high: number): PayPeriod => (high >= 10_000 ? 'year' : high <= 500 ? 'hour' : 'month')

function payRange(min: unknown, max: unknown, currency: unknown, period?: PayPeriod): PostingFields {
  const low = finiteNumber(min)
  const high = finiteNumber(max)
  if (low === undefined && high === undefined) return {}
  const fields: PostingFields = { pay_period: period ?? inferPeriod(high ?? low!) }
  if (low !== undefined) fields.pay_min = low
  if (high !== undefined) fields.pay_max = high
  const code = normalizeCurrency(currency)
  if (code) fields.currency = code
  return fields
}

function payFromText(text: string | undefined): PostingFields {
  const pay = text ? extractPay(text)?.value : undefined
  if (!pay || (pay.min === undefined && pay.max === undefined)) return {}
  return payRange(pay.min, pay.max, pay.currency, pay.period)
}

const GREENHOUSE_HOSTS: Record<string, string> = {
  'job-boards.greenhouse.io': 'boards-api.greenhouse.io',
  'boards.greenhouse.io': 'boards-api.greenhouse.io',
  'job-boards.eu.greenhouse.io': 'boards-api.eu.greenhouse.io',
  'boards.eu.greenhouse.io': 'boards-api.eu.greenhouse.io',
}

function greenhouse(url: URL): AtsEndpoint | undefined {
  const apiHost = GREENHOUSE_HOSTS[url.hostname]
  if (!apiHost) return undefined
  let board: string | undefined
  let id: string | undefined
  if (url.pathname.replace(/\/$/, '') === '/embed/job_app') {
    board = url.searchParams.get('for') ?? undefined
    id = url.searchParams.get('token') ?? undefined
  } else {
    const match = /^\/([A-Za-z0-9_-]+)\/jobs\/(\d+)(?:\/.*)?$/.exec(url.pathname)
    board = match?.[1]
    id = match?.[2]
  }
  if (!board || !/^[A-Za-z0-9_-]+$/.test(board) || !id || !/^\d+$/.test(id)) return undefined
  return {
    kind: 'greenhouse',
    apiUrl: `https://${apiHost}/v1/boards/${board}/jobs/${id}?pay_transparency=true`,
    parse: (payload) => {
      if (!isRecord(payload) || !cleanString(payload.title)) return undefined
      const title = cleanString(payload.title)
      const company = cleanString(payload.company_name)
      const location = cleanString(isRecord(payload.location) ? payload.location.name : undefined)
      const locations = location ? [location] : strings(records(payload.offices).map((office) => office.name))
      const description = richText(payload.content)
      const fields: PostingFields = { title, ...locationFields(locations) }
      if (company) fields.company = company
      const range = records(payload.pay_input_ranges)
        .find((item) => finiteNumber(item.min_cents) !== undefined || finiteNumber(item.max_cents) !== undefined)
      Object.assign(fields, range
        ? payRange(cents(range.min_cents), cents(range.max_cents), range.currency_type)
        : payFromText(description))
      const posted = normalizeMoment(payload.first_published) ?? normalizeMoment(payload.updated_at)
      if (posted) fields.posted_at = posted
      if (description) fields.description = description
      return { fields, text: compose([title, company, locations.join('; ')], [description]) }
    },
  }
}

const cents = (value: unknown) => {
  const amount = finiteNumber(value)
  return amount === undefined ? undefined : Math.round(amount) / 100
}

const LEVER_INTERVALS: Record<string, PayPeriod> = {
  'per-year-salary': 'year', 'per-month-salary': 'month', 'per-week-salary': 'week',
  'per-day-wage': 'day', 'per-hour-wage': 'hour',
}

function lever(url: URL): AtsEndpoint | undefined {
  const apiHost = { 'jobs.lever.co': 'api.lever.co', 'jobs.eu.lever.co': 'api.eu.lever.co' }[url.hostname]
  const match = /^\/([A-Za-z0-9._-]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/apply)?\/?$/i.exec(url.pathname)
  if (!apiHost || !match) return undefined
  return {
    kind: 'lever',
    apiUrl: `https://${apiHost}/v0/postings/${match[1]}/${match[2]!.toLowerCase()}`,
    parse: (payload) => {
      if (!isRecord(payload) || !cleanString(payload.text)) return undefined
      const title = cleanString(payload.text)
      const categories = isRecord(payload.categories) ? payload.categories : {}
      const all = Array.isArray(categories.allLocations) ? categories.allLocations : []
      const locations = strings([categories.location, ...all])
      const fields: PostingFields = { title, ...locationFields(locations) }
      const country = countryCode(payload.country)
      if (country && (fields.country === undefined || fields.country === country)) fields.country = country
      else if (country) Object.assign(fields, { country, city: undefined, state: undefined })
      const mode = normalizeWorkMode(payload.workplaceType)
      if (mode) fields.work_mode = mode
      const jobType = normalizeJobType(categories.commitment)
      if (jobType) fields.job_type = jobType
      const lists = records(payload.lists).map((list) =>
        compose([cleanString(list.text)], [richText(list.content)]))
      const description = compose([], [
        cleanString(payload.descriptionPlain) ?? richText(payload.description), ...lists,
        cleanString(payload.additionalPlain) ?? richText(payload.additional),
      ])
      const salary = isRecord(payload.salaryRange) ? payload.salaryRange : undefined
      Object.assign(fields, salary
        ? payRange(salary.min, salary.max, salary.currency, LEVER_INTERVALS[String(salary.interval)])
        : payFromText(description))
      const posted = normalizeMoment(payload.createdAt)
      if (posted) fields.posted_at = posted
      if (description) fields.description = description
      return { fields: dropUndefined(fields), text: compose([title, locations.join('; ')], [description]) }
    },
  }
}

const dropUndefined = (fields: PostingFields): PostingFields =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as PostingFields

const ashbyKey = (value: unknown) => (typeof value === 'string' ? value.toLowerCase().replace(/[^a-z]/g, '') : '')
const ASHBY_INTERVAL = (value: unknown): PayPeriod | undefined =>
  normalizePayPeriod(String(value ?? '').toLowerCase().replace(/^\d+\s*/, ''))

function ashby(url: URL): AtsEndpoint | undefined {
  if (url.hostname !== 'jobs.ashbyhq.com') return undefined
  const match = /^\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/application)?\/?$/i.exec(url.pathname)
  if (!match) return undefined
  const id = match[2]!.toLowerCase()
  return {
    kind: 'ashby',
    apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${match[1]}?includeCompensation=true`,
    parse: (payload) => {
      const job = isRecord(payload) ? records(payload.jobs).find((item) => String(item.id).toLowerCase() === id) : undefined
      if (!job) return undefined
      const title = cleanString(job.title)
      const locations = strings([job.location, ...records(job.secondaryLocations).map((item) => item.location)])
      const fields: PostingFields = { ...locationFields(locations) }
      if (title) fields.title = title
      const address = isRecord(job.address) && isRecord(job.address.postalAddress) ? job.address.postalAddress : undefined
      if (address) Object.assign(fields, dropUndefined({ ...addressFields(address), location: fields.location }))
      const mode = { onsite: 'onsite', hybrid: 'hybrid', remote: 'remote' }[ashbyKey(job.workplaceType)] as PostingFields['work_mode']
      if (mode) fields.work_mode = mode
      else if (job.isRemote === true) fields.work_mode = 'remote'
      const jobType = { fulltime: 'full_time', parttime: 'part_time', intern: 'internship', contract: 'contract', temporary: 'temporary' }[ashbyKey(job.employmentType)] as PostingFields['job_type']
      if (jobType) fields.job_type = jobType
      const description = cleanText(job.descriptionPlain) ?? richText(job.descriptionHtml)
      const compensation = isRecord(job.compensation) ? job.compensation : {}
      const salary = records(compensation.summaryComponents).find((item) => item.compensationType === 'Salary')
      const summary = cleanString(compensation.scrapeableCompensationSalarySummary) ?? cleanString(compensation.compensationTierSummary)
      Object.assign(fields, salary
        ? payRange(salary.minValue, salary.maxValue, salary.currencyCode, ASHBY_INTERVAL(salary.interval))
        : payFromText(summary ?? description))
      const posted = normalizeMoment(job.publishedAt)
      if (posted) fields.posted_at = posted
      if (description) fields.description = description
      return { fields, text: compose([title, locations.join('; '), summary], [description]) }
    },
  }
}

const cleanText = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

function workday(url: URL): AtsEndpoint | undefined {
  const host = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i.exec(url.hostname)
  const path = /^\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)\/job\/(.+?)\/?$/.exec(url.pathname)
  if (!host || !path || path[1] === 'wday') return undefined
  return {
    kind: 'workday',
    apiUrl: `https://${url.hostname}/wday/cxs/${host[1]}/${path[1]}/job/${path[2]}`,
    parse: (payload) => {
      const info = isRecord(payload) && isRecord(payload.jobPostingInfo) ? payload.jobPostingInfo : undefined
      const title = info ? cleanString(info.title) : undefined
      if (!info || !title) return undefined
      const company = isRecord(payload) && isRecord(payload.hiringOrganization) ? cleanString(payload.hiringOrganization.name) : undefined
      const extra = Array.isArray(info.additionalLocations) ? info.additionalLocations : []
      const locations = strings([info.location, ...extra])
      const fields: PostingFields = { title, ...locationFields(locations) }
      if (company) fields.company = company
      const country = countryCode(isRecord(info.country) ? info.country.descriptor : undefined)
      if (country && fields.country === undefined) fields.country = country
      const mode = normalizeWorkMode(info.remoteType)
      if (mode) fields.work_mode = mode
      const jobType = normalizeJobType(info.timeType)
      if (jobType) fields.job_type = jobType
      const description = richText(info.jobDescription)
      Object.assign(fields, payFromText(description))
      const posted = normalizeMoment(info.startDate)
      if (posted) fields.posted_at = posted
      const closed = normalizeMoment(info.endDate)
      if (closed) fields.closed_at = closed
      if (description) fields.description = description
      return { fields, text: compose([title, company, locations.join('; ')], [description]) }
    },
  }
}

const SMARTRECRUITERS_LEVELS: Record<string, Seniority> = {
  internship: 'intern', entry_level: 'entry', associate: 'entry', mid_senior_level: 'mid',
  director: 'director', executive: 'executive',
}

function smartrecruiters(url: URL): AtsEndpoint | undefined {
  if (url.hostname !== 'jobs.smartrecruiters.com' && url.hostname !== 'careers.smartrecruiters.com') return undefined
  const match = /^\/([A-Za-z0-9_-]+)\/(\d+)(?:-[^/]*)?\/?$/.exec(url.pathname)
  if (!match) return undefined
  return {
    kind: 'smartrecruiters',
    apiUrl: `https://api.smartrecruiters.com/v1/companies/${match[1]}/postings/${match[2]}`,
    parse: (payload) => {
      if (!isRecord(payload) || !cleanString(payload.name)) return undefined
      const title = cleanString(payload.name)
      const fields: PostingFields = { title }
      const company = isRecord(payload.company) ? cleanString(payload.company.name) : undefined
      if (company) fields.company = company
      const location = isRecord(payload.location) ? payload.location : {}
      const country = countryCode(location.country)
      const display = cleanString(location.fullLocation) ?? strings([location.city, location.region, location.country]).join(', ')
      Object.assign(fields, dropUndefined({
        ...addressFields({ addressLocality: location.city, addressRegion: location.region, addressCountry: country }),
        location: display || undefined,
      }))
      if (location.hybrid === true) fields.work_mode = 'hybrid'
      else if (location.remote === true) fields.work_mode = 'remote'
      const employment = isRecord(payload.typeOfEmployment) ? payload.typeOfEmployment : {}
      const jobType = normalizeJobType(employment.id) ?? normalizeJobType(employment.label)
      if (jobType) fields.job_type = jobType
      const level = isRecord(payload.experienceLevel) ? payload.experienceLevel : {}
      const seniority = SMARTRECRUITERS_LEVELS[String(level.id)] ?? normalizeSeniority(level.label)
      if (seniority) fields.seniority = seniority
      const sections = isRecord(payload.jobAd) && isRecord(payload.jobAd.sections) ? payload.jobAd.sections : {}
      const description = compose([], ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
        .map((key) => sections[key]).filter(isRecord)
        .map((section) => compose([cleanString(section.title)], [richText(section.text)])))
      Object.assign(fields, payFromText(description))
      const posted = normalizeMoment(payload.releasedDate)
      if (posted) fields.posted_at = posted
      if (description) fields.description = description
      return { fields, text: compose([title, company, display], [description]) }
    },
  }
}

function microsoft(url: URL): AtsEndpoint | undefined {
  if (url.hostname !== 'apply.careers.microsoft.com' && url.hostname !== 'jobs.careers.microsoft.com') return undefined
  const id = /\/job\/(\d+)/.exec(url.pathname)?.[1]
  if (!id) return undefined
  return {
    kind: 'microsoft',
    apiUrl: `https://apply.careers.microsoft.com/api/apply/v2/jobs/${id}?domain=microsoft.com`,
    parse: (payload) => {
      const read = isRecord(payload) ? microsoftRead(payload) : undefined
      if (!read) return undefined
      Object.assign(read.fields, payFromText(read.text))
      return read
    },
  }
}

const ADAPTERS = [greenhouse, lever, ashby, workday, smartrecruiters, microsoft]

export function atsEndpoint(raw: string): AtsEndpoint | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  for (const adapter of ADAPTERS) {
    const endpoint = adapter(url)
    if (endpoint) return endpoint
  }
  return undefined
}
