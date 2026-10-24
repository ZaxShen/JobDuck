import { existsSync } from 'node:fs'
import { loadPermissions } from '../config/permissions'
import { getApplication, isTerminal } from '../db/applications'
import { type Db, nowIso, openDb, transaction } from '../db/client'
import { migrate } from '../db/migrate'
import {
  type LiveApplication, applyOutcomeMatch, findOutcomeByMessageId, insertOutcome, listLiveApplicationsForMatching,
  markSynced, setNeedsMatch,
} from '../db/outcomes'
import { dbPath, jobduckHome, permissionsPath, resolveWorkspace } from '../paths'
import { type FetchLike, type SyncOutcome, createSyncClient } from '../sync/client'
import { type MatchDecision, type MatchKind, type ScoredCandidate, markerId, matchOutcome as decideMatch } from '../sync/match'

export interface SyncOptions {
  dryRun?: boolean
  json?: boolean
  home?: string
  workspace?: string
  fetch?: FetchLike
  out?: (line: string) => void
  err?: (line: string) => void
}

export type SyncResultKind = 'matched' | 'needs_match' | 'known' | 'failed'

export interface SyncRow {
  messageId: string
  receivedAt: string
  company: string | null
  title: string | null
  result: SyncResultKind
  matchedBy?: MatchKind
  applicationId?: number
  candidates?: ScoredCandidate[]
  error?: string
}

export interface SyncTotals {
  fetched: number
  matched: Record<MatchKind, number> & { total: number }
  needs_match: number
  known: number
  failed: number
}

const MATCH_KINDS: MatchKind[] = ['marker', 'url', 'ref', 'company_title']
const SETUP_HINT = 'jobduck sync is not configured: turn on the track module and set [track] sync_url and sync_token '
  + '(ask your agent to run the setup skill with --module track).'

function configured(home: string): { url: string; token: string } | null {
  try {
    const permissions = loadPermissions(permissionsPath(home))
    const { sync_url: url, sync_token: token } = permissions.track
    if (!permissions.modules.track || !url.trim() || !token.trim()) return null
    return { url: url.trim(), token: token.trim() }
  } catch {
    return null
  }
}

function decide(db: Db | null, outcome: SyncOutcome, live: LiveApplication[]): MatchDecision {
  const marker = markerId(outcome.applicationId)
  const markerApp = db !== null && marker !== null ? getApplication(db, marker) : undefined
  if (markerApp && isTerminal(markerApp.status)) return { kind: 'marker', applicationId: markerApp.id }
  return decideMatch(outcome, live)
}

function rowFor(outcome: SyncOutcome, decision: MatchDecision): SyncRow {
  const base = { messageId: outcome.messageId, receivedAt: outcome.receivedAt, company: outcome.company ?? null, title: outcome.title ?? null }
  return decision.kind === 'none'
    ? { ...base, result: 'needs_match', candidates: decision.candidates }
    : { ...base, result: 'matched', matchedBy: decision.kind, applicationId: decision.applicationId }
}

function store(db: Db, outcome: SyncOutcome): { row: SyncRow; outcomeId: number } {
  return transaction(db, () => {
    const existing = findOutcomeByMessageId(db, outcome.messageId)
    if (existing) {
      return {
        outcomeId: existing.id,
        row: {
          messageId: outcome.messageId, receivedAt: outcome.receivedAt, company: outcome.company ?? null,
          title: outcome.title ?? null, result: 'known' as const,
        },
      }
    }
    const marker = markerId(outcome.applicationId)
    const markerApp = marker === null ? undefined : getApplication(db, marker)
    const stored = insertOutcome(db, {
      message_id: outcome.messageId, kind: 'rejection', status: 'pending',
      company: outcome.company ?? null, title: outcome.title ?? null,
      job_url: outcome.jobUrl ?? null, job_ref: outcome.jobRef ?? null,
      received_at: outcome.receivedAt, application_id: markerApp?.id ?? null,
    })
    const decision = decide(db, outcome, listLiveApplicationsForMatching(db))
    if (decision.kind === 'none') setNeedsMatch(db, stored.id, decision.candidates)
    else applyOutcomeMatch(db, stored.id, decision.applicationId, { source: 'sync', matchedBy: decision.kind })
    return { outcomeId: stored.id, row: rowFor(outcome, decision) }
  })
}

function plan(db: Db | null, outcomes: SyncOutcome[]): SyncRow[] {
  let live = db === null ? [] : listLiveApplicationsForMatching(db)
  return outcomes.map((outcome) => {
    if (db !== null && findOutcomeByMessageId(db, outcome.messageId)) {
      return {
        messageId: outcome.messageId, receivedAt: outcome.receivedAt, company: outcome.company ?? null,
        title: outcome.title ?? null, result: 'known',
      }
    }
    const decision = decide(db, outcome, live)
    if (decision.kind !== 'none') live = live.filter((candidate) => candidate.id !== decision.applicationId)
    return rowFor(outcome, decision)
  })
}

