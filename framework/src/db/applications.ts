import { z } from 'zod'
import { type Db, nowIso, one, transaction } from './client'
import { checkEventDate } from './dates'

export const APPLICATION_STATUSES = [
  'saved', 'pending', 'applied', 'interviewing', 'offered',
  'accepted', 'deny_by_employer', 'deny_by_candidate', 'no_response',
] as const
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number]

export const TERMINAL_STATUSES = ['accepted', 'deny_by_employer', 'deny_by_candidate', 'no_response'] as const
export const EVENT_SOURCES = ['agent', 'dashboard', 'sync', 'user'] as const
export type EventSource = (typeof EVENT_SOURCES)[number]

export const isTerminal = (status: ApplicationStatus) => (TERMINAL_STATUSES as readonly string[]).includes(status)
const isUnsubmitted = (status: ApplicationStatus) => status === 'saved' || status === 'pending'

export const STATUS_RANK: Record<ApplicationStatus, number> = {
  saved: 0, pending: 0, applied: 1, interviewing: 2, offered: 3,
  accepted: 4, deny_by_employer: 4, deny_by_candidate: 4, no_response: 4,
}
export const UNDO_LATEST_ONLY = 'only the latest status entry can be undone'

export const PENDING_REASON_MAX = 500
export const PENDING_REASON_REQUIRED = 'pending_reason is required when status is pending'
export const PENDING_REASON_ONLY_PENDING = 'pending_reason is only kept while status is pending'
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
  occurred_at: string | null
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
  occurredAt?: string
}

export interface EventPatch {
  occurredAt?: string
  note?: string | null
}

const toJson = (value: unknown) => (value === undefined || value === null ? null : JSON.stringify(value))

