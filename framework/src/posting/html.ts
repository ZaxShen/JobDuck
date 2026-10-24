import {
  cleanString, fillFields, finiteNumber, type JobType, normalizeCurrency, normalizeJobType, normalizeMoment,
  normalizePayPeriod, normalizeSkills, normalizeWorkMode, type PostingFields,
} from './fields'
import { countryCode, regionOf } from './places'
import { extractPay, parseLocation, type Place } from './text'

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  sbquo: '‚', bdquo: '„', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£',
  cent: '¢', yen: '¥', deg: '°', times: '×', divide: '÷', plusmn: '±', para: '¶', sect: '§', shy: '',
  zwj: '', zwnj: '', iexcl: '¡', iquest: '¿', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó',
  uacute: 'ú', ntilde: 'ñ', agrave: 'à', egrave: 'è', ccedil: 'ç', auml: 'ä', ouml: 'ö', uuml: 'ü',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', Eacute: 'É',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? entity
  })
}

const HIDDEN = /<(script|style|noscript|template|svg|head|iframe|object|select)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const BLOCK = /<\/?(?:p|div|h[1-6]|ul|ol|table|thead|tbody|section|article|header|footer|blockquote|pre|hr|main|aside|nav|form|fieldset|dl|dt|dd|figure|figcaption|address|details|summary)\b[^>]*>/gi

export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(HIDDEN, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/tr\s*>/gi, '\n')
    .replace(BLOCK, '\n\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const richText = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const markup = /&lt;[a-z/]/i.test(value) ? decodeEntities(value) : value
  return cleanText(/<[a-z/][^>]*>/i.test(markup) ? htmlToText(markup) : decodeEntities(markup))
}

const cleanText = (value: string) => (value.trim() === '' ? undefined : value.trim())

export function readJsonValue(source: string, from: number): unknown {
  let start = from
  while (start < source.length && /\s/.test(source[start]!)) start++
  const open = source[start]
  if (open !== '[' && open !== '{') return undefined
  let depth = 0
  let inString = false
  for (let i = start; i < source.length; i++) {
    const char = source[i]
    if (inString) {
      if (char === '\\') i++
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '[' || char === '{') depth++
    else if (char === ']' || char === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])

function parseJsonLoosely(raw: string): unknown {
  const trimmed = raw.trim().replace(/^<!\[CDATA\[|\]\]>$/g, '')
  for (const candidate of [trimmed, trimmed.replace(/[\u0000-\u001f]+/g, ' ')]) {
    try {
      return JSON.parse(candidate)
    } catch {
      continue
    }
  }
  return undefined
}

function hasType(node: Json, type: string): boolean {
  return asArray(node['@type']).some((value) => value === type)
}

export function jsonLdPostings(html: string): Json[] {
  const postings: Json[] = []
  const visit = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(visit)
    else if (isRecord(node)) {
      if (hasType(node, 'JobPosting')) postings.push(node)
      if (node['@graph'] !== undefined) visit(node['@graph'])
    }
  }
  const scripts = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi
  for (const match of html.matchAll(scripts)) visit(parseJsonLoosely(match[1]!))
  return postings
}

const nameOf = (value: unknown): string | undefined =>
  cleanString(value) ?? (isRecord(value) ? cleanString(value.name) : undefined)

export function placeFields(place: Place, location?: string): PostingFields {
  const fields: PostingFields = {}
  if (location) fields.location = location
  if (place.city) fields.city = place.city
  if (place.state) fields.state = place.state
  if (place.country) fields.country = place.country
  return fields
}

export function addressFields(address: Json): PostingFields {
  const city = cleanString(address.addressLocality)
  const region = cleanString(address.addressRegion)
  const countryRaw = nameOf(address.addressCountry)
  const country = countryCode(countryRaw)
  const regionCode = region ? regionOf(region, country) : undefined
  const state = regionCode?.code ?? (region && country !== 'US' && country !== 'CA' ? region : undefined)
  const location = [city, region, countryRaw].filter(Boolean).join(', ') || undefined
  return placeFields({ city, state, country: country ?? regionCode?.country }, location)
}

const EMPLOYMENT_TYPES: Record<string, JobType> = {
  FULL_TIME: 'full_time', PART_TIME: 'part_time', CONTRACTOR: 'contract', TEMPORARY: 'temporary',
  INTERN: 'internship', PER_DIEM: 'temporary',
}

function employmentType(value: unknown): JobType | undefined {
  const types = new Set(asArray(value).map((item) =>
    EMPLOYMENT_TYPES[String(item).trim().toUpperCase().replace(/[\s-]+/g, '_')] ?? normalizeJobType(item)))
  types.delete(undefined)
  return types.size === 1 ? [...types][0] : undefined
}

