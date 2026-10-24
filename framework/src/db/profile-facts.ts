import { z } from 'zod'
import { formatIssues } from './applications'
import { type Db, nowIso, one, transaction } from './client'

export const FACT_CATEGORIES = [
  'skill', 'tool', 'action', 'outcome', 'methodology', 'context', 'challenge', 'domain-knowledge', 'leadership',
] as const
export const FACT_BASES = ['stated', 'inferred'] as const
export const FACT_CONFIDENCES = ['low', 'medium', 'high'] as const
export const FACT_STATUSES = ['proposed', 'accepted', 'archived'] as const

export type FactCategory = (typeof FACT_CATEGORIES)[number]
export type FactBasis = (typeof FACT_BASES)[number]
export type FactConfidence = (typeof FACT_CONFIDENCES)[number]
export type FactStatus = (typeof FACT_STATUSES)[number]

export const MAX_RATIONALE_WORDS = 25
export const MAX_TAGS = 20
export const MAX_TAG_LENGTH = 60
export const SNAKE_CASE = /^[a-z0-9]+(_[a-z0-9]+)*$/

const requiredText = (max: number) => z.string().trim().min(1, 'is required').max(max)
const optionalText = (max: number) => z.string().trim().max(max).nullish()
  .transform((value) => (value ? value : null))
const tag = z.string().max(MAX_TAG_LENGTH, `tags must be at most ${MAX_TAG_LENGTH} characters`)
  .regex(SNAKE_CASE, 'tags must be lowercase snake_case, e.g. data_modeling')
const tags = z.array(tag).max(MAX_TAGS, `at most ${MAX_TAGS} tags`).nullish()
  .transform((values) => [...new Set(values ?? [])])

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length

export const FactSchema = z.object({
  slug: optionalText(100),
  company: optionalText(200),
  role: optionalText(200),
  project: requiredText(200),
  category: z.enum(FACT_CATEGORIES),
  action: requiredText(1000),
  outcome: optionalText(1000),
  metrics: z.string().max(1000).nullish().transform((value) => (value?.trim() ? value : null)),
  skills: tags,
  tools: tags,
  basis: z.enum(FACT_BASES),
  confidence: z.enum(FACT_CONFIDENCES).nullish().transform((value) => value ?? null),
  rationale: optionalText(500),
  sort_order: z.number().int().default(0),
}).superRefine((fact, ctx) => {
  if (fact.basis === 'inferred') {
    if (fact.confidence === null) ctx.addIssue({ code: 'custom', path: ['confidence'], message: 'inferred facts need a confidence (low, medium or high)' })
    if (fact.rationale === null) ctx.addIssue({ code: 'custom', path: ['rationale'], message: 'inferred facts need a rationale' })
    else if (wordCount(fact.rationale) > MAX_RATIONALE_WORDS) {
      ctx.addIssue({ code: 'custom', path: ['rationale'], message: `rationale must be at most ${MAX_RATIONALE_WORDS} words` })
    }
  } else {
    if (fact.confidence !== null) ctx.addIssue({ code: 'custom', path: ['confidence'], message: 'stated facts take no confidence' })
    if (fact.rationale !== null) ctx.addIssue({ code: 'custom', path: ['rationale'], message: 'stated facts take no rationale' })
  }
})

export class SlugConflict extends Error {
  constructor(readonly slug: string, readonly owner: number) {
    super(`slug ${slug} is already used by fact ${owner}`)
  }
}

export type FactInput = z.input<typeof FactSchema>
type ValidFact = z.output<typeof FactSchema>
export type FactPatch = Partial<FactInput> & { status?: FactStatus }

export interface ProfileFact {
  id: number
  slug: string | null
  company: string | null
  role: string | null
  project: string
  category: FactCategory
  action: string
  outcome: string | null
  metrics: string | null
  skills: string[]
  tools: string[]
  basis: FactBasis
  confidence: FactConfidence | null
  rationale: string | null
  status: FactStatus
  sort_order: number
  created_at: string
  updated_at: string
}

interface FactRow extends Omit<ProfileFact, 'skills' | 'tools'> {
  skills: string | null
  tools: string | null
}

export interface FactFilter {
  status?: FactStatus | FactStatus[]
  company?: string
  project?: string
}

export interface SaveResult {
  facts: ProfileFact[]
  inserted: number
  updated: number
}

const COLUMNS = ['slug', 'company', 'role', 'project', 'category', 'action', 'outcome', 'metrics', 'skills', 'tools',
  'basis', 'confidence', 'rationale', 'sort_order'] as const

