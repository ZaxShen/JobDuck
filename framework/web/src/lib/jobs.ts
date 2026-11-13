import { day, statusLabel } from './format'
import type { PostingRow } from './types'

export const ALL_JOBS = ''
export const NOT_APPLIED = 'not_applied'
export const NOT_APPLIED_LABEL = 'Not Applied'
export const NO_DATE = '—'

export interface JobFilterOption {
  value: string
  label: string
}

const titleCase = (text: string) => text.replace(/\b\w/g, (letter) => letter.toUpperCase())

export const statusTitle = (status: string) => titleCase(statusLabel(status))

export const jobFilterOptions = (statuses: readonly string[]): JobFilterOption[] => [
  { value: ALL_JOBS, label: 'All' },
  { value: NOT_APPLIED, label: NOT_APPLIED_LABEL },
  ...statuses.map((status) => ({ value: status, label: statusTitle(status) })),
]

export const jobStatusLabel = (row: Pick<PostingRow, 'application_status'>) =>
  row.application_status === null ? NOT_APPLIED_LABEL : statusTitle(row.application_status)

export const appliedText = (row: Pick<PostingRow, 'applied_at'>) => (row.applied_at ? day(row.applied_at) : NO_DATE)

export const postedText = (row: Pick<PostingRow, 'posted_at'>) => (row.posted_at ? day(row.posted_at) : NO_DATE)

export const JOBS_PAGE_SIZE = 50

export function postingsPath(status: string, offset = 0, limit = JOBS_PAGE_SIZE): string {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (offset > 0) params.set('offset', String(offset))
  params.set('limit', String(limit))
  return `/api/postings?${params.toString()}`
}

export function pageRangeText(offset: number, count: number, total: number): string {
  if (total === 0 || count === 0) return 'No jobs'
  return `Showing ${(offset + 1).toLocaleString('en-US')}–${(offset + count).toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`
}
