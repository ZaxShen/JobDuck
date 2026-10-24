export const WORK_MODES = ['remote', 'hybrid', 'onsite'] as const
export const JOB_TYPES = ['full_time', 'part_time', 'contract', 'internship', 'temporary'] as const
export const SENIORITIES = [
  'intern', 'entry', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'executive',
] as const
export const PAY_PERIODS = ['year', 'month', 'week', 'day', 'hour'] as const
export const REQUIREMENT_PRIORITIES = ['required', 'preferred'] as const

export type WorkMode = (typeof WORK_MODES)[number]
export type JobType = (typeof JOB_TYPES)[number]
export type Seniority = (typeof SENIORITIES)[number]
export type PayPeriod = (typeof PAY_PERIODS)[number]
export type RequirementPriority = (typeof REQUIREMENT_PRIORITIES)[number]

export interface Requirement {
  text: string
  priority: RequirementPriority
}

export interface PostingFields {
  title?: string
  company?: string
  location?: string
  country?: string
  state?: string
  city?: string
  work_mode?: WorkMode
  job_type?: JobType
  seniority?: Seniority
  education_level?: string
  min_experience_years?: number
  posted_at?: string
  closed_at?: string
  pay_min?: number
  pay_max?: number
  pay_period?: PayPeriod
  currency?: string
  description?: string
  summary?: string
  skills?: string[]
  requirements?: Requirement[]
  requires_clearance?: boolean
}

export type PostingField = keyof PostingFields
export const FIELD_SOURCES = ['user', 'freehire', 'ats', 'page', 'text', 'agent'] as const
export type FieldSource = (typeof FIELD_SOURCES)[number]
export type FieldSources = Partial<Record<PostingField, FieldSource>>

export const ranksAtLeast = (source: FieldSource, stored: FieldSource) =>
  FIELD_SOURCES.indexOf(source) <= FIELD_SOURCES.indexOf(stored)
export type CoreField = 'country' | 'state' | 'city' | 'work_mode' | 'pay'

export const POSTING_FIELDS = [
  'title', 'company', 'location', 'country', 'state', 'city', 'work_mode', 'job_type', 'seniority',
  'education_level', 'min_experience_years', 'posted_at', 'closed_at', 'pay_min', 'pay_max', 'pay_period',
  'currency', 'description', 'summary', 'skills', 'requirements', 'requires_clearance',
] as const satisfies readonly PostingField[]

export const NUMBER_FIELDS = ['min_experience_years', 'pay_min', 'pay_max'] as const satisfies readonly PostingField[]
export const PAY_FIELDS = ['pay_min', 'pay_max', 'pay_period', 'currency'] as const satisfies readonly PostingField[]

export const STATE_COUNTRIES = ['US', 'CA']

export function missingCore(fields: PostingFields): CoreField[] {
  const missing: CoreField[] = []
  if (fields.country === undefined) missing.push('country')
  if (fields.country !== undefined && STATE_COUNTRIES.includes(fields.country) && fields.state === undefined) {
    missing.push('state')
  }
  if (fields.city === undefined) missing.push('city')
  if (fields.work_mode === undefined) missing.push('work_mode')
  if (fields.pay_min === undefined && fields.pay_max === undefined) missing.push('pay')
  return missing
}

export const cleanString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().replace(/\s+/g, ' ') : undefined

export const finiteNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(value)) return Number(value)
  return undefined
}

const key = (value: unknown) =>
  typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s_-]+/g, ' ') : ''

const WORK_MODE_ALIASES: Record<string, WorkMode> = {
  remote: 'remote', 'fully remote': 'remote', telecommute: 'remote', 'work from home': 'remote',
  hybrid: 'hybrid', flexible: 'hybrid',
  onsite: 'onsite', 'on site': 'onsite', 'in office': 'onsite', office: 'onsite', 'in person': 'onsite',
}

const JOB_TYPE_ALIASES: Record<string, JobType> = {
  'full time': 'full_time', fulltime: 'full_time', permanent: 'full_time', regular: 'full_time',
  'part time': 'part_time', parttime: 'part_time',
  contract: 'contract', contractor: 'contract', freelance: 'contract', 'contract to hire': 'contract',
  intern: 'internship', internship: 'internship',
  temporary: 'temporary', temp: 'temporary', seasonal: 'temporary',
}

