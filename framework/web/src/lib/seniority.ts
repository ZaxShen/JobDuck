import { SENIORITY } from './forms'

export type Seniority = (typeof SENIORITY)[number]
export type Track = 'ic' | 'manager' | 'both'

export const TRACKS: readonly (readonly [Track, string])[] = [
  ['ic', 'Individual Contributor'],
  ['manager', 'Manager'],
  ['both', 'Both'],
]

export const SENIORITY_LABELS: Record<Seniority, string> = {
  intern: 'Intern',
  entry: 'Entry Level',
  mid: 'Mid Level',
  senior: 'Senior',
  staff: 'Staff',
  principal: 'Principal',
  lead: 'Lead',
  manager: 'Manager',
  director: 'Director',
  executive: 'Executive',
}

const IC_LEVELS: readonly Seniority[] = ['intern', 'entry', 'mid', 'senior', 'staff', 'principal', 'lead']
const MANAGER_LEVELS: readonly Seniority[] = ['lead', 'manager', 'director', 'executive']

export const isSeniority = (value: string): value is Seniority => (SENIORITY as readonly string[]).includes(value)

export const seniorityLabel = (value: string) => (isSeniority(value) ? SENIORITY_LABELS[value] : value)

export function levelsFor(track: Track): readonly Seniority[] {
  if (track === 'ic') return IC_LEVELS
  if (track === 'manager') return MANAGER_LEVELS
  return SENIORITY
}

export function inferTrack(saved: readonly string[]): Track {
  const ic = saved.some((level) => level !== 'lead' && (IC_LEVELS as readonly string[]).includes(level))
  const manager = saved.some((level) => level !== 'lead' && (MANAGER_LEVELS as readonly string[]).includes(level))
  if (ic && manager) return 'both'
  return manager ? 'manager' : 'ic'
}

export function pruneToTrack(selected: readonly string[], track: Track): string[] {
  const levels: readonly string[] = levelsFor(track)
  return selected.filter((level) => levels.includes(level))
}

export function toggleLevel(selected: readonly string[], level: Seniority, on: boolean): string[] {
  const next = on ? [...selected.filter((value) => value !== level), level] : selected.filter((value) => value !== level)
  const rank = (value: string) => (isSeniority(value) ? SENIORITY.indexOf(value) : SENIORITY.length)
  return next.sort((a, b) => rank(a) - rank(b))
}