export function totalsOf(rows: SyncRow[]): SyncTotals {
  const matched = Object.fromEntries(MATCH_KINDS.map((kind) => [kind, 0])) as Record<MatchKind, number>
  for (const row of rows) if (row.result === 'matched' && row.matchedBy) matched[row.matchedBy]++
  const count = (result: SyncResultKind) => rows.filter((row) => row.result === result).length
  return {
    fetched: rows.length,
    matched: { total: count('matched'), ...matched },
    needs_match: count('needs_match'),
    known: count('known'),
    failed: count('failed'),
  }
}

const describe = (row: SyncRow, dryRun: boolean) => {
  if (row.result === 'matched') return `${dryRun ? 'would match' : 'matched'} #${row.applicationId} (${row.matchedBy})`
  if (row.result === 'needs_match') {
    const ids = (row.candidates ?? []).map((candidate) => `#${candidate.application_id}`).join(', ')
    return `${dryRun ? 'would need a match' : 'needs a match'}${ids ? ` (candidates ${ids})` : ''}`
  }
  if (row.result === 'known') return 'already stored'
  return `failed: ${row.error}`
}

function printTable(rows: SyncRow[], totals: SyncTotals, dryRun: boolean, out: (line: string) => void) {
  const table = rows.map((row) => [row.receivedAt.slice(0, 10), row.company ?? '?', row.title ?? '', describe(row, dryRun)])
  const widths = [0, 1, 2].map((i) => Math.min(40, Math.max(0, ...table.map((cells) => cells[i]!.length))))
  const cell = (value: string, width: number) => (value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width))
  for (const cells of table) out(`${cells.slice(0, 3).map((value, i) => cell(value, widths[i]!)).join('  ')}  ${cells[3]}`)
  const kinds = MATCH_KINDS.map((kind) => `${kind} ${totals.matched[kind]}`).join(', ')
  const failed = totals.failed > 0 ? ` / failed ${totals.failed}` : ''
  out(`fetched ${totals.fetched} / matched ${totals.matched.total} (${kinds}) / needs_match ${totals.needs_match} / known ${totals.known}${failed}`)
}

function openForPlan(home: string): Db | null {
  const path = dbPath(home)
  return existsSync(path) ? openDb(path, { readonly: true }) : null
}

export async function runSync(options: SyncOptions = {}): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line))
  const err = options.err ?? ((line: string) => console.error(line))
  const home = options.home ?? jobduckHome(resolveWorkspace(options.workspace ?? process.cwd()))
  const dryRun = options.dryRun ?? false

  const config = configured(home)
  if (config === null) {
    err(SETUP_HINT)
    return 2
  }
  const client = createSyncClient({ ...config, fetch: options.fetch })

  let scriptVersion: string
  let outcomes: SyncOutcome[]
  try {
    const pending = await client.pending()
    scriptVersion = pending.scriptVersion
    outcomes = pending.outcomes
  } catch (error) {
    err(error instanceof Error ? error.message : String(error))
    return 1
  }

  let rows: SyncRow[]
  let acked = 0
  let exitCode = 0
  if (dryRun) {
    const db = openForPlan(home)
    try {
      rows = plan(db, outcomes)
    } finally {
      db?.close()
    }
  } else {
    const db = openDb(dbPath(home))
    try {
      migrate(db)
      rows = []
      const stored: { messageId: string; outcomeId: number }[] = []
      for (const outcome of outcomes) {
        try {
          const result = store(db, outcome)
          rows.push(result.row)
          stored.push({ messageId: outcome.messageId, outcomeId: result.outcomeId })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          rows.push({
            messageId: outcome.messageId, receivedAt: outcome.receivedAt, company: outcome.company ?? null,
            title: outcome.title ?? null, result: 'failed', error: message,
          })
          err(`could not store outcome ${outcome.messageId}: ${message}`)
          exitCode = 1
        }
      }
      if (stored.length > 0) {
        try {
          acked = await client.ack(stored.map((entry) => entry.messageId))
          markSynced(db, stored.map((entry) => entry.outcomeId), nowIso())
        } catch (error) {
          err(error instanceof Error ? error.message : String(error))
          exitCode = 1
        }
      }
    } finally {
      db.close()
    }
  }

  const totals = totalsOf(rows)
  if (options.json) {
    out(JSON.stringify({ dryRun, scriptVersion, outcomes: rows, totals, acked }, null, 2))
  } else {
    if (dryRun) out('Dry run: nothing stored or acknowledged.')
    printTable(rows, totals, dryRun, out)
  }
  return exitCode
}
