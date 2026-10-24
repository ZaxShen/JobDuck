import {
  type JobType, normalizeJobType, normalizePayPeriod, normalizeWorkMode, type PayPeriod, type PostingFields,
  type Seniority, type WorkMode,
} from './fields'
import { countryCode, isCountryName, regionOf } from './places'

export interface Span<T> {
  value: T
  start: number
  end: number
}

export interface Pay {
  min?: number
  max?: number
  period?: PayPeriod
  currency?: string
}

export interface Place {
  city?: string
  state?: string
  country?: string
}

const CODES = 'USD|CAD|EUR|GBP|AUD|NZD|CHF|SGD'
const SYMBOLS = 'US\\$|CA\\$|C\\$|AU\\$|A\\$|\\$|€|£'
const AMOUNT = '\\d{1,3}(?:[,.]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:\\.\\d+)?'
const MONEY = new RegExp(
  `(?<![A-Za-z0-9])(?:(?<code1>${CODES})\\s?)?(?<symbol>${SYMBOLS})?\\s?(?<amount>${AMOUNT})(?![\\d,.]*\\d)` +
    `(?<k>\\s?[kK](?![A-Za-z]))?(?!\\s?(?:[mMbB]\\b|million|billion|mm\\b|bn\\b|%))(?:\\s?(?<code2>${CODES})\\b)?`,
  'gi',
)
const RANGE_GAP = /^\s*(?:(?:\/|per\s+)\s*[a-z]+\s*)?(?:-|to|and)\s*$/i
const UNIT = 'hour|hr|h|year|yr|annum|month|mo|week|wk|day'
const PERIOD_AFTER = new RegExp(
  `^\\s*,?\\s*(?:(?:\\/\\s*|per\\s+|an?\\s+|each\\s+)(${UNIT})\\b|(hourly|annually|yearly|annual|monthly|weekly|daily)\\b)`,
  'i',
)
const PERIOD_GAP = new RegExp(`(?:\\/\\s*|per\\s+)(${UNIT})\\b`, 'i')
const PERIOD_BEFORE = /\b(annual(?:ly)?|yearly|per year|hourly|per hour|monthly|per month|weekly|per week|daily|per day)\b/gi
const PAY_WORD = /\b(?:salary|salaries|pay|compensation|wages?|rate|base|ote|earn(?:ings)?|remuneration)\b/i
const NON_PAY = /\b(?:bonus(?:es)?|stipends?|reimburse\w*|allowances?|budgets?|relocation|401\s?\(?k\)?|equity|stock|rsus?|funding|raised|revenue|valuation|arr|customers|users|donat\w*|tuition|insurance|deductibles?|referral|sign[- ]?on|signing|commissions?|price|pricing|costs?|fees?|investors?|series [a-f])\b/i
const UP_TO = /\b(?:up to|maximum of|max(?:imum)?:?)\s*$/i
const AT_LEAST = /\b(?:starting (?:at|from)|from|at least|minimum of|min(?:imum)?:?)\s*$/i
const SENTENCE_START = /[.;!?•\n](?=[^.;!?•\n]*$)/
const CLAUSE_END = /[.;!?•\n,(]|\s(?:plus|and|with)\b|\+/

const PERIOD_BOUNDS: Record<PayPeriod, [number, number]> = {
  year: [10_000, 5_000_000], month: [500, 1_000_000], week: [100, 100_000], day: [30, 20_000], hour: [5, 2_000],
}

interface Money {
  start: number
  end: number
  value: number
  currency?: string
  hasK: boolean
  bare: boolean
}

const SYMBOL_CURRENCY: Record<string, string> = {
  'US$': 'USD', 'CA$': 'CAD', C$: 'CAD', 'AU$': 'AUD', A$: 'AUD', '€': 'EUR', '£': 'GBP',
}
const DOLLAR_BY_COUNTRY: Record<string, string> = { CA: 'CAD', AU: 'AUD', NZ: 'NZD', SG: 'SGD' }

export function normalizeForScan(text: string): string {
  return text.replace(/[‐‑‒–—―−]/g, '-').replace(/[   ]/g, ' ')
}

function parseAmount(raw: string): number {
  const grouped = /^(\d{1,3}(?:[,.]\d{3})+)(?:[.,](\d{1,2}))?$/.exec(raw)
  if (grouped) return Number(`${grouped[1]!.replace(/[,.]/g, '')}${grouped[2] ? `.${grouped[2]}` : ''}`)
  return Number(raw)
}

function moneyTokens(text: string, country?: string): Money[] {
  const tokens: Money[] = []
  for (const match of text.matchAll(MONEY)) {
    const groups = match.groups ?? {}
    const raw = match[0]
    const start = match.index + raw.length - raw.trimStart().length
    const hasK = groups.k !== undefined
    const code = (groups.code1 ?? groups.code2)?.toUpperCase()
    const symbol = groups.symbol?.toUpperCase()
    const currency = code ?? (symbol === undefined ? undefined
      : symbol === '$' ? (country ? DOLLAR_BY_COUNTRY[country] : undefined) ?? 'USD'
      : SYMBOL_CURRENCY[symbol])
    const value = parseAmount(groups.amount!) * (hasK ? 1000 : 1)
    tokens.push({ start, end: match.index + raw.trimEnd().length, value, currency, hasK, bare: code === undefined && symbol === undefined })
  }
  return tokens
}

interface Candidate {
  start: number
  end: number
  low: number
  high: number
  single: boolean
  currency?: string
  gap: string
}

function candidates(text: string, tokens: Money[]): Candidate[] {
  const found: Candidate[] = []
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i]!
    const b = tokens[i + 1]
    const gap = b ? text.slice(a.end, b.start) : ''
    if (b && RANGE_GAP.test(gap) && (!a.bare || !b.bare || (a.hasK && b.hasK))) {
      const low = !a.hasK && b.hasK && a.value < 1000 ? a.value * 1000 : a.value
      if (low <= b.value) {
        found.push({ start: a.start, end: b.end, low, high: b.value, single: false, currency: a.currency ?? b.currency, gap })
        i++
        continue
      }
    }
    if (!a.bare) found.push({ start: a.start, end: a.end, low: a.value, high: a.value, single: true, currency: a.currency, gap: '' })
  }
  return found
}

