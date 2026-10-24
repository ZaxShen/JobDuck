import type { ApplicationRow } from '@/lib/types'

export const statusLabel = (status: string) => status.replace(/_/g, ' ')
export const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '')
export const stamp = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '')

const PERIODS: Record<string, string> = { year: 'a year', month: 'a month', week: 'a week', day: 'a day', hour: 'an hour' }

export function postingPay(posting: Pick<ApplicationRow, 'posting_pay_min' | 'posting_pay_max' | 'posting_pay_period'
  | 'posting_currency' | 'posting_pay_stated'>): string | null {
  const { posting_pay_min: min, posting_pay_max: max, posting_currency: currency, posting_pay_period: period } = posting
  if (min === null && max === null) return posting.posting_pay_stated === 0 ? 'Pay not stated' : null
  const amount = (value: number) => value.toLocaleString()
  const range = min !== null && max !== null && min !== max ? `${amount(min)}–${amount(max)}` : amount((min ?? max)!)
  const per = period ? PERIODS[period] ?? `per ${period}` : null
  return `Posting pay: ${[range, currency, per].filter(Boolean).join(' ')}`
}

export function safeUrl(url: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}
