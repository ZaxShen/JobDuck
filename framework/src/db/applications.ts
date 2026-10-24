import { z } from 'zod'
import { type Db, nowIso, one, transaction } from './client'

export const APPLICATION_STATUSES = [
  'pending', 'applied', 'interviewing', 'offered',
  'accepted', 'deny_by_employer', 'deny_by_candidate', 'no_response',
] as const
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number]

export const TERMINAL_STATUSES = ['accepted', 'deny_by_employer', 'deny_by_candidate', 'no_response'] as const
export const EVENT_SOURCES = ['agent', 'dashboard', 'sync', 'user'] as const
export type EventSource = (typeof EVENT_SOURCES)[number]

export const isTerminal = (status: ApplicationStatus) => (TERMINAL_STATUSES as readonly string[]).includes(status)

export const PENDING_REASON_MAX = 500
export const PENDING_REASON_REQUIRED = 'pending_reason is required when status is pending'
export const PENDING_REASON_ONLY_PENDING = 'pending_reason is only kept while status is pending'
export const STATUS_REQUIRED = 'status is required unless a pending_reason is given'
export const PendingReasonSchema = z.string().trim()
  .min(1, PENDING_REASON_REQUIRED)
  .max(PENDING_REASON_MAX, `pending_reason must be at most ${PENDING_REASON_MAX} characters`)

export function checkPendingReason(status: ApplicationStatus, reason: string | null | undefined): string | null {
  if (status !== 'pending') {
    if (reason !== undefined && reason !== null) throw new Error(PENDING_REASON_ONLY_PENDING)
    return null
  }
  if (reason === undefined || reason === null) throw new Error(PENDING_REASON_REQUIRED)
  const parsed = PendingReasonSchema.safeParse(reason)
  if (!parsed.success) throw new Error(formatIssues(parsed.error))
  return parsed.data
}