const SENIORITY_ALIASES: Record<string, Seniority> = {
  internship: 'intern', junior: 'entry', 'entry level': 'entry', graduate: 'entry', associate: 'entry',
  'new grad': 'entry', middle: 'mid', 'mid level': 'mid', intermediate: 'mid', 'mid senior level': 'mid',
  sr: 'senior', 'tech lead': 'lead', 'team lead': 'lead', head: 'director', vp: 'executive', 'c level': 'executive',
}

const PAY_PERIOD_ALIASES: Record<string, PayPeriod> = {
  yearly: 'year', annual: 'year', annually: 'year', annum: 'year', yr: 'year', years: 'year',
  monthly: 'month', mo: 'month', months: 'month',
  weekly: 'week', wk: 'week', weeks: 'week',
  daily: 'day', days: 'day',
  hourly: 'hour', hr: 'hour', hrs: 'hour', hours: 'hour', h: 'hour',
}

function fromList<T extends string>(list: readonly T[], aliases: Record<string, T>, value: unknown): T | undefined {
  const normalized = key(value)
  const direct = list.find((item) => item.replace(/_/g, ' ') === normalized)
  return direct ?? aliases[normalized]
}

export const normalizeWorkMode = (value: unknown) => fromList(WORK_MODES, WORK_MODE_ALIASES, value)
export const normalizeJobType = (value: unknown) => fromList(JOB_TYPES, JOB_TYPE_ALIASES, value)
export const normalizeSeniority = (value: unknown) => fromList(SENIORITIES, SENIORITY_ALIASES, value)
export const normalizePayPeriod = (value: unknown) => fromList(PAY_PERIODS, PAY_PERIOD_ALIASES, value)

export function normalizeCurrency(value: unknown): string | undefined {
  return typeof value === 'string' && /^\s*[A-Za-z]{3}\s*$/.test(value) ? value.trim().toUpperCase() : undefined
}

export function normalizeMoment(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value
    return new Date(ms).toISOString()
  }
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return Number.isNaN(Date.parse(trimmed)) ? undefined : trimmed
  if (!/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return undefined
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

export function normalizePriority(value: unknown): RequirementPriority {
  return /nice|prefer|bonus|plus|optional|desired/i.test(String(value ?? '')) ? 'preferred' : 'required'
}

export function normalizeRequirements(value: unknown): Requirement[] | undefined {
  if (!Array.isArray(value)) return undefined
  const requirements = value.flatMap((item): Requirement[] => {
    if (typeof item === 'string') return cleanString(item) ? [{ text: cleanString(item)!, priority: 'required' }] : []
    if (item === null || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const text = cleanString(record.text ?? record.requirement ?? record.description)
    return text ? [{ text, priority: normalizePriority(record.priority ?? record.type ?? record.level) }] : []
  })
  return requirements.length > 0 ? requirements : undefined
}

export function normalizeSkills(value: unknown): string[] | undefined {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\s*,\s*/) : []
  const skills = [...new Set(items.map(cleanString).filter((skill): skill is string => skill !== undefined))]
  return skills.length > 0 ? skills : undefined
}

const PLACE_FIELDS: readonly PostingField[] = ['location', 'city', 'state']

export function fillFields(target: PostingFields, layer: PostingFields): PostingField[] {
  const filled: PostingField[] = []
  const hadPay = target.pay_min !== undefined || target.pay_max !== undefined
  const samePay = layer.pay_min === target.pay_min && layer.pay_max === target.pay_max
  const placeConflict = target.country !== undefined && layer.country !== undefined && target.country !== layer.country
  for (const field of POSTING_FIELDS) {
    const value = layer[field]
    if (value === undefined || target[field] !== undefined) continue
    if ((field === 'pay_min' || field === 'pay_max') && hadPay) continue
    if ((field === 'pay_period' || field === 'currency') && hadPay && !samePay) continue
    if (PLACE_FIELDS.includes(field) && placeConflict) continue
    Object.assign(target, { [field]: value })
    filled.push(field)
  }
  return filled
}