function periodNear(text: string, candidate: Candidate, before: string): PayPeriod | undefined {
  const after = PERIOD_AFTER.exec(text.slice(candidate.end, candidate.end + 30))
  if (after) return normalizePayPeriod(after[1] ?? after[2])
  const gap = PERIOD_GAP.exec(candidate.gap)
  if (gap) return normalizePayPeriod(gap[1])
  const mentions = [...before.matchAll(PERIOD_BEFORE)]
  const last = mentions.at(-1)?.[1]?.toLowerCase().replace(/^per /, '')
  return last ? normalizePayPeriod(last) : undefined
}

function clauseBefore(text: string, start: number): string {
  const window = text.slice(Math.max(0, start - 100), start)
  const boundary = SENTENCE_START.exec(window)
  return boundary ? window.slice(boundary.index + 1) : window
}

function clauseAfter(text: string, end: number): string {
  const window = text.slice(end, end + 40)
  const boundary = CLAUSE_END.exec(window)
  return boundary ? window.slice(0, boundary.index) : window
}

function lastIndex(pattern: RegExp, text: string): number {
  const global = new RegExp(pattern.source, 'gi')
  let index = -1
  for (const match of text.matchAll(global)) index = match.index
  return index
}

export function extractPay(text: string, hint: { country?: string } = {}): Span<Pay> | undefined {
  const scan = normalizeForScan(text)
  let best: { span: Span<Pay>; score: number } | undefined
  for (const candidate of candidates(scan, moneyTokens(scan, hint.country))) {
    const before = clauseBefore(scan, candidate.start)
    const after = clauseAfter(scan, candidate.end)
    if (NON_PAY.test(after) || lastIndex(NON_PAY, before) > lastIndex(PAY_WORD, before)) continue
    const payContext = PAY_WORD.test(before) || PAY_WORD.test(after)
    const stated = periodNear(scan, candidate, before)
    const period = stated ?? (candidate.high >= 10_000 ? 'year'
      : candidate.high <= 500 && (payContext || !candidate.single) ? 'hour' : undefined)
    if (period === undefined) continue
    const [floor, ceiling] = PERIOD_BOUNDS[period]
    if (candidate.low < floor || candidate.high > ceiling) continue
    const pay: Pay = { period }
    if (candidate.currency) pay.currency = candidate.currency
    if (candidate.single && UP_TO.test(before)) pay.max = candidate.high
    else if (candidate.single && AT_LEAST.test(before)) pay.min = candidate.low
    else Object.assign(pay, { min: candidate.low, max: candidate.high })
    const score = (candidate.single ? 0 : 4) + (payContext ? 2 : 0) + (stated ? 1 : 0) + (candidate.currency ? 1 : 0)
    if (!best || score > best.score) best = { span: { value: pay, start: candidate.start, end: candidate.end }, score }
  }
  return best?.span
}

