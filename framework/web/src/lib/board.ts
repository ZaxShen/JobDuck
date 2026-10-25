export type StageKey = 'pre_interview' | 'interviewing' | 'offer' | 'closed'

export interface StageColumn {
  key: StageKey
  label: string
  statuses: readonly string[]
}

export interface StatusAction {
  label: string
  target: string
  hint: string
}

export interface StatusActions {
  advance: StatusAction[]
  close: StatusAction[]
}

export const stageColumns = (terminal: readonly string[]): StageColumn[] => [
  { key: 'pre_interview', label: 'Pre-interview', statuses: ['saved', 'pending', 'applied'] },
  { key: 'interviewing', label: 'Interviewing', statuses: ['interviewing'] },
  { key: 'offer', label: 'Offer', statuses: ['offered'] },
  { key: 'closed', label: 'Closed', statuses: terminal },
]

export function stageOf(status: string, terminal: readonly string[]): StageKey {
  return stageColumns(terminal).find((column) => column.statuses.includes(status))?.key ?? 'pre_interview'
}

const HIDDEN_HINT = 'It moves to Closed on the board; List hides it until you click Show hidden.'

const MARK_APPLIED: StatusAction = {
  label: 'Mark applied',
  target: 'applied',
  hint: 'Records today as the date you applied.',
}

const ADVANCE: Record<string, StatusAction> = {
  saved: MARK_APPLIED,
  pending: MARK_APPLIED,
  applied: {
    label: 'Move to interviewing',
    target: 'interviewing',
    hint: 'Add the round and its contacts under Interviews in the details.',
  },
  interviewing: {
    label: 'Mark offer',
    target: 'offered',
    hint: 'Records an offer; add the amounts under Pay in the details.',
  },
  offered: {
    label: 'Mark accepted',
    target: 'accepted',
    hint: `Accepting closes the application. ${HIDDEN_HINT}`,
  },
}

const CLOSE: readonly StatusAction[] = [
  { label: 'Reject', target: 'deny_by_employer', hint: `The employer turned you down. ${HIDDEN_HINT}` },
  { label: 'Withdraw', target: 'deny_by_candidate', hint: `You withdrew or declined. ${HIDDEN_HINT}` },
  { label: 'No response', target: 'no_response', hint: `The employer never replied. ${HIDDEN_HINT}` },
]

const CLOSED_TARGETS = new Set(['accepted', ...CLOSE.map((action) => action.target)])

export function statusActions(status: string): StatusActions {
  if (CLOSED_TARGETS.has(status)) return { advance: [], close: [] }
  const advance = ADVANCE[status]
  return {
    advance: advance ? [advance] : [],
    close: CLOSE.filter((action) => action.target !== status),
  }
}

const DAY_MS = 86_400_000

export function daysSince(iso: string, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY_MS))
}
