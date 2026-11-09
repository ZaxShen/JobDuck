import { type ApplicationEvent, type EventSource, getApplication, TERMINAL_STATUSES } from './applications'
import { type Db, nowIso, one, transaction } from './client'
import { checkEventDate } from './dates'
import { INTERVIEW_STAGES, type InterviewStage } from './interviews'

export const FOLLOW_UP_KINDS = ['thank_you_sent', 'follow_up_sent'] as const
export type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number]
export const DUE_KINDS = ['thank_you', 'follow_up'] as const
export type DueKind = (typeof DUE_KINDS)[number]

export const FOLLOW_UP_WAIT_KEY = 'follow_up_business_days'
export const DEFAULT_FOLLOW_UP_WAIT = 3
export const MIN_FOLLOW_UP_WAIT = 1
export const MAX_FOLLOW_UP_WAIT = 30
export const FOLLOW_UP_WAIT_MESSAGE =
  `${FOLLOW_UP_WAIT_KEY} must be a whole number from ${MIN_FOLLOW_UP_WAIT} to ${MAX_FOLLOW_UP_WAIT}`
export const THANK_YOU_WINDOW_MS = 24 * 60 * 60 * 1000
export const GHOSTED_AFTER_FOLLOW_UPS = 2

export interface FollowUpDue {
  kind: DueKind
  application_id: number
  round_id: number
  company: string
  title: string
  stage_type: InterviewStage
  round_at: string
  due_at: string
  follow_ups_sent: number
  suggest_ghosted: boolean
}

export interface FollowUpsView {
  wait_business_days: number
  items: FollowUpDue[]
}

export interface RecordFollowUpInput {
  roundId: number
  kind: FollowUpKind
  sentAt?: string
  note?: string | null
  source?: EventSource
}

const ZONELESS_TIME = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/

const instant = (value: string) => Date.parse(ZONELESS_TIME.test(value) ? `${value}Z` : value)

const isWeekend = (date: Date) => date.getUTCDay() === 0 || date.getUTCDay() === 6

export function addBusinessDays(fromIso: string, n: number): string {
  const start = instant(fromIso)
  if (Number.isNaN(start)) throw new Error(`${fromIso} is not a date`)
  if (!Number.isInteger(n) || n < 0) throw new Error('business days must be a whole number of 0 or more')
  const date = new Date(start)
  if (isWeekend(date)) {
    date.setUTCHours(0, 0, 0, 0)
    while (isWeekend(date)) date.setUTCDate(date.getUTCDate() + 1)
  }
  for (let left = n; left > 0;) {
    date.setUTCDate(date.getUTCDate() + 1)
    if (!isWeekend(date)) left--
  }
  return date.toISOString()
}

const isValidWait = (days: number) => Number.isInteger(days) && days >= MIN_FOLLOW_UP_WAIT && days <= MAX_FOLLOW_UP_WAIT

export function getFollowUpWait(db: Db): number {
  const row = one<{ value: string }>(db.prepare('SELECT value FROM settings WHERE key = ?'), FOLLOW_UP_WAIT_KEY)
  const days = row === undefined ? Number.NaN : Number(row.value)
  return isValidWait(days) ? days : DEFAULT_FOLLOW_UP_WAIT
}

export function setFollowUpWait(db: Db, days: number): number {
  if (!isValidWait(days)) throw new Error(FOLLOW_UP_WAIT_MESSAGE)
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(FOLLOW_UP_WAIT_KEY, String(days), nowIso())
  return days
}

const stagePlaceholders = INTERVIEW_STAGES.map(() => '?').join(', ')
const terminalPlaceholders = TERMINAL_STATUSES.map(() => '?').join(', ')

const ROUND_WHERE = `e.kind IS NULL AND e.to_status = 'interviewing' AND e.stage_type IN (${stagePlaceholders})`

const LIVE_APPLICATION = `a.deleted_at IS NULL AND a.status NOT IN (${terminalPlaceholders})`

interface RoundRow {
  id: number
  application_id: number
  stage_type: InterviewStage
  outcome: string | null
  round_at: string
  company: string
  title: string
}

interface EventRow {
  id: number
  application_id: number
  kind: FollowUpKind | null
  round_id: number | null
  is_round: number
  at: string
}

function loadRounds(db: Db): RoundRow[] {
  return db.prepare(`SELECT e.id, e.application_id, e.stage_type, e.outcome,
      COALESCE(e.scheduled_at, e.occurred_at) AS round_at,
      COALESCE(a.company_override, p.company) AS company, COALESCE(a.title_override, p.title) AS title
    FROM application_events e
    JOIN applications a ON a.id = e.application_id
    JOIN postings p ON p.id = a.posting_id
    WHERE ${ROUND_WHERE} AND ${LIVE_APPLICATION} AND COALESCE(e.scheduled_at, e.occurred_at) IS NOT NULL`)
    .all(...INTERVIEW_STAGES, ...TERMINAL_STATUSES) as RoundRow[]
}