function firstMatch<T>(text: string, rules: [RegExp, T][]): Span<T> | undefined {
  let best: Span<T> | undefined
  for (const [pattern, value] of rules) {
    const match = pattern.exec(text)
    if (match && (!best || match.index < best.start)) best = { value, start: match.index, end: match.index + match[0].length }
  }
  return best
}

function labelled<T>(text: string, label: RegExp, normalize: (value: string) => T | undefined): Span<T> | undefined {
  const match = label.exec(text)
  if (!match) return undefined
  const value = normalize(match[1]!)
  return value === undefined ? undefined : { value, start: match.index, end: match.index + match[0].length }
}

const WORK_MODE_LABEL = /^[ \t]*(?:work(?:place)?[ \t]*(?:type|mode|model|arrangement|location|style)|location[ \t]*type|remote[ \t]*status)[ \t]*[:-][ \t]*(.+)$/im
const HYBRID = /\bhybrid\b(?=[\s,.:()-]*(?:role|position|work|working|schedule|arrangement|model|setup|opportunity|basis|environment|$))|\(hybrid\)|\bhybrid\s*[-:|]|[-|]\s*hybrid\b|\b(?:is|be) hybrid\b|\b\d\s*(?:-\s*\d\s*)?days? (?:a|per) week (?:in|at) (?:the|our|an?) office\b/im
const REMOTE = /\b(?:fully|100%|completely) remote\b|(?<!\b(?:not|no|non)[ -](?:a )?)\bremote[- ](?:first|friendly|role|position|job|opportunity|eligible|option)\b|\b(?:is|be) (?:a )?(?:fully )?remote\b|\(remote\)|\bwork (?:from home|remotely)\b|^[ \t]*remote\b|\bremote\s*[-(,|:]\s*(?:us|usa|united states|canada|uk|europe|emea|anywhere|worldwide)\b|[-|]\s*remote\b/im
const ONSITE = /\bon[- ]?site\b(?!\s+interviews?)|\bin[- ]office\b|\bin[- ]person\b(?!\s+interviews?)|\bnot (?:a )?remote\b/im

function workModeIn(value: string): WorkMode | undefined {
  return normalizeWorkMode(value.split(/[,(;|]/)[0]) ?? firstMatch(value, [
    [/\bhybrid\b/i, 'hybrid' as const], [/\bremote\b/i, 'remote' as const], [/\bon[- ]?site|in[- ]office\b/i, 'onsite' as const],
  ])?.value
}

export function extractWorkMode(text: string): Span<WorkMode> | undefined {
  const scan = normalizeForScan(text)
  const label = labelled(scan, WORK_MODE_LABEL, workModeIn)
  if (label) return label
  for (const [pattern, value] of [[HYBRID, 'hybrid'], [REMOTE, 'remote'], [ONSITE, 'onsite']] as const) {
    const match = pattern.exec(scan)
    if (match) return { value, start: match.index, end: match.index + match[0].length }
  }
  return undefined
}

const JOB_TYPE_LABEL = /^[ \t]*(?:employment|job|position|contract|work)[ \t]*type[ \t]*[:-][ \t]*(.+)$/im
const JOB_TYPE_RULES: [RegExp, JobType][] = [
  [/\bfull[- ]?time\b/i, 'full_time'],
  [/\bpart[- ]?time\b/i, 'part_time'],
  [/\binternship\b|\bintern\b(?!al|ation)/i, 'internship'],
  [/\b(?:contract(?:or)?|contract[- ]to[- ]hire|1099|c2c|freelance) (?:role|position|basis|assignment|engagement|opportunity)\b|\b(?:w-?2|1099|fixed[- ]term) contract\b|\bcontractor\b/i, 'contract'],
  [/\btemporary (?:role|position|assignment|basis)\b|\bseasonal\b/i, 'temporary'],
]

export function extractJobType(text: string): Span<JobType> | undefined {
  const scan = normalizeForScan(text)
  return labelled(scan, JOB_TYPE_LABEL, (value) =>
    normalizeJobType(value.split(/[,(;|]/)[0]) ?? firstMatch(value, JOB_TYPE_RULES)?.value) ?? firstMatch(scan, JOB_TYPE_RULES)
}

export function jobTypeFromTitle(title: string): Span<JobType> | undefined {
  return firstMatch(normalizeForScan(title), [
    [/\bintern(?:ship)?\b/i, 'internship'], [/\bcontract(?:or)?\b/i, 'contract'],
    [/\bpart[- ]?time\b/i, 'part_time'], [/\b(?:temporary|seasonal|temp)\b/i, 'temporary'],
  ])
}

const TITLE_WORK_MODE = /\((remote|hybrid|on[- ]?site)\b[^)]*\)|[-|,]\s*(remote|hybrid|on[- ]?site)\b/i

export function workModeFromTitle(title: string): Span<WorkMode> | undefined {
  const match = TITLE_WORK_MODE.exec(normalizeForScan(title))
  const value = match ? normalizeWorkMode(match[1] ?? match[2]) : undefined
  return match && value ? { value, start: match.index, end: match.index + match[0].length } : undefined
}

const SENIORITY_RULES: [RegExp, Seniority][] = [
  [/\bintern(?:ship)?\b/i, 'intern'],
  [/\b(?:chief|cto|ceo|cfo|coo|cio|ciso|vp|svp|evp|vice president|president)\b/i, 'executive'],
  [/\b(?:director|head of)\b/i, 'director'],
  [/(?<!\b(?:product|program|project|account|portfolio|success|community|partner|partnerships|channel|marketing|content|case|relationship|territory|sales)\s)\bmanager\b|\bmgr\b/i, 'manager'],
  [/\bprincipal\b/i, 'principal'],
  [/\bstaff\b/i, 'staff'],
  [/\b(?:lead|tech lead|team lead)\b/i, 'lead'],
  [/\b(?:senior|sr)\b|\b(?:iii|iv)\b/i, 'senior'],
  [/\b(?:mid[- ]level|intermediate)\b|\bii\b/i, 'mid'],
  [/\b(?:junior|jr|entry[- ]level|new grad(?:uate)?|graduate)\b|\bi$/i, 'entry'],
]

export function seniorityFromTitle(title: string): Span<Seniority> | undefined {
  for (const [pattern, value] of SENIORITY_RULES) {
    const match = pattern.exec(title)
    if (match) return { value, start: match.index, end: match.index + match[0].length }
  }
  return undefined
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15,
}
const EXPERIENCE = new RegExp(
  `\\b(\\d{1,2}|${Object.keys(NUMBER_WORDS).join('|')})\\s*\\+?\\s*(?:(?:-|to)\\s*\\d{1,2}\\s*\\+?\\s*)?` +
    `(?:years?|yrs?)(?:'s?)?(?:\\s+of)?(?:\\s+[\\w/+#.-]+){0,5}?\\s+(?:experience|exp)\\b`,
  'gi',
)

export function extractMinExperience(text: string): Span<number> | undefined {
  let best: Span<number> | undefined
  for (const match of normalizeForScan(text).matchAll(EXPERIENCE)) {
    const raw = match[1]!.toLowerCase()
    const value = NUMBER_WORDS[raw] ?? Number(raw)
    if (value > 40) continue
    if (!best || value < best.value) best = { value, start: match.index, end: match.index + match[0].length }
  }
  return best
}

const CLEARANCE = /\b(?:security clearance|ts\/sci|top secret|secret clearance|active clearance|clearance (?:is )?required|(?:hold|have|possess|obtain|maintain) (?:an? )?(?:active )?(?:\w+ )?clearance|polygraph)\b/i

export function extractClearance(text: string): Span<true> | undefined {
  const match = CLEARANCE.exec(text)
  return match ? { value: true, start: match.index, end: match.index + match[0].length } : undefined
}

const WORK_MODE_WORD = /^(?:remote|hybrid|on[- ]?site|in[- ]office|anywhere|worldwide|multiple locations)$/i
const LOCATION_PREFIX = /^(?:(?:fully )?remote|hybrid|on[- ]?site)\s*(?:[-:,/]\s*|\s+in\s+|\s+(?=[A-Z]))/i
const POSTAL_CODE = /\s+(?:\d{5}(?:-\d{4})?|[A-Z]\d[A-Z]\s?\d[A-Z]\d)$/i
const WORKDAY_LOCATION = /^(US|USA|CA|CAN)[- ]([A-Z]{2})[- ](.+)$/

const plausibleCity = (value: string | undefined) =>
  value !== undefined && value !== '' && value.length <= 60 && !/\d/.test(value) && !WORK_MODE_WORD.test(value)
    ? value : undefined

function place(city: string | undefined, state: string | undefined, country: string | undefined): Place {
  const result: Place = {}
  const cleanCity = plausibleCity(city)
  if (cleanCity) result.city = cleanCity
  if (state) result.state = state
  if (country) result.country = country
  return result
}

export function parseLocation(raw: string): Place {
  let line = normalizeForScan(raw).split(/\s*(?:;|\||\n|\s\/\s|\bor\b)\s*/)[0]!.trim()
  line = line.replace(/\((?:remote|hybrid|on[- ]?site)[^)]*\)/gi, '').replace(LOCATION_PREFIX, '')
    .replace(/\s*[-:|]\s*(?:fully )?(?:remote|hybrid|on[- ]?site)\s*$/i, '').trim()
  const workday = WORKDAY_LOCATION.exec(line)
  if (workday) {
    const country = countryCode(workday[1]!)!
    const region = regionOf(workday[2]!, country)
    return place(workday[3]!.trim(), region?.code, country)
  }
  const parts = line.split(',').map((part) => part.replace(POSTAL_CODE, '').trim())
    .filter((part) => part !== '' && !WORK_MODE_WORD.test(part))
  if (parts.length === 0) return {}
  if (parts.length === 1) {
    const only = parts[0]!
    if (isCountryName(only) || (/^[A-Z]{2}$/.test(only) && !regionOf(only))) return place(undefined, undefined, countryCode(only))
    const region = /^[A-Za-z]{2}$/.test(only) ? undefined : regionOf(only)
    return region ? place(undefined, region.code, region.country) : {}
  }
  const last = parts.at(-1)!
  let country: string | undefined
  if (isCountryName(last) || (parts.length >= 3 && /^[A-Z]{2}$/.test(last))) {
    country = countryCode(last)
    parts.pop()
  } else if (/^[A-Z]{2}$/.test(last) && !regionOf(last)) {
    country = countryCode(last)
    parts.pop()
  }
  if (country === undefined || country === 'US' || country === 'CA') {
    const region = regionOf(parts.at(-1)!, country)
    if (region) return place(parts.length >= 2 ? parts[0] : undefined, region.code, region.country)
    return place(parts[0], undefined, country)
  }
  return place(parts[0], parts.length >= 2 ? parts.at(-1) : undefined, country)
}

const LOCATION_LABEL = /^[ \t]*(?:job[ \t]+|office[ \t]+|work[ \t]+)?locations?[ \t]*[:-][ \t]*(.+)$/im

export function extractLocation(text: string): Span<Place & { location: string }> | undefined {
  const match = LOCATION_LABEL.exec(normalizeForScan(text))
  if (!match) return undefined
  const location = match[1]!.trim()
  return { value: { ...parseLocation(location), location }, start: match.index, end: match.index + match[0].length }
}

export const MIN_TEXT = 200

export function textFields(text: string, context: { title?: string; country?: string } = {}): PostingFields {
  const fields: PostingFields = {}
  const located = extractLocation(text)?.value
  if (located) Object.assign(fields, located)
  const pay = extractPay(text, { country: context.country ?? fields.country })?.value
  if (pay) {
    if (pay.min !== undefined) fields.pay_min = pay.min
    if (pay.max !== undefined) fields.pay_max = pay.max
    if (pay.period) fields.pay_period = pay.period
    if (pay.currency) fields.currency = pay.currency
  }
  const workMode = (context.title ? workModeFromTitle(context.title) : undefined) ?? extractWorkMode(text)
  if (workMode) fields.work_mode = workMode.value
  const jobType = (context.title ? jobTypeFromTitle(context.title) : undefined) ?? extractJobType(text)
  if (jobType) fields.job_type = jobType.value
  const seniority = context.title ? seniorityFromTitle(context.title) : undefined
  if (seniority) fields.seniority = seniority.value
  const experience = extractMinExperience(text)
  if (experience) fields.min_experience_years = experience.value
  if (extractClearance(text)) fields.requires_clearance = true
  return fields
}
