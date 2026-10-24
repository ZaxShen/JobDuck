import {
  type FieldSource, FIELD_SOURCES, type FieldSources, PAY_FIELDS, POSTING_FIELDS, type PostingField, type PostingFields,
  ranksAtLeast,
} from '../posting/fields'
import { type Db, nowIso, one, transaction } from './client'
import { urlKey } from './url-key'

export const POSTING_SOURCES = ['freehire', 'manual', 'agent'] as const
export type PostingSource = (typeof POSTING_SOURCES)[number]

export interface Posting {
  id: number
  source: PostingSource
  source_id: string | null
  url: string
  url_key: string
  title: string
  company: string
  location: string | null
  country: string | null
  state: string | null
  city: string | null
  work_mode: string | null
  job_type: string | null
  seniority: string | null
  education_level: string | null
  min_experience_years: number | null
  posted_at: string | null
  closed_at: string | null
  pay_min: number | null
  pay_max: number | null
  pay_period: string | null
  currency: string | null
  pay_stated: number | null
  description: string | null
  summary: string | null
  skills: string | null
  requirements: string | null
  requires_clearance: number | null
  field_sources: string | null
  resolved_at: string | null
  raw: string | null
  created_at: string
  updated_at: string
}

type FieldValues = { [K in Exclude<PostingField, 'title' | 'company'>]?: PostingFields[K] | null }

export type PostingInput = Pick<Posting, 'source' | 'url' | 'title' | 'company'> & FieldValues & {
  source_id?: string | null
  raw?: string | null
  pay_stated?: boolean | null
  resolved_at?: string | null
  sources?: FieldSources
}

const ROW_SOURCE: Record<PostingSource, FieldSource> = { freehire: 'freehire', manual: 'user', agent: 'agent' }
const JSON_FIELDS: readonly PostingField[] = ['skills', 'requirements']
const AMOUNT_FIELDS: readonly PostingField[] = ['pay_min', 'pay_max']

const isFieldSource = (value: unknown): value is FieldSource => (FIELD_SOURCES as readonly unknown[]).includes(value)

function encode(field: PostingField, value: NonNullable<PostingFields[PostingField]>): string | number {
  if (JSON_FIELDS.includes(field)) return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  return value as string | number
}

function decode(field: PostingField, value: unknown): PostingFields[PostingField] | undefined {
  if (value === null || value === undefined) return undefined
  if (JSON_FIELDS.includes(field)) {
    try {
      return JSON.parse(String(value)) as PostingFields[PostingField]
    } catch {
      return undefined
    }
  }
  if (field === 'requires_clearance') return value === 1
  return value as PostingFields[PostingField]
}

export function postingFields(posting: Posting): PostingFields {
  const fields: PostingFields = {}
  for (const field of POSTING_FIELDS) {
    const value = decode(field, posting[field])
    if (value !== undefined) Object.assign(fields, { [field]: value })
  }
  return fields
}

export function postingSources(posting: Posting): FieldSources {
  let recorded: Record<string, unknown> = {}
  try {
    const parsed: unknown = posting.field_sources === null ? {} : JSON.parse(posting.field_sources)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) recorded = parsed as Record<string, unknown>
  } catch {
    recorded = {}
  }
  const sources: FieldSources = {}
  for (const field of POSTING_FIELDS) {
    if (posting[field] === null) continue
    const source = recorded[field]
    sources[field] = isFieldSource(source) ? source : ROW_SOURCE[posting.source]
  }
  return sources
}

const hasAmount = (values: Partial<Record<PostingField, unknown>>) =>
  AMOUNT_FIELDS.some((field) => values[field] !== null && values[field] !== undefined)

function merge(existing: Posting | undefined, input: PostingInput) {
  const fallback = ROW_SOURCE[input.source]
  const stored = existing ? postingSources(existing) : {}
  const sourceOf = (field: PostingField) => input.sources?.[field] ?? fallback
  const values: Partial<Record<PostingField, string | number | null>> = {}
  const sources: FieldSources = { ...stored }
  const write = (field: PostingField, value: PostingFields[PostingField] | null | undefined) => {
    if (value === null || value === undefined) {
      values[field] = null
      delete sources[field]
      return
    }
    values[field] = encode(field, value)
    sources[field] = sourceOf(field)
  }
  const wins = (field: PostingField) => {
    const current = stored[field]
    return current === undefined || ranksAtLeast(sourceOf(field), current)
  }

  const storedPay = existing !== undefined && hasAmount(existing)
  const incomingPay = hasAmount(input)
  if (incomingPay && storedPay) {
    const storedSource = stored.pay_min ?? stored.pay_max
    if (storedSource === undefined || ranksAtLeast(sourceOf(input.pay_min != null ? 'pay_min' : 'pay_max'), storedSource)) {
      for (const field of PAY_FIELDS) write(field, input[field])
    }
  }

  for (const field of POSTING_FIELDS) {
    const value = input[field]
    if (value === null || value === undefined) continue
    if ((PAY_FIELDS as readonly string[]).includes(field) && storedPay) continue
    if (!wins(field)) continue
    const current = existing?.[field]
    if (field === 'description' && typeof current === 'string' && String(value).length < current.length) continue
    write(field, value)
  }
  return { values, sources }
}

export function upsertPosting(db: Db, input: PostingInput): Posting {
  const key = urlKey(input.url)
  if (key === null) throw new Error(`invalid posting URL: ${input.url}`)
  return transaction(db, () => {
    const existing = one<Posting>(db.prepare('SELECT * FROM postings WHERE url_key = ?'), key)
    const { values, sources } = merge(existing, input)
    const final = { ...existing, ...values }
    const payStated = hasAmount(final) ? 1 : input.pay_stated === true ? 1 : input.pay_stated === false ? 0 : (existing?.pay_stated ?? null)
    const columns: Record<string, unknown> = {
      ...values,
      url: input.url,
      pay_stated: payStated,
      field_sources: JSON.stringify(sources),
      updated_at: nowIso(),
    }
    if (input.source_id != null) columns.source_id = input.source_id
    if (input.raw != null) columns.raw = input.raw
    if (input.resolved_at != null) columns.resolved_at = input.resolved_at
    const names = Object.keys(columns)
    const params = Object.values(columns)
    const row = existing
      ? one<Posting>(db.prepare(`UPDATE postings SET ${names.map((name) => `${name} = ?`).join(', ')}
          WHERE id = ? RETURNING *`), ...params, existing.id)
      : one<Posting>(db.prepare(`INSERT INTO postings (source, url_key, created_at, ${names.join(', ')})
          VALUES (?, ?, ?, ${names.map(() => '?').join(', ')}) RETURNING *`),
        input.source, key, columns.updated_at, ...params)
    if (!row) throw new Error('upsertPosting returned no row')
    return row
  })
}

export function findPostingByUrl(db: Db, url: string): Posting | undefined {
  const key = urlKey(url)
  if (key === null) return undefined
  return one<Posting>(db.prepare('SELECT * FROM postings WHERE url_key = ?'), key)
}

export const getPosting = (db: Db, id: number) => one<Posting>(db.prepare('SELECT * FROM postings WHERE id = ?'), id)
