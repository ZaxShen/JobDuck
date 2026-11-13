export type Density = 'comfortable' | 'compact'

export type PreInterviewStatus = 'pending' | 'saved' | 'applied'

export interface PreInterviewGroup<T> {
  status: PreInterviewStatus
  label: string
  rows: T[]
  count: number
}

export interface VisibleCards<T> {
  visible: T[]
  remaining: number
  more: number
}

export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export const CARD_CAP = 25
export const DENSITY_KEY = 'applications-board-density'
export const COLLAPSED_KEY = 'applications-board-collapsed'
export const DEFAULT_COLLAPSED: readonly PreInterviewStatus[] = ['applied']

const PRE_INTERVIEW: readonly { status: PreInterviewStatus; label: string }[] = [
  { status: 'pending', label: 'Pending' },
  { status: 'saved', label: 'Saved' },
  { status: 'applied', label: 'Applied' },
]

export function preInterviewGroups<T extends { status: string }>(rows: readonly T[]): PreInterviewGroup<T>[] {
  return PRE_INTERVIEW.map(({ status, label }) => {
    const matching = rows.filter((row) => row.status === status)
    return { status, label, rows: matching, count: matching.length }
  })
}

export function visibleCards<T>(rows: readonly T[], shown: number, cap: number = CARD_CAP): VisibleCards<T> {
  const limit = Math.max(shown, cap)
  const visible = rows.slice(0, limit)
  const remaining = rows.length - visible.length
  return { visible, remaining, more: Math.min(cap, remaining) }
}

const browserStorage = (storage?: StorageLike): StorageLike | undefined =>
  storage ?? (globalThis as { localStorage?: StorageLike }).localStorage

export function readDensity(storage?: StorageLike): Density {
  try {
    return browserStorage(storage)?.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable'
  } catch {
    return 'comfortable'
  }
}

export function saveDensity(density: Density, storage?: StorageLike): void {
  try {
    browserStorage(storage)?.setItem(DENSITY_KEY, density)
  } catch {
    return
  }
}

export function readCollapsed(storage?: StorageLike): PreInterviewStatus[] {
  try {
    const raw = browserStorage(storage)?.getItem(COLLAPSED_KEY)
    if (raw == null) return [...DEFAULT_COLLAPSED]
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...DEFAULT_COLLAPSED]
    return PRE_INTERVIEW.map((group) => group.status).filter((status) => parsed.includes(status))
  } catch {
    return [...DEFAULT_COLLAPSED]
  }
}

export function saveCollapsed(collapsed: readonly PreInterviewStatus[], storage?: StorageLike): void {
  try {
    browserStorage(storage)?.setItem(COLLAPSED_KEY, JSON.stringify(collapsed))
  } catch {
    return
  }
}