function salaryFields(baseSalary: unknown): PostingFields {
  const salary = asArray(baseSalary).find(isRecord)
  if (!salary) return {}
  const value = salary.value
  const quantity = isRecord(value) ? value : { value }
  const min = finiteNumber(quantity.minValue) ?? finiteNumber(quantity.value)
  const max = finiteNumber(quantity.maxValue) ?? finiteNumber(quantity.value)
  if (min === undefined && max === undefined) return {}
  const fields: PostingFields = {}
  if (min !== undefined) fields.pay_min = min
  if (max !== undefined) fields.pay_max = max
  const period = normalizePayPeriod(String(quantity.unitText ?? salary.unitText ?? '').toLowerCase())
  if (period) fields.pay_period = period
  const currency = normalizeCurrency(salary.currency ?? quantity.currency)
  if (currency) fields.currency = currency
  return fields
}

export function jsonLdFields(posting: Json): PostingFields {
  const fields: PostingFields = {}
  const set = <K extends keyof PostingFields>(field: K, value: PostingFields[K] | undefined) => {
    if (value !== undefined) fields[field] = value
  }
  set('title', cleanString(posting.title))
  set('company', nameOf(posting.hiringOrganization))
  const address = asArray(posting.jobLocation).filter(isRecord)
    .map((location) => (isRecord(location.address) ? location.address : location)).find((item) => item.addressLocality || item.addressCountry || item.addressRegion)
  if (address) Object.assign(fields, addressFields(address))
  if (asArray(posting.jobLocationType).some((type) => String(type).toUpperCase() === 'TELECOMMUTE')) {
    fields.work_mode = 'remote'
    if (fields.country === undefined) set('country', countryCode(asArray(posting.applicantLocationRequirements).map(nameOf).find(Boolean)))
  }
  set('job_type', employmentType(posting.employmentType))
  Object.assign(fields, salaryFields(posting.baseSalary))
  set('posted_at', normalizeMoment(posting.datePosted))
  set('closed_at', normalizeMoment(posting.validThrough))
  set('description', richText(posting.description))
  const experience = asArray(posting.experienceRequirements).find(isRecord)
  const months = finiteNumber(experience?.monthsOfExperience)
  if (months !== undefined) fields.min_experience_years = Math.round((months / 12) * 10) / 10
  const education = asArray(posting.educationRequirements)[0]
  set('education_level', cleanString(education) ?? (isRecord(education) ? cleanString(education.credentialCategory) : undefined))
  set('skills', normalizeSkills(posting.skills))
  return fields
}

function attributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs[match[1]!.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attrs
}

export function metaTags(html: string): Record<string, string> {
  const tags: Record<string, string> = {}
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0])
    const name = (attrs.property ?? attrs.name)?.toLowerCase()
    if (name && attrs.content !== undefined && tags[name] === undefined) tags[name] = attrs.content.trim()
  }
  return tags
}

const SITE_SUFFIX = /\s+(?:careers?|jobs?|job board|careers page|hiring)$/i

export function splitTitle(raw: string): { title?: string; company?: string } {
  const text = raw.replace(/\s+/g, ' ').trim()
  const at = /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(text)
  const parts = at ? [at[1]!, at[2]!] : text.split(/\s+[-|–—]\s+/)
  const title = cleanString(parts[0])
  const company = cleanString(parts[1]?.replace(SITE_SUFFIX, ''))
  return parts.length >= 2 ? { title, company } : { title }
}

export function metaFields(html: string): PostingFields {
  const meta = metaTags(html)
  const fields: PostingFields = {}
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1]
  for (const raw of [meta['og:title'], titleTag && decodeEntities(titleTag)]) {
    if (!raw) continue
    const split = splitTitle(raw)
    if (fields.title === undefined && split.title) fields.title = split.title
    if (fields.company === undefined && split.company) fields.company = split.company
  }
  const site = cleanString(meta['og:site_name'])
  if (fields.company === undefined && site) fields.company = site
  return fields
}

export interface SiteRead {
  fields: PostingFields
  text?: string
}

const payFields = (text: string): PostingFields => {
  const pay = extractPay(text)?.value
  if (!pay) return {}
  const fields: PostingFields = {}
  if (pay.min !== undefined) fields.pay_min = pay.min
  if (pay.max !== undefined) fields.pay_max = pay.max
  if (pay.period) fields.pay_period = pay.period
  if (pay.currency) fields.currency = pay.currency
  return fields
}

export function metaCareersRead(html: string): SiteRead | undefined {
  const key = '"public_compensation":'
  const at = html.indexOf(key)
  const entries = at < 0 ? [] : asArray(readJsonValue(html, at + key.length)).filter(isRecord)
  entries.sort((a, b) => Number(a.country_code !== 'US') - Number(b.country_code !== 'US'))
  for (const entry of entries) {
    const low = cleanString(entry.compensation_amount_minimum)
    const high = cleanString(entry.compensation_amount_maximum)
    const pay = low && high ? payFields(`${low} - ${high}`) : {}
    if (pay.pay_min !== undefined) return { fields: { company: 'Meta', ...pay } }
  }
  return undefined
}