export interface Application {
  id: number
  posting_id: number
  status: ApplicationStatus
  pending_reason: string | null
  applied_at: string | null
  closed_at: string | null
  closed_by: string | null
  note: string | null
  extracted: string | null
  title_override: string | null
  company_override: string | null
  location_override: string | null
  salary_min: number | null
  salary_max: number | null
  salary_offered: number | null
  rsu: number | null
  options: number | null
  bonus: number | null
  sign_on: number | null
  relocation_fee: number | null
  currency: string | null
  country_override: string | null
  state_override: string | null
  city_override: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface ApplicationEvent {
  id: number
  application_id: number
  from_status: ApplicationStatus | null
  to_status: ApplicationStatus
  note: string | null
  source: EventSource
  metadata: string | null
  stage_type: string | null
  scheduled_at: string | null
  outcome: string | null
  created_at: string
}

export interface CreateApplicationInput {
  postingId: number
  status?: ApplicationStatus
  pendingReason?: string
  source?: EventSource
  appliedAt?: string
  note?: string
  extracted?: unknown
  closedBy?: string
}

export interface SetStatusOptions {
  pendingReason?: string
  source?: EventSource
  note?: string
  closedBy?: string
  metadata?: unknown
}

const toJson = (value: unknown) => (value === undefined || value === null ? null : JSON.stringify(value))

function insertEvent(db: Db, applicationId: number, from: ApplicationStatus | null, to: ApplicationStatus,
  source: EventSource, note: string | null, metadata: unknown, createdAt: string): void {
  db.prepare(`INSERT INTO application_events
      (application_id, from_status, to_status, note, source, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(applicationId, from, to, note, source, toJson(metadata), createdAt)
}

export function getApplication(db: Db, id: number): Application | undefined {
  return one<Application>(db.prepare('SELECT * FROM applications WHERE id = ? AND deleted_at IS NULL'), id)
}

export function listEvents(db: Db, applicationId: number): ApplicationEvent[] {
  return db.prepare('SELECT * FROM application_events WHERE application_id = ? ORDER BY id')
    .all(applicationId) as ApplicationEvent[]
}

export function createApplication(db: Db, input: CreateApplicationInput): Application {
  const status = input.status ?? (input.pendingReason === undefined ? undefined : 'pending')
  if (status === undefined) throw new Error(STATUS_REQUIRED)
  const pendingReason = checkPendingReason(status, input.pendingReason)
  const source = input.source ?? 'agent'
  const now = nowIso()
  const appliedAt = status === 'pending' ? null : (input.appliedAt ?? now)
  const terminal = isTerminal(status)
  return transaction(db, () => {
    const row = one<Application>(db.prepare(`INSERT INTO applications
        (posting_id, status, pending_reason, applied_at, closed_at, closed_by, note, extracted, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *`),
      input.postingId, status, pendingReason, appliedAt, terminal ? now : null, terminal ? (input.closedBy ?? source) : null,
      input.note ?? null, toJson(input.extracted), now, now)
    if (!row) throw new Error('createApplication returned no row')
    insertEvent(db, row.id, null, status, source, input.note ?? null, undefined, now)
    return row
  })
}

export function setStatus(db: Db, id: number, status: ApplicationStatus, options: SetStatusOptions = {}): Application {
  const source = options.source ?? 'agent'
  const pendingReason = checkPendingReason(status, options.pendingReason)
  return transaction(db, () => {
    const current = getApplication(db, id)
    if (!current) throw new Error(`application ${id} not found`)
    const now = nowIso()
    const terminal = isTerminal(status)
    const appliedAt = current.applied_at ?? (status === 'pending' ? null : now)
    const note = options.note ?? null
    const row = one<Application>(db.prepare(`UPDATE applications
        SET status = ?, pending_reason = ?, applied_at = ?, closed_at = ?, closed_by = ?, updated_at = ?,
          note = CASE WHEN ? IS NULL THEN note WHEN note IS NULL THEN ? ELSE note || char(10) || ? END
        WHERE id = ?
        RETURNING *`),
      status, pendingReason, appliedAt, terminal ? now : null, terminal ? (options.closedBy ?? source) : null, now,
      note, note, note, id)
    if (!row) throw new Error(`application ${id} not found`)
    insertEvent(db, id, current.status, status, source, note, options.metadata, now)
    return row
  })
}

export interface ListApplicationsFilter {
  status?: ApplicationStatus | ApplicationStatus[]
  since?: string
}

export function listApplications(db: Db, filter: ListApplicationsFilter = {}): Application[] {
  const where = ['deleted_at IS NULL']
  const params: unknown[] = []
  const statuses = filter.status === undefined ? [] : [filter.status].flat()
  if (statuses.length > 0) {
    where.push(`status IN (${statuses.map(() => '?').join(', ')})`)
    params.push(...statuses)
  }
  if (filter.since !== undefined) {
    where.push('updated_at >= ?')
    params.push(filter.since)
  }
  return db.prepare(`SELECT * FROM applications WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC`)
    .all(...params) as Application[]
}

export const PAY_FIELDS = [
  'salary_min', 'salary_max', 'salary_offered', 'rsu', 'options', 'bonus', 'sign_on', 'relocation_fee',
] as const
export type PayField = (typeof PAY_FIELDS)[number]
export const TEXT_FIELDS = [
  'note', 'title_override', 'company_override', 'location_override',
  'currency', 'country_override', 'state_override', 'city_override',
] as const
export type TextField = (typeof TEXT_FIELDS)[number]
export const EDITABLE_FIELDS = [...TEXT_FIELDS, ...PAY_FIELDS] as const
export type EditableField = (typeof EDITABLE_FIELDS)[number]
export type ApplicationFields = Partial<Record<TextField, string | null> & Record<PayField, number | null>>

const pay = z.number().int('must be a whole number').nonnegative('must be 0 or more').nullable().optional()
const textField = z.string().nullable().optional()

export const ApplicationFieldsSchema = z.object({
  ...Object.fromEntries(TEXT_FIELDS.map((key) => [key, textField])) as Record<TextField, typeof textField>,
  ...Object.fromEntries(PAY_FIELDS.map((key) => [key, pay])) as Record<PayField, typeof pay>,
  currency: z.string().length(3, 'must be a 3-letter currency code').nullable().optional(),
  country_override: z.string().regex(/^[A-Z]{2}$/, 'must be 2 uppercase letters (ISO country code)').nullable().optional(),
}).strict()

export function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ')
}

export function updateApplicationFields(db: Db, id: number, fields: ApplicationFields): Application {
  const parsed = ApplicationFieldsSchema.safeParse(fields)
  if (!parsed.success) throw new Error(formatIssues(parsed.error))
  const valid = parsed.data as ApplicationFields
  const keys = EDITABLE_FIELDS.filter((key) => valid[key] !== undefined)
  const assignments = [...keys.map((key) => `${key} = ?`), 'updated_at = ?']
  return transaction(db, () => {
    const row = one<Application>(db.prepare(`UPDATE applications SET ${assignments.join(', ')}
        WHERE id = ? AND deleted_at IS NULL
        RETURNING *`),
      ...keys.map((key) => valid[key]), nowIso(), id)
    if (!row) throw new Error(`application ${id} not found`)
    return row
  })
}

export function softDeleteApplication(db: Db, id: number): boolean {
  const now = nowIso()
  const result = db.prepare('UPDATE applications SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(now, now, id)
  return Number(result.changes) > 0
}

export function getLiveApplicationForPosting(db: Db, postingId: number): Application | undefined {
  return one<Application>(db.prepare('SELECT * FROM applications WHERE posting_id = ? AND deleted_at IS NULL'), postingId)
}

export interface FindApplicationQuery {
  company?: string
  title?: string
}

export function findApplicationsByCompanyTitle(db: Db, query: FindApplicationQuery): Application[] {
  const where = ['a.deleted_at IS NULL']
  const params: unknown[] = []
  if (query.company !== undefined) {
    where.push('lower(COALESCE(a.company_override, p.company)) = lower(?)')
    params.push(query.company.trim())
  }
  if (query.title !== undefined) {
    where.push('lower(COALESCE(a.title_override, p.title)) = lower(?)')
    params.push(query.title.trim())
  }
  return db.prepare(`SELECT a.* FROM applications a JOIN postings p ON p.id = a.posting_id
      WHERE ${where.join(' AND ')} ORDER BY a.updated_at DESC, a.id DESC`)
    .all(...params) as Application[]
}

export interface ApplicationWithPosting extends Application {
  title: string
  company: string
  location: string | null
  url: string
  work_mode: string | null
  posting_title: string
  posting_company: string
  posting_location: string | null
}

export type ApplicationSummary = Pick<ApplicationWithPosting,
  'id' | 'status' | 'pending_reason' | 'title' | 'company' | 'location' | 'url' | 'applied_at' | 'closed_at' | 'updated_at' | 'note'>

export const summarizeApplication = (row: ApplicationWithPosting): ApplicationSummary => ({
  id: row.id, status: row.status, pending_reason: row.pending_reason, title: row.title, company: row.company, location: row.location, url: row.url,
  applied_at: row.applied_at, closed_at: row.closed_at, updated_at: row.updated_at, note: row.note,
})

export interface ListApplicationsWithPostingsFilter extends ListApplicationsFilter {
  q?: string
  limit?: number
}

const JOINED_SELECT = `SELECT a.*,
    COALESCE(a.title_override, p.title) AS title,
    COALESCE(a.company_override, p.company) AS company,
    COALESCE(a.location_override, p.location) AS location,
    p.url AS url, p.work_mode AS work_mode,
    p.title AS posting_title, p.company AS posting_company, p.location AS posting_location
  FROM applications a JOIN postings p ON p.id = a.posting_id`

const likePattern = (q: string) => `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`

export function listApplicationsWithPostings(db: Db, filter: ListApplicationsWithPostingsFilter = {}): ApplicationWithPosting[] {
  const where = ['a.deleted_at IS NULL']
  const params: unknown[] = []
  const statuses = filter.status === undefined ? [] : [filter.status].flat()
  if (statuses.length > 0) {
    where.push(`a.status IN (${statuses.map(() => '?').join(', ')})`)
    params.push(...statuses)
  }
  if (filter.since !== undefined) {
    where.push('a.updated_at >= ?')
    params.push(filter.since)
  }
  const q = filter.q?.trim()
  if (q) {
    const columns = ['COALESCE(a.title_override, p.title)', 'COALESCE(a.company_override, p.company)',
      "COALESCE(a.location_override, p.location, '')"]
    where.push(`(${columns.map((column) => `LOWER(${column}) LIKE ? ESCAPE '\\'`).join(' OR ')})`)
    params.push(...columns.map(() => likePattern(q)))
  }
  params.push(filter.limit ?? 50)
  return db.prepare(`${JOINED_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`)
    .all(...params) as ApplicationWithPosting[]
}

export function getApplicationWithPosting(db: Db, id: number): ApplicationWithPosting | undefined {
  return one<ApplicationWithPosting>(db.prepare(`${JOINED_SELECT} WHERE a.id = ? AND a.deleted_at IS NULL`), id)
}

export function getPostingDescription(db: Db, applicationId: number): string | null {
  const row = one<{ description: string | null }>(db.prepare(`SELECT p.description FROM applications a
      JOIN postings p ON p.id = a.posting_id WHERE a.id = ? AND a.deleted_at IS NULL`), applicationId)
  return row?.description ?? null
}
