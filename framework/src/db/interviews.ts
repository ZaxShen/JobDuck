import { z } from 'zod'
import {
  type Application, type ApplicationEvent, type ApplicationStatus, type EventSource, formatIssues, getApplication,
  isTerminal,
} from './applications'
import { type Db, nowIso, one, transaction } from './client'

export const INTERVIEW_STAGES = [
  'information', 'phone_screen', 'online_assessment', 'hiring_manager', 'technical',
  'behavioral', 'system_design', 'onsite', 'take_home', 'other',
] as const
export const OFFER_STAGES = ['verbal', 'written'] as const
export const STAGE_TYPES = [...INTERVIEW_STAGES, ...OFFER_STAGES] as const
export const STAGE_OUTCOMES = ['pending', 'advanced', 'rejected', 'ghosted', 'cancelled'] as const
export const STAGE_KINDS = ['interviewing', 'offered'] as const

export type InterviewStage = (typeof INTERVIEW_STAGES)[number]
export type OfferStage = (typeof OFFER_STAGES)[number]
export type StageType = (typeof STAGE_TYPES)[number]
export type StageOutcome = (typeof STAGE_OUTCOMES)[number]
export type StageKind = (typeof STAGE_KINDS)[number]

export const MAX_CONTACTS = 20
export const SCHEDULED_AT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/
export const SCHEDULED_AT_MESSAGE = 'scheduled_at must be an ISO date (YYYY-MM-DD) or timestamp (YYYY-MM-DDTHH:MM:SSZ)'

const optionalText = (max: number) => z.string().trim().max(max).nullish()
  .transform((value) => (value ? value : undefined))

export const ContactSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(200),
  title: optionalText(200),
  email: optionalText(320).refine((value) => value === undefined || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    'email is invalid'),
  phone: optionalText(50),
  linkedin: optionalText(500),
})
export const ContactsSchema = z.array(ContactSchema).max(MAX_CONTACTS, `at most ${MAX_CONTACTS} contacts`)

export type Contact = z.output<typeof ContactSchema>
export type ContactInput = z.input<typeof ContactSchema>

export interface Stage extends Omit<ApplicationEvent, 'to_status' | 'stage_type' | 'outcome'> {
  to_status: StageKind
  stage_type: StageType
  outcome: StageOutcome | null
  contacts: Contact[]
}

export interface AddStageInput {
  kind: StageKind
  stageType: StageType
  scheduledAt?: string | null
  outcome?: StageOutcome | null
  note?: string | null
  contacts?: ContactInput[]
  source?: EventSource
}

export interface StagePatch {
  stageType?: StageType
  scheduledAt?: string | null
  outcome?: StageOutcome | null
  note?: string | null
  contacts?: ContactInput[]
}

const RANK: Partial<Record<ApplicationStatus, number>> = { saved: 0, pending: 0, applied: 1, interviewing: 2, offered: 3 }

const isStageKind = (status: string): status is StageKind => (STAGE_KINDS as readonly string[]).includes(status)

export function stageTypesFor(kind: StageKind): readonly StageType[] {
  return kind === 'interviewing' ? INTERVIEW_STAGES : OFFER_STAGES
}

function checkStageType(kind: StageKind, stageType: string): StageType {
  const allowed = stageTypesFor(kind)
  if (!(allowed as readonly string[]).includes(stageType)) {
    throw new Error(`stage_type ${stageType} is not valid for ${kind}; use one of ${allowed.join(', ')}`)
  }
  return stageType as StageType
}

