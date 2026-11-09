import { stageTypeLabel } from './stages'
import type { FollowUpEventKind, FollowUpItem, FollowUpKind } from './types'

export const FOLLOW_UPS_PATH = '/api/follow-ups'

const KIND_LABELS: Record<FollowUpKind, string> = { thank_you: 'Thank-You Note', follow_up: 'Follow-Up' }

const SENT_LABELS: Record<FollowUpEventKind, string> = { thank_you_sent: 'Thank-You Sent', follow_up_sent: 'Follow-Up Sent' }

export const followUpKindLabel = (kind: FollowUpKind) => KIND_LABELS[kind]

export const followUpSentLabel = (kind: FollowUpEventKind) => SENT_LABELS[kind]

export const GHOSTED_HINT = 'No Reply After 2 Follow-Ups — Consider Marking Ghosted'

export const waitLabel = (days: number) => `After ${days} Business ${days === 1 ? 'Day' : 'Days'}`

const DUE_FORMAT: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }

export function dueText(item: Pick<FollowUpItem, 'due_at'>, now: Date = new Date(), locale?: string): string {
  const due = new Date(item.due_at)
  if (Number.isNaN(due.getTime())) return 'Due Now'
  const when = due.toLocaleString(locale, DUE_FORMAT)
  return due.getTime() <= now.getTime() ? `Overdue Since ${when}` : `Due By ${when}`
}

export function followUpPrompt(item: FollowUpItem): string {
  const note = followUpKindLabel(item.kind).toLowerCase()
  return `Run the Job Duck follow-up skill for my ${note} to ${item.company} for the ${item.title} role ` +
    `(${stageTypeLabel(item.stage_type)} round, round_id ${item.round_id}). ` +
    `First check my mail for a reply from ${item.company}, then draft the ${note} for me to review. ` +
    'Do not send it; I send it from my own mail client.'
}

export function allFollowUpsPrompt(): string {
  return 'Any follow-ups due? Run the Job Duck follow-up skill: list the thank-you notes and follow-ups that are due, ' +
    'check my mail for a reply from each company first, and draft each note for me to review. ' +
    'Do not send anything; I send every note from my own mail client.'
}
