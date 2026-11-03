import type { ApplicationEvent, StageKind, StageTypes } from './types'

export const CLOSE_TARGETS = ['deny_by_employer', 'deny_by_candidate', 'no_response'] as const
export const BULK_TARGETS = ['applied', 'interviewing', 'offered', 'accepted', ...CLOSE_TARGETS] as const

const ENTRY_LABELS: Record<string, string> = {
  applied: 'Applied',
  interviewing: 'Interviewing',
  offered: 'Offered',
  accepted: 'Accepted',
  deny_by_employer: 'Rejected',
  deny_by_candidate: 'Withdrew',
  no_response: 'No response',
}

export const entryLabel = (status: string) => ENTRY_LABELS[status] ?? status.replace(/_/g, ' ')

export interface DialogScope {
  stageKind: StageKind | null
  options: readonly string[]
  initial: string
}

const isStageKind = (target: string): target is StageKind => target === 'interviewing' || target === 'offered'

export function dialogScope(target: string, types: StageTypes | null, bulk = false): DialogScope {
  if (bulk) return { stageKind: null, options: BULK_TARGETS, initial: target }
  if (isStageKind(target)) {
    const options = types?.[target] ?? []
    return { stageKind: target, options, initial: options[0] ?? '' }
  }
  if ((CLOSE_TARGETS as readonly string[]).includes(target)) return { stageKind: null, options: CLOSE_TARGETS, initial: target }
  return { stageKind: null, options: [target], initial: target }
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

export function isEntryDate(value: string): boolean {
  const match = DATE_ONLY.exec(value)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export interface StatusEntry {
  choice: string
  date: string
  note: string
}

export interface StatusRequest {
  method: 'PATCH' | 'POST'
  path: string
  body: Record<string, unknown>
}

export function statusRequest(applicationId: number, scope: DialogScope, entry: StatusEntry, expected: string): StatusRequest {
  if (!isEntryDate(entry.date)) throw new Error('Pick the date it happened.')
  const note = entry.note.trim() === '' ? {} : { note: entry.note }
  if (scope.stageKind !== null) {
    return {
      method: 'POST',
      path: `/api/applications/${applicationId}/stages`,
      body: { kind: scope.stageKind, stage_type: entry.choice, scheduled_at: entry.date, ...note, expected_updated_at: expected },
    }
  }
  return {
    method: 'PATCH',
    path: `/api/applications/${applicationId}`,
    body: { status: entry.choice, occurred_at: entry.date, ...note, expected_updated_at: expected },
  }
}

const isStageEntry = (event: ApplicationEvent) => event.stage_type !== null

export const effectiveDate = (event: ApplicationEvent) => event.occurred_at ?? event.scheduled_at ?? event.created_at

function dateValue(value: string): number {
  const match = DATE_ONLY.exec(value)
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

export function timelineOrder<T extends ApplicationEvent>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => dateValue(effectiveDate(b)) - dateValue(effectiveDate(a)) || b.id - a.id)
}

export const isEditableEntry = (event: ApplicationEvent) => !isStageEntry(event)

export function undoableEntryId(events: readonly ApplicationEvent[]): number | null {
  const newest = events.reduce<ApplicationEvent | null>((latest, event) => (latest === null || event.id > latest.id ? event : latest), null)
  if (newest === null || isStageEntry(newest) || newest.from_status === null) return null
  return newest.id
}

export const revertsTo = (event: ApplicationEvent) => (event.from_status === 'pending' ? 'saved' : event.from_status)

export interface EntryDraft {
  date: string
  note: string
}

export const entryDraft = (event: ApplicationEvent, toInput: (value: string) => string): EntryDraft => ({
  date: toInput(effectiveDate(event)),
  note: event.note ?? '',
})

export function entryPatch(original: EntryDraft, draft: EntryDraft): Record<string, unknown> | null {
  if (!isEntryDate(draft.date)) return null
  const patch: Record<string, unknown> = {}
  if (draft.date !== original.date) patch.occurred_at = draft.date
  if (draft.note !== original.note) patch.note = draft.note.trim() === '' ? null : draft.note
  return Object.keys(patch).length > 0 ? patch : null
}
