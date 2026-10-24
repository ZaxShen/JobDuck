import type { StageKind } from '@/lib/types'

const STAGE_LABELS: Record<string, string> = {
  information: 'Information',
  phone_screen: 'Phone screen',
  online_assessment: 'Online assessment',
  hiring_manager: 'Hiring manager',
  technical: 'Technical',
  behavioral: 'Behavioral',
  system_design: 'System design',
  onsite: 'Onsite',
  take_home: 'Take home',
  other: 'Other',
  verbal: 'Verbal',
  written: 'Written',
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ')

export const stageTypeLabel = (stageType: string) => STAGE_LABELS[stageType] ?? capitalize(stageType)
export const outcomeLabel = capitalize
export const kindLabel = (kind: StageKind) => (kind === 'interviewing' ? 'Interview' : 'Offer')

export const OUTCOME_TONES: Record<string, string> = {
  pending: 'text-muted-foreground',
  advanced: 'border-green-600/40 text-green-700 dark:text-green-400',
  rejected: 'border-destructive/40 text-destructive',
  ghosted: 'border-amber-500/40 text-amber-700 dark:text-amber-400',
  cancelled: 'text-muted-foreground',
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

export function scheduledLabel(value: string | null): string {
  if (!value) return 'No date'
  const date = DATE_ONLY.exec(value)
  if (date) return new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).toLocaleDateString()
  return new Date(value).toLocaleString()
}

export function dateInputValue(value: string | null): string {
  if (!value) return ''
  if (DATE_ONLY.test(value)) return value
  const date = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function scheduledPatch(original: string | null, input: string): string | null | undefined {
  if (input === dateInputValue(original)) return undefined
  return input === '' ? null : input
}