function parseTags(value: string | null): string[] {
  if (value === null) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

const toFact = (row: FactRow): ProfileFact => ({ ...row, skills: parseTags(row.skills), tools: parseTags(row.tools) })

const values = (fact: ValidFact) =>
  COLUMNS.map((column) => (column === 'skills' || column === 'tools' ? JSON.stringify(fact[column]) : fact[column]))

function validate(input: FactInput, label: string): ValidFact {
  const parsed = FactSchema.safeParse(input)
  if (!parsed.success) throw new Error(`${label}: ${formatIssues(parsed.error)}`)
  return parsed.data
}

function checkStatus(status: string): FactStatus {
  if (!(FACT_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`status ${status} is not valid; use one of ${FACT_STATUSES.join(', ')}`)
  }
  return status as FactStatus
}

const findRow = (db: Db, id: number) => one<FactRow>(db.prepare('SELECT * FROM profile_facts WHERE id = ?'), id)
const findBySlug = (db: Db, slug: string) => one<FactRow>(db.prepare('SELECT * FROM profile_facts WHERE slug = ?'), slug)

const rewrite = (db: Db, id: number, fact: ValidFact, status: FactStatus, now: string) =>
  one<FactRow>(db.prepare(`UPDATE profile_facts SET ${COLUMNS.map((column) => `${column} = ?`).join(', ')},
      status = ?, updated_at = ?
      WHERE id = ?
      RETURNING *`), ...values(fact), status, now, id)

export function getFact(db: Db, id: number): ProfileFact | undefined {
  const row = findRow(db, id)
  return row ? toFact(row) : undefined
}

export function listFacts(db: Db, filter: FactFilter = {}): ProfileFact[] {
  const where: string[] = []
  const params: unknown[] = []
  if (filter.status !== undefined) {
    const statuses = (Array.isArray(filter.status) ? filter.status : [filter.status]).map(checkStatus)
    where.push(`status IN (${statuses.map(() => '?').join(', ')})`)
    params.push(...statuses)
  }
  if (filter.company !== undefined) {
    where.push('company = ? COLLATE NOCASE')
    params.push(filter.company)
  }
  if (filter.project !== undefined) {
    where.push('project = ? COLLATE NOCASE')
    params.push(filter.project)
  }
  const sql = `SELECT * FROM profile_facts ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY company, project, sort_order, id`
  return (db.prepare(sql).all(...params) as FactRow[]).map(toFact)
}

export function saveFacts(db: Db, facts: FactInput[], options: { status?: FactStatus } = {}): SaveResult {
  const status = checkStatus(options.status ?? 'proposed')
  const valid = facts.map((fact, index) => validate(fact, `facts[${index}]`))
  return transaction(db, () => {
    const saved: ProfileFact[] = []
    let inserted = 0
    let updated = 0
    for (const fact of valid) {
      const now = nowIso()
      const existing = fact.slug === null ? undefined : findBySlug(db, fact.slug)
      const row = existing
        ? rewrite(db, existing.id, fact, status, now)
        : one<FactRow>(db.prepare(`INSERT INTO profile_facts (${COLUMNS.join(', ')}, status, created_at, updated_at)
            VALUES (${COLUMNS.map(() => '?').join(', ')}, ?, ?, ?)
            RETURNING *`), ...values(fact), status, now, now)
      if (!row) throw new Error('saveFacts returned no row')
      if (existing) updated += 1
      else inserted += 1
      saved.push(toFact(row))
    }
    return { facts: saved, inserted, updated }
  })
}

export function updateFact(db: Db, id: number, patch: FactPatch): ProfileFact {
  return transaction(db, () => {
    const current = findRow(db, id)
    if (!current) throw new Error(`fact ${id} not found`)
    const { status, ...fields } = patch
    const nextStatus = status === undefined ? current.status : checkStatus(status)
    const changes = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
    if (Object.keys(changes).length === 0) {
      if (status === undefined) return toFact(current)
      const row = one<FactRow>(db.prepare('UPDATE profile_facts SET status = ?, updated_at = ? WHERE id = ? RETURNING *'),
        nextStatus, nowIso(), id)
      if (!row) throw new Error(`fact ${id} not found`)
      return toFact(row)
    }
    const existing = toFact(current)
    const fact = validate({ ...Object.fromEntries(COLUMNS.map((column) => [column, existing[column]])), ...changes } as FactInput,
      `fact ${id}`)
    if (fact.slug !== null) {
      const owner = findBySlug(db, fact.slug)
      if (owner && owner.id !== id) throw new SlugConflict(fact.slug, owner.id)
    }
    const row = rewrite(db, id, fact, nextStatus, nowIso())
    if (!row) throw new Error(`fact ${id} not found`)
    return toFact(row)
  })
}

export function deleteFact(db: Db, id: number): ProfileFact {
  return transaction(db, () => {
    const current = findRow(db, id)
    if (!current) throw new Error(`fact ${id} not found`)
    db.prepare('DELETE FROM profile_facts WHERE id = ?').run(id)
    return toFact(current)
  })
}
