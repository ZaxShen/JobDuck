import { TERMINAL_STATUSES, type Application, type EventSource, getApplication, isTerminal, setStatus } from './applications'
import { type Db, nowIso, one, transaction } from './client'

export const OUTCOME_STATUSES = ['pending', 'matched', 'needs_match', 'dismissed'] as const
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number]
export const OUTCOME_KINDS = ['rejection'] as const
export type OutcomeKind = (typeof OUTCOME_KINDS)[number]

export interface Outcome {
  id: number
  message_id: string
  kind: OutcomeKind
  company: string | null
  title: string | null
  job_url: string | null
  job_ref: string | null
  received_at: string
  application_id: number | null
  status: OutcomeStatus
  matched_by: string | null
  candidates: string | null
  synced_at: string | null
  created_at: string
}

export interface OutcomeInput {
  message_id: string
  kind: OutcomeKind
  company?: string | null
  title?: string | null
  job_url?: string | null
  job_ref?: string | null
  received_at: string
  application_id?: number | null
  status: OutcomeStatus
  matched_by?: string | null
  candidates?: unknown
}

export interface MatchResult {
  outcome: Outcome
  application: Application
}

export function getOutcome(db: Db, id: number): Outcome | undefined {
  return one<Outcome>(db.prepare('SELECT * FROM outcomes WHERE id = ?'), id)
}

export function insertOutcome(db: Db, input: OutcomeInput): Outcome {
  const candidates = input.candidates === undefined || input.candidates === null ? null : JSON.stringify(input.candidates)
  return transaction(db, () => {
    const inserted = one<Outcome>(db.prepare(`INSERT INTO outcomes
        (message_id, kind, company, title, job_url, job_ref, received_at, application_id, status, matched_by, candidates, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (message_id) DO NOTHING
        RETURNING *`),
      input.message_id, input.kind, input.company ?? null, input.title ?? null, input.job_url ?? null,
      input.job_ref ?? null, input.received_at, input.application_id ?? null, input.status,
      input.matched_by ?? null, candidates, nowIso())
    const row = inserted ?? one<Outcome>(db.prepare('SELECT * FROM outcomes WHERE message_id = ?'), input.message_id)
    if (!row) throw new Error(`outcome ${input.message_id} could not be stored`)
    return row
  })
}

export function listOutcomes(db: Db, filter: { status?: OutcomeStatus } = {}): Outcome[] {
  if (filter.status === undefined) return db.prepare('SELECT * FROM outcomes ORDER BY received_at DESC, id DESC').all() as Outcome[]
  return db.prepare('SELECT * FROM outcomes WHERE status = ? ORDER BY received_at DESC, id DESC')
    .all(filter.status) as Outcome[]
}

export interface MatchOptions {
  source: EventSource
  matchedBy?: string
}

export function applyOutcomeMatch(db: Db, outcomeId: number, applicationId: number, options: MatchOptions): MatchResult {
  return transaction(db, () => {
    const outcome = getOutcome(db, outcomeId)
    if (!outcome) throw new Error(`outcome ${outcomeId} not found`)
    const current = getApplication(db, applicationId)
    if (!current) throw new Error(`application ${applicationId} not found`)
    const application = isTerminal(current.status)
      ? current
      : setStatus(db, applicationId, 'deny_by_employer', {
        source: options.source,
        note: `Rejection email ${outcome.received_at}`,
        metadata: { outcome_id: outcomeId },
      })
    const updated = one<Outcome>(db.prepare(`UPDATE outcomes SET status = 'matched', matched_by = ?, application_id = ?
        WHERE id = ? RETURNING *`), options.matchedBy ?? options.source, applicationId, outcomeId)
    if (!updated) throw new Error(`outcome ${outcomeId} not found`)
    return { outcome: updated, application }
  })
}

export const matchOutcome = applyOutcomeMatch

export function findOutcomeByMessageId(db: Db, messageId: string): Outcome | undefined {
  return one<Outcome>(db.prepare('SELECT * FROM outcomes WHERE message_id = ?'), messageId)
}

export function setNeedsMatch(db: Db, id: number, candidates: unknown): Outcome {
  const row = one<Outcome>(db.prepare(`UPDATE outcomes SET status = 'needs_match', candidates = ?
      WHERE id = ? RETURNING *`), JSON.stringify(candidates ?? []), id)
  if (!row) throw new Error(`outcome ${id} not found`)
  return row
}

const SYNC_CHUNK = 500

export function markSynced(db: Db, ids: number[], at: string): number {
  let changed = 0
  for (let i = 0; i < ids.length; i += SYNC_CHUNK) {
    const chunk = ids.slice(i, i + SYNC_CHUNK)
    const result = db.prepare(`UPDATE outcomes SET synced_at = ? WHERE id IN (${chunk.map(() => '?').join(', ')})`)
      .run(at, ...chunk)
    changed += Number(result.changes)
  }
  return changed
}

export interface LiveApplication {
  id: number
  status: Application['status']
  company: string
  title: string
  company_override: string | null
  title_override: string | null
  url: string
  url_key: string
  source_id: string | null
  applied_at: string | null
}

export function listLiveApplicationsForMatching(db: Db): LiveApplication[] {
  return db.prepare(`SELECT a.id, a.status, a.applied_at, a.company_override, a.title_override,
      COALESCE(a.company_override, p.company) AS company,
      COALESCE(a.title_override, p.title) AS title,
      p.url, p.url_key, p.source_id
    FROM applications a JOIN postings p ON p.id = a.posting_id
    WHERE a.deleted_at IS NULL AND a.status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(', ')})
    ORDER BY a.id`).all(...TERMINAL_STATUSES) as LiveApplication[]
}

export function dismissOutcome(db: Db, id: number): Outcome {
  const row = one<Outcome>(db.prepare("UPDATE outcomes SET status = 'dismissed' WHERE id = ? RETURNING *"), id)
  if (!row) throw new Error(`outcome ${id} not found`)
  return row
}