function insertEvent(db: Db, applicationId: number, from: ApplicationStatus | null, to: ApplicationStatus,
  source: EventSource, note: string | null, metadata: unknown, createdAt: string, occurredAt: string | null = null): void {
  db.prepare(`INSERT INTO application_events
      (application_id, from_status, to_status, note, source, metadata, occurred_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(applicationId, from, to, note, source, toJson(metadata), occurredAt, createdAt)
}

const hasEventTo = (db: Db, applicationId: number, status: ApplicationStatus) =>
  one(db.prepare('SELECT 1 FROM application_events WHERE application_id = ? AND to_status = ? LIMIT 1'),
    applicationId, status) !== undefined

const latestEventId = (db: Db, applicationId: number, status?: ApplicationStatus) =>
  one<{ id: number | null }>(db.prepare(`SELECT MAX(id) AS id FROM application_events
      WHERE application_id = ? AND (? IS NULL OR to_status = ?)`), applicationId, status ?? null, status ?? null)?.id ?? null

function checkForward(db: Db, current: Application, target: ApplicationStatus): void {
  const { id, status } = current
  if (isTerminal(status)) throw new Error(`application ${id} is closed (${status}); undo its latest entry instead`)
  if (target === status && target !== 'pending') throw new Error(`application ${id} is already ${status}`)
  if (STATUS_RANK[target] < STATUS_RANK[status]) {
    throw new Error(`cannot move application ${id} back from ${status} to ${target}; undo the later entry instead`)
  }
  if (target === 'applied' && hasEventTo(db, id, 'applied')) throw new Error(`application ${id} is already applied`)
}

export function getApplication(db: Db, id: number): Application | undefined {
  return one<Application>(db.prepare('SELECT * FROM applications WHERE id = ? AND deleted_at IS NULL'), id)
}

export function listEvents(db: Db, applicationId: number): ApplicationEvent[] {
  return db.prepare('SELECT * FROM application_events WHERE application_id = ? ORDER BY id')
    .all(applicationId) as ApplicationEvent[]
}

export function createApplication(db: Db, input: CreateApplicationInput): Application {
  const status = input.status ?? 'saved'
  const pendingReason = checkPendingReason(status, input.pendingReason)
  const source = input.source ?? 'agent'
  const now = nowIso()
  const note = input.note ?? null
  const terminal = isTerminal(status)
  return transaction(db, () => {
    const saved = one<Application>(db.prepare(`INSERT INTO applications
        (posting_id, status, note, extracted, created_at, updated_at)
        VALUES (?, 'saved', ?, ?, ?, ?)
        RETURNING *`),
      input.postingId, note, toJson(input.extracted), now, now)
    if (!saved) throw new Error('createApplication returned no row')
    insertEvent(db, saved.id, null, 'saved', source, status === 'saved' ? note : null, undefined, now)
    if (status === 'saved') return saved
    const row = one<Application>(db.prepare(`UPDATE applications
        SET status = ?, pending_reason = ?, applied_at = ?, closed_at = ?, closed_by = ?
        WHERE id = ?
        RETURNING *`),
      status, pendingReason, isUnsubmitted(status) ? null : (input.appliedAt ?? now),
      terminal ? now : null, terminal ? (input.closedBy ?? source) : null, saved.id)
    if (!row) throw new Error(`application ${saved.id} not found`)
    insertEvent(db, row.id, 'saved', status, source, note, undefined, now)
    return row
  })
}

export function setStatus(db: Db, id: number, status: ApplicationStatus, options: SetStatusOptions = {}): Application {
  const source = options.source ?? 'agent'
  const pendingReason = checkPendingReason(status, options.pendingReason)
  const occurredAt = options.occurredAt === undefined ? null : checkEventDate(options.occurredAt, 'occurred_at')
  return transaction(db, () => {
    const current = getApplication(db, id)
    if (!current) throw new Error(`application ${id} not found`)
    checkForward(db, current, status)
    const now = nowIso()
    const terminal = isTerminal(status)
    const appliedAt = current.applied_at ?? (isUnsubmitted(status) ? null : (occurredAt ?? now))
    const note = options.note ?? null
    const row = one<Application>(db.prepare(`UPDATE applications
        SET status = ?, pending_reason = ?, applied_at = ?, closed_at = ?, closed_by = ?, updated_at = ?,
          note = CASE WHEN ? IS NULL THEN note WHEN note IS NULL THEN ? ELSE note || char(10) || ? END
        WHERE id = ?
        RETURNING *`),
      status, pendingReason, appliedAt, terminal ? (occurredAt ?? now) : null,
      terminal ? (options.closedBy ?? source) : null, now, note, note, note, id)
    if (!row) throw new Error(`application ${id} not found`)
    insertEvent(db, id, current.status, status, source, note, options.metadata, now, occurredAt)
    return row
  })
}

export function getEvent(db: Db, eventId: number): ApplicationEvent | undefined {
  return one<ApplicationEvent>(db.prepare(`SELECT e.* FROM application_events e
      JOIN applications a ON a.id = e.application_id
      WHERE e.id = ? AND a.deleted_at IS NULL`), eventId)
}

function requireEvent(db: Db, eventId: number): ApplicationEvent {
  const event = getEvent(db, eventId)
  if (!event) throw new Error(`event ${eventId} not found`)
  return event
}

export function updateEvent(db: Db, eventId: number, patch: EventPatch): ApplicationEvent {
  const occurredAt = patch.occurredAt === undefined ? undefined : checkEventDate(patch.occurredAt, 'occurred_at')
  return transaction(db, () => {
    const event = requireEvent(db, eventId)
    if (event.stage_type !== null) throw new Error(`event ${eventId} is an interview or offer stage; edit it as a stage`)
    const assignments: string[] = []
    const params: unknown[] = []
    if (occurredAt !== undefined) {
      assignments.push('occurred_at = ?')
      params.push(occurredAt)
    }
    if (patch.note !== undefined) {
      assignments.push('note = ?')
      params.push(patch.note)
    }
    if (assignments.length === 0) return event
    const updated = one<ApplicationEvent>(db.prepare(`UPDATE application_events SET ${assignments.join(', ')}
        WHERE id = ?
        RETURNING *`), ...params, eventId)
    if (!updated) throw new Error(`event ${eventId} not found`)
    const application = getApplication(db, event.application_id)
    if (!application) throw new Error(`application ${event.application_id} not found`)
    const syncApplied = occurredAt !== undefined && event.to_status === 'applied'
    const syncClosed = occurredAt !== undefined && isTerminal(application.status) && event.to_status === application.status
      && latestEventId(db, application.id, application.status) === event.id
    db.prepare(`UPDATE applications
        SET applied_at = CASE WHEN ? THEN ? ELSE applied_at END,
          closed_at = CASE WHEN ? THEN ? ELSE closed_at END,
          updated_at = ?
        WHERE id = ?`)
      .run(syncApplied ? 1 : 0, occurredAt ?? null, syncClosed ? 1 : 0, occurredAt ?? null, nowIso(), application.id)
    return updated
  })
}

export function revertRemovedEvent(db: Db, removed: ApplicationEvent): void {
  const application = getApplication(db, removed.application_id)
  if (!application) throw new Error(`application ${removed.application_id} not found`)
  const now = nowIso()
  if (removed.from_status === null || application.status !== removed.to_status
    || hasEventTo(db, application.id, removed.to_status)) {
    db.prepare('UPDATE applications SET updated_at = ? WHERE id = ?').run(now, application.id)
    return
  }
  const from = removed.from_status !== removed.to_status ? removed.from_status
    : one<{ to_status: ApplicationStatus }>(db.prepare(`SELECT to_status FROM application_events
        WHERE application_id = ? ORDER BY id DESC LIMIT 1`), application.id)?.to_status ?? 'saved'
  const status = from === 'pending' ? 'saved' : from
  const leavingTerminal = isTerminal(application.status) && !isTerminal(status)
  db.prepare(`UPDATE applications
      SET status = ?, pending_reason = NULL,
        closed_at = CASE WHEN ? THEN NULL ELSE closed_at END,
        closed_by = CASE WHEN ? THEN NULL ELSE closed_by END,
        applied_at = CASE WHEN ? THEN NULL ELSE applied_at END,
        updated_at = ?
      WHERE id = ?`)
    .run(status, leavingTerminal ? 1 : 0, leavingTerminal ? 1 : 0, status === 'saved' ? 1 : 0, now, application.id)
}

export function deleteEvent(db: Db, eventId: number): ApplicationEvent {
  return transaction(db, () => {
    const event = requireEvent(db, eventId)
    if (event.stage_type !== null || event.from_status === null || latestEventId(db, event.application_id) !== event.id) {
      throw new Error(UNDO_LATEST_ONLY)
    }
    db.prepare('DELETE FROM application_events WHERE id = ?').run(eventId)
    revertRemovedEvent(db, event)
    return event
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
  posting_country: string | null
  posting_state: string | null
  posting_city: string | null
  posting_pay_min: number | null
  posting_pay_max: number | null
  posting_pay_period: string | null
  posting_currency: string | null
  posting_pay_stated: number | null
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
    p.title AS posting_title, p.company AS posting_company, p.location AS posting_location,
    p.country AS posting_country, p.state AS posting_state, p.city AS posting_city,
    p.pay_min AS posting_pay_min, p.pay_max AS posting_pay_max, p.pay_period AS posting_pay_period,
    p.currency AS posting_currency, p.pay_stated AS posting_pay_stated
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
