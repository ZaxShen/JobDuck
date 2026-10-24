import {
  cleanString, finiteNumber, NUMBER_FIELDS, normalizeCurrency, normalizeJobType, normalizeMoment,
  normalizePayPeriod, normalizeRequirements, normalizeSeniority, normalizeSkills, normalizeWorkMode, POSTING_FIELDS,
  type PostingField, type PostingFields, STATE_COUNTRIES,
} from './fields'
import { countryCode, regionOf } from './places'
import { normalizeForScan } from './text'

export interface AgentProposal {
  field: string
  value: unknown
  quote: string
}

export interface AcceptedProposal {
  field: PostingField
  value: NonNullable<PostingFields[PostingField]>
  quote: string
}

export interface RejectedProposal {
  proposal: AgentProposal
  reason: string
}

export interface Evidence {
  accepted: AcceptedProposal[]
  rejected: RejectedProposal[]
}

export const collapse = (text: string) => normalizeForScan(text).replace(/\s+/g, ' ').trim().toLowerCase()

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b))

export function quoteHasNumber(quote: string, value: number): boolean {
  for (const match of quote.matchAll(/(\d[\d,.]*)(\s?[kK](?![A-Za-z]))?/g)) {
    const raw = match[1]!.replace(/[.,]+$/, '')
    const readings = [
      Number(raw.replace(/,/g, '')),
      Number(raw.replace(/[.,]/g, '')),
      Number(raw.replace(/\./g, '').replace(',', '.')),
    ]
    const scale = match[2] ? 1000 : 1
    if (readings.some((reading) => Number.isFinite(reading) && close(reading * scale, value))) return true
  }
  return false
}

const isField = (field: string): field is PostingField => (POSTING_FIELDS as readonly string[]).includes(field)

function normalizeValue(field: PostingField, value: unknown, context: PostingFields): AcceptedProposal['value'] | undefined {
  switch (field) {
    case 'country': return countryCode(value)
    case 'state': {
      const name = cleanString(value)
      if (!name) return undefined
      const region = regionOf(name, context.country)
      if (region) return region.code
      return context.country !== undefined && !STATE_COUNTRIES.includes(context.country) ? name : undefined
    }
    case 'work_mode': return normalizeWorkMode(value)
    case 'job_type': return normalizeJobType(value)
    case 'seniority': return normalizeSeniority(value)
    case 'pay_period': return normalizePayPeriod(value)
    case 'currency': return normalizeCurrency(value)
    case 'posted_at':
    case 'closed_at': return normalizeMoment(value)
    case 'min_experience_years':
    case 'pay_min':
    case 'pay_max': {
      const number = finiteNumber(value)
      return number !== undefined && number >= 0 ? number : undefined
    }
    case 'skills': return normalizeSkills(value)
    case 'requirements': return normalizeRequirements(value)
    case 'requires_clearance': return typeof value === 'boolean' ? value : undefined
    case 'description': return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
    default: return cleanString(value)
  }
}

const hasPay = (fields: PostingFields) => fields.pay_min !== undefined || fields.pay_max !== undefined

export function acceptAgentFields(text: string, proposals: AgentProposal[], existing: PostingFields = {}): Evidence {
  const haystack = collapse(text)
  const context: PostingFields = { ...existing }
  const priorPay = hasPay(existing)
  const accepted: AcceptedProposal[] = []
  const rejected: RejectedProposal[] = []
  const reject = (proposal: AgentProposal, reason: string) => rejected.push({ proposal, reason })
  const ordered = [...proposals].sort((a, b) => Number(b.field === 'country') - Number(a.field === 'country'))
  for (const proposal of ordered) {
    const { field, value, quote } = proposal
    if (!isField(field)) { reject(proposal, `unknown field ${field}`); continue }
    if (context[field] !== undefined || ((field === 'pay_min' || field === 'pay_max') && priorPay)) {
      reject(proposal, `${field} is already set by an earlier layer`)
      continue
    }
    const needle = typeof quote === 'string' ? collapse(quote) : ''
    if (needle === '') { reject(proposal, 'quote is empty'); continue }
    if (!haystack.includes(needle)) { reject(proposal, 'quote not found in posting text'); continue }
    const normalized = normalizeValue(field, value, context)
    if (normalized === undefined) { reject(proposal, `invalid value for ${field}`); continue }
    if ((NUMBER_FIELDS as readonly string[]).includes(field) && !quoteHasNumber(quote, normalized as number)) {
      reject(proposal, `quote does not contain ${String(normalized)}`)
      continue
    }
    Object.assign(context, { [field]: normalized })
    accepted.push({ field, value: normalized, quote })
  }
  return { accepted, rejected }
}