function appleJobs(html: string): Json | undefined {
  const match = /window\.__staticRouterHydrationData\s*=\s*JSON\.parse\(("(?:[^"\\]|\\.)*")\)/.exec(html)
  if (!match) return undefined
  try {
    const data: unknown = JSON.parse(JSON.parse(match[1]!) as string)
    const jobs = isRecord(data) && isRecord(data.loaderData) && isRecord(data.loaderData.jobDetails)
      ? data.loaderData.jobDetails.jobsData : undefined
    return isRecord(jobs) ? jobs : undefined
  } catch {
    return undefined
  }
}

export function appleRead(html: string): SiteRead | undefined {
  const jobs = appleJobs(html)
  if (!jobs) return undefined
  const footers = asArray(jobs.postingFooters).filter(isRecord).flatMap((footer) =>
    Object.values(isRecord(footer.localizations) ? footer.localizations : {}).flatMap(asArray).filter(isRecord)
      .map((entry) => richText(entry.content)).filter((text): text is string => text !== undefined))
  const fields: PostingFields = { company: 'Apple' }
  const title = cleanString(jobs.postingTitle)
  if (title) fields.title = title
  const location = asArray(jobs.locations).find(isRecord)
  if (location) {
    const city = cleanString(location.city) ?? cleanString(location.name)
    const region = cleanString(location.stateProvince)
    const country = cleanString(location.countryName)
    Object.assign(fields, placeFields(parseLocation([city, region, country].filter(Boolean).join(', ')),
      [city, region, country].filter(Boolean).join(', ') || undefined))
  }
  const posted = typeof jobs.postingDateMeta === 'string' ? normalizeMoment(jobs.postingDateMeta) : undefined
  if (posted) fields.posted_at = posted
  if (jobs.homeOffice === true) fields.work_mode = 'remote'
  const pay = footers.map(payFields).find((found) => found.pay_min !== undefined || found.pay_max !== undefined)
  if (pay) Object.assign(fields, pay)
  const sections = [jobs.jobSummary, jobs.description, jobs.minimumQualifications, jobs.preferredQualifications]
    .map(richText).filter((text): text is string => text !== undefined)
  const text = [...sections, ...footers.slice(0, 1)].join('\n\n')
  if (text) fields.description = text
  return { fields, text: text || undefined }
}

export function microsoftRead(position: Json): SiteRead | undefined {
  const title = cleanString(position.posting_name) ?? cleanString(position.name)
  if (!title) return undefined
  const fields: PostingFields = { title, company: 'Microsoft' }
  const locations = asArray(position.locations).map(cleanString).filter((item): item is string => item !== undefined)
  const location = locations.join('; ') || cleanString(position.location)
  if (location) Object.assign(fields, placeFields(parseLocation(location), location))
  const mode = normalizeWorkMode(position.work_location_option ?? position.workLocationOption)
  if (mode) fields.work_mode = mode
  const posted = normalizeMoment(position.t_create)
  if (posted) fields.posted_at = posted
  const text = richText(position.job_description)
  if (text) fields.description = text
  return { fields, text }
}

function microsoftPageRead(html: string, url: URL): SiteRead | undefined {
  const match = /<code\b[^>]*id\s*=\s*["']smartApplyData["'][^>]*>([\s\S]*?)<\/code\s*>/i.exec(html)
  const data = match ? parseJsonLoosely(decodeEntities(match[1]!)) : undefined
  if (!isRecord(data)) return undefined
  const id = /\/job\/(\d+)/.exec(url.pathname)?.[1]
  const positions = asArray(data.positions).filter(isRecord)
  const position = positions.find((item) => String(item.id) === id) ?? positions[0] ?? data
  return microsoftRead(position)
}

export function embeddedRead(url: string, html: string): SiteRead | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const host = parsed.hostname.toLowerCase()
  if (host === 'metacareers.com' || host.endsWith('.metacareers.com')) return metaCareersRead(html)
  if (host === 'jobs.apple.com') return appleRead(html)
  if (host.endsWith('careers.microsoft.com')) return microsoftPageRead(html, parsed)
  return undefined
}

export interface PageRead {
  fields: PostingFields
  text: string
  visible: string
  structured: boolean
}

export function pageRead(url: string, html: string): PageRead {
  const visible = htmlToText(html)
  const fields: PostingFields = {}
  const texts = [visible]
  const embedded = embeddedRead(url, html)
  if (embedded) {
    fillFields(fields, embedded.fields)
    if (embedded.text) texts.push(embedded.text)
  }
  const posting = jsonLdPostings(html)[0]
  const structured = posting !== undefined || embedded !== undefined
  if (posting) {
    const ld = jsonLdFields(posting)
    fillFields(fields, ld)
    if (ld.description) texts.push(ld.description)
  }
  fillFields(fields, metaFields(html))
  const text = texts.reduce((longest, item) => (item.length > longest.length ? item : longest), '')
  if (fields.description === undefined && text) fields.description = text
  return { fields, text, visible, structured }
}