function checkOutcome(outcome: string | null): StageOutcome | null {
  if (outcome !== null && !(STAGE_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new Error(`outcome ${outcome} is not valid; use one of ${STAGE_OUTCOMES.join(', ')}`)
  }
  return outcome as StageOutcome | null
}

function checkScheduledAt(value: string | null): string | null {
  if (value === null) return null
  if (!SCHEDULED_AT.test(value) || Number.isNaN(Date.parse(value))) throw new Error(SCHEDULED_AT_MESSAGE)
  return value
}

function checkContacts(contacts: ContactInput[]): Contact[] {
  const parsed = ContactsSchema.safeParse(contacts)
  if (!parsed.success) throw new Error(`contacts: ${formatIssues(parsed.error)}`)
  return parsed.data
}

function parseMetadata(metadata: string | null): Record<string, unknown> {
  if (metadata === null) return {}
  try {
    const parsed: unknown = JSON.parse(metadata)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export function parseContacts(metadata: string | null): Contact[] {
  const contacts = parseMetadata(metadata).contacts
  if (!Array.isArray(contacts)) return []
  return contacts.flatMap((contact) => {
    const parsed = ContactSchema.safeParse(contact)
    return parsed.success ? [parsed.data] : []
  })
}

const withContacts = (metadata: string | null, contacts: Contact[]) =>
  JSON.stringify({ ...parseMetadata(metadata), contacts })

const toStage = (event: ApplicationEvent): Stage => ({
  ...event,
  to_status: event.to_status as StageKind,
  stage_type: event.stage_type as StageType,
  outcome: event.outcome as StageOutcome | null,
  contacts: parseContacts(event.metadata),
})

function getStageEvent(db: Db, eventId: number): ApplicationEvent {
  const event = one<ApplicationEvent>(db.prepare(`SELECT e.* FROM application_events e
      JOIN applications a ON a.id = e.application_id
      WHERE e.id = ? AND a.deleted_at IS NULL`), eventId)
  if (!event) throw new Error(`event ${eventId} not found`)
  if (event.stage_type === null || !isStageKind(event.to_status)) {
    throw new Error(`event ${eventId} is not an interview or offer stage`)
  }
  return event
}

export function getStage(db: Db, eventId: number): Stage {
  return toStage(getStageEvent(db, eventId))
}

export function listStages(db: Db, applicationId: number): Stage[] {
  return (db.prepare(`SELECT * FROM application_events
      WHERE application_id = ? AND stage_type IS NOT NULL AND to_status IN ('interviewing', 'offered')
      ORDER BY COALESCE(scheduled_at, created_at), id`)
    .all(applicationId) as ApplicationEvent[]).map(toStage)
}

const touchApplication = (db: Db, applicationId: number, now: string) =>
  db.prepare('UPDATE applications SET updated_at = ? WHERE id = ?').run(now, applicationId)

export function addStage(db: Db, applicationId: number, input: AddStageInput): { application: Application; stage: Stage } {
  if (!isStageKind(input.kind)) throw new Error(`kind must be one of ${STAGE_KINDS.join(', ')}`)
  const stageType = checkStageType(input.kind, input.stageType)
  const outcome = checkOutcome(input.outcome === undefined ? (input.kind === 'interviewing' ? 'pending' : null) : input.outcome)
  const scheduledAt = checkScheduledAt(input.scheduledAt ?? null)
  const contacts = input.contacts === undefined ? undefined : checkContacts(input.contacts)
  const source = input.source ?? 'agent'
  return transaction(db, () => {
    const current = getApplication(db, applicationId)
    if (!current) throw new Error(`application ${applicationId} not found`)
    const now = nowIso()
    const advance = !isTerminal(current.status) && (RANK[current.status] ?? Infinity) < RANK[input.kind]!
    const application = one<Application>(db.prepare(`UPDATE applications
        SET status = ?, pending_reason = ?, applied_at = COALESCE(applied_at, ?), updated_at = ?
        WHERE id = ?
        RETURNING *`),
      advance ? input.kind : current.status, advance ? null : current.pending_reason, now, now, applicationId)
    if (!application) throw new Error(`application ${applicationId} not found`)
    const event = one<ApplicationEvent>(db.prepare(`INSERT INTO application_events
        (application_id, from_status, to_status, note, source, metadata, stage_type, scheduled_at, outcome, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *`),
      applicationId, current.status, input.kind, input.note ?? null, source,
      contacts === undefined ? null : JSON.stringify({ contacts }), stageType, scheduledAt, outcome, now)
    if (!event) throw new Error('addStage returned no event')
    return { application, stage: toStage(event) }
  })
}

export function updateStage(db: Db, eventId: number, patch: StagePatch): Stage {
  return transaction(db, () => {
    const event = getStageEvent(db, eventId)
    const kind = event.to_status as StageKind
    const assignments: string[] = []
    const params: unknown[] = []
    const set = (column: string, value: unknown) => {
      assignments.push(`${column} = ?`)
      params.push(value)
    }
    if (patch.stageType !== undefined) set('stage_type', checkStageType(kind, patch.stageType))
    if (patch.scheduledAt !== undefined) set('scheduled_at', checkScheduledAt(patch.scheduledAt))
    if (patch.outcome !== undefined) set('outcome', checkOutcome(patch.outcome))
    if (patch.note !== undefined) set('note', patch.note)
    if (patch.contacts !== undefined) set('metadata', withContacts(event.metadata, checkContacts(patch.contacts)))
    if (assignments.length === 0) return toStage(event)
    const updated = one<ApplicationEvent>(db.prepare(`UPDATE application_events SET ${assignments.join(', ')}
        WHERE id = ?
        RETURNING *`), ...params, eventId)
    if (!updated) throw new Error(`event ${eventId} not found`)
    touchApplication(db, event.application_id, nowIso())
    return toStage(updated)
  })
}

export function deleteStage(db: Db, eventId: number): Stage {
  return transaction(db, () => {
    const stage = toStage(getStageEvent(db, eventId))
    db.prepare('DELETE FROM application_events WHERE id = ?').run(eventId)
    touchApplication(db, stage.application_id, nowIso())
    return stage
  })
}