function loadEvents(db: Db): EventRow[] {
  return db.prepare(`SELECT e.id, e.application_id, e.kind, e.round_id,
      CASE WHEN ${ROUND_WHERE} THEN 1 ELSE 0 END AS is_round,
      COALESCE(e.scheduled_at, e.occurred_at, e.created_at) AS at
    FROM application_events e
    JOIN applications a ON a.id = e.application_id
    WHERE ${LIVE_APPLICATION}`)
    .all(...INTERVIEW_STAGES, ...TERMINAL_STATUSES) as EventRow[]
}

function followUpAnchor(round: RoundRow, roundTime: number, events: EventRow[]): number {
  let anchor = roundTime
  for (const event of events) {
    if (event.id === round.id) continue
    const time = instant(event.at)
    if (Number.isNaN(time)) continue
    if (event.id > round.id || (event.is_round === 1 && time > roundTime)) anchor = Math.max(anchor, time)
  }
  return anchor
}

export function listFollowUpsDue(db: Db, now: Date = new Date()): FollowUpDue[] {
  const wait = getFollowUpWait(db)
  const current = now.getTime()
  const byApplication = new Map<number, EventRow[]>()
  for (const event of loadEvents(db)) {
    const list = byApplication.get(event.application_id) ?? []
    list.push(event)
    byApplication.set(event.application_id, list)
  }
  const items: FollowUpDue[] = []
  for (const round of loadRounds(db)) {
    const roundTime = instant(round.round_at)
    if (Number.isNaN(roundTime) || roundTime > current) continue
    const events = byApplication.get(round.application_id) ?? []
    const sent = (kind: FollowUpKind) => events.filter((event) => event.kind === kind && event.round_id === round.id).length
    const followUpsSent = sent('follow_up_sent')
    const item = (kind: DueKind, dueAt: number): FollowUpDue => ({
      kind, application_id: round.application_id, round_id: round.id, company: round.company, title: round.title,
      stage_type: round.stage_type, round_at: round.round_at, due_at: new Date(dueAt).toISOString(),
      follow_ups_sent: followUpsSent, suggest_ghosted: followUpsSent >= GHOSTED_AFTER_FOLLOW_UPS,
    })
    const thankYouDue = roundTime + THANK_YOU_WINDOW_MS
    if (current < thankYouDue && sent('thank_you_sent') === 0) items.push(item('thank_you', thankYouDue))
    if (round.outcome === 'pending') {
      const anchor = new Date(followUpAnchor(round, roundTime, events)).toISOString()
      const followUpDue = instant(addBusinessDays(anchor, wait))
      if (current >= followUpDue) items.push(item('follow_up', followUpDue))
    }
  }
  return items.sort((a, b) => a.due_at.localeCompare(b.due_at) || a.round_id - b.round_id || a.kind.localeCompare(b.kind))
}

export function followUpsDue(db: Db, now: Date = new Date()): FollowUpsView {
  return { wait_business_days: getFollowUpWait(db), items: listFollowUpsDue(db, now) }
}

function getRound(db: Db, roundId: number): ApplicationEvent {
  const round = one<ApplicationEvent>(db.prepare(`SELECT e.* FROM application_events e
      JOIN applications a ON a.id = e.application_id
      WHERE e.id = ? AND a.deleted_at IS NULL AND ${ROUND_WHERE}`), roundId, ...INTERVIEW_STAGES)
  if (!round) throw new Error(`event ${roundId} is not an interview round`)
  return round
}

export function recordFollowUp(db: Db, input: RecordFollowUpInput): ApplicationEvent {
  if (!(FOLLOW_UP_KINDS as readonly string[]).includes(input.kind)) {
    throw new Error(`kind must be one of ${FOLLOW_UP_KINDS.join(', ')}`)
  }
  const sentAt = input.sentAt === undefined ? undefined : checkEventDate(input.sentAt, 'sent_at')
  return transaction(db, () => {
    const round = getRound(db, input.roundId)
    const application = getApplication(db, round.application_id)
    if (!application) throw new Error(`application ${round.application_id} not found`)
    const now = nowIso()
    const event = one<ApplicationEvent>(db.prepare(`INSERT INTO application_events
        (application_id, from_status, to_status, note, source, occurred_at, kind, round_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *`),
      application.id, application.status, application.status, input.note ?? null, input.source ?? 'agent',
      sentAt ?? now, input.kind, round.id, now)
    if (!event) throw new Error('recordFollowUp returned no event')
    db.prepare('UPDATE applications SET updated_at = ? WHERE id = ?').run(now, application.id)
    return event
  })
}
