import { urlKey } from '../db/url-key'

export interface MatchCandidate {
  id: number
  company: string
  title: string
  company_override?: string | null
  title_override?: string | null
  url: string
  url_key: string
  source_id: string | null
  applied_at: string | null
}

export interface MatchableOutcome {
  applicationId?: number | string | null
  jobUrl?: string | null
  jobRef?: string | null
  company?: string | null
  title?: string | null
  receivedAt: string
}

export type MatchKind = 'marker' | 'url' | 'ref' | 'company_title'

export interface ScoredCandidate {
  application_id: number
  company: string
  title: string
  score: number
}

export type MatchDecision =
  | { kind: MatchKind; applicationId: number }
  | { kind: 'none'; candidates: ScoredCandidate[] }

export const TITLE_THRESHOLD = 0.6
const DAY_MS = 86_400_000

const COMPANY_SUFFIXES = new Set(['inc', 'llc', 'ltd', 'corp', 'co', 'gmbh', 'plc', 'technologies', 'labs'])
const SENIORITY_WORDS = new Set([
  'senior', 'sr', 'junior', 'jr', 'staff', 'principal', 'lead', 'mid', 'entry', 'level', 'i', 'ii', 'iii', 'iv', 'v',
])

const words = (value: string | null | undefined) =>
  (value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean)

export function normalizeCompany(value: string | null | undefined): string {
  const tokens = words(value)
  while (tokens.length > 1 && COMPANY_SUFFIXES.has(tokens.at(-1)!)) tokens.pop()
  return tokens.join(' ')
}

export function normalizeTitle(value: string | null | undefined): string {
  return words(value).filter((word) => !SENIORITY_WORDS.has(word)).join(' ')
}

function jaccard(a: string, b: string): number {
  const left = new Set(a.split(' ').filter(Boolean))
  const right = new Set(b.split(' ').filter(Boolean))
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return shared / (left.size + right.size - shared)
}

export const titleSimilarity = (a: string | null | undefined, b: string | null | undefined) =>
  jaccard(normalizeTitle(a), normalizeTitle(b))

export const companySimilarity = (a: string | null | undefined, b: string | null | undefined) =>
  jaccard(normalizeCompany(a), normalizeCompany(b))

export const effectiveCompany = (candidate: MatchCandidate) => candidate.company_override ?? candidate.company
export const effectiveTitle = (candidate: MatchCandidate) => candidate.title_override ?? candidate.title

export function markerId(value: number | string | null | undefined): number | null {
  const text = String(value ?? '').trim()
  if (!/^\d+$/.test(text)) return null
  const id = Number(text)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

const refTokens = (url: string) => url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/, '')
  .split(/[/?&=#_]+/).filter(Boolean).map((token) => token.toLowerCase())

export function refMatches(candidate: MatchCandidate, ref: string): boolean {
  const wanted = ref.trim().toLowerCase()
  if (wanted === '') return false
  if (candidate.source_id !== null && candidate.source_id.trim().toLowerCase() === wanted) return true
  return refTokens(candidate.url).includes(wanted)
}

export function plausibleDate(receivedAt: string, appliedAt: string | null): boolean {
  if (appliedAt === null) return true
  const received = Date.parse(receivedAt)
  const applied = Date.parse(appliedAt)
  if (Number.isNaN(received) || Number.isNaN(applied)) return true
  return received >= applied - DAY_MS
}

const round2 = (value: number) => Math.round(value * 100) / 100

export function rankCandidates(outcome: MatchableOutcome, candidates: MatchCandidate[], limit = 3): ScoredCandidate[] {
  return candidates
    .map((candidate) => ({
      candidate,
      company: companySimilarity(outcome.company, effectiveCompany(candidate)),
      title: titleSimilarity(outcome.title, effectiveTitle(candidate)),
    }))
    .filter((entry) => entry.company > 0 || entry.title > 0)
    .sort((a, b) => b.company - a.company || b.title - a.title || a.candidate.id - b.candidate.id)
    .slice(0, limit)
    .map(({ candidate, company, title }) => ({
      application_id: candidate.id,
      company: effectiveCompany(candidate),
      title: effectiveTitle(candidate),
      score: round2((company + title) / 2),
    }))
}

function byCompanyTitle(outcome: MatchableOutcome, candidates: MatchCandidate[]): number | null {
  const company = normalizeCompany(outcome.company)
  if (company === '') return null
  const same = candidates.filter((candidate) =>
    normalizeCompany(effectiveCompany(candidate)) === company && plausibleDate(outcome.receivedAt, candidate.applied_at))
  if (same.length === 1) return same[0]!.id
  if (same.length === 0) return null
  const scored = same.map((candidate) => ({ id: candidate.id, score: titleSimilarity(outcome.title, effectiveTitle(candidate)) }))
    .sort((a, b) => b.score - a.score)
  const [best, second] = scored
  if (!best || best.score < TITLE_THRESHOLD) return null
  if (second && second.score >= best.score) return null
  return best.id
}

export function matchOutcome(outcome: MatchableOutcome, candidates: MatchCandidate[]): MatchDecision {
  const marker = markerId(outcome.applicationId)
  if (marker !== null && candidates.some((candidate) => candidate.id === marker)) return { kind: 'marker', applicationId: marker }

  const key = outcome.jobUrl ? urlKey(outcome.jobUrl) : null
  const byUrl = key === null ? undefined : candidates.find((candidate) => candidate.url_key === key)
  if (byUrl) return { kind: 'url', applicationId: byUrl.id }

  if (outcome.jobRef) {
    const byRef = candidates.filter((candidate) => refMatches(candidate, outcome.jobRef!))
    if (byRef.length === 1) return { kind: 'ref', applicationId: byRef[0]!.id }
  }

  const byCompany = byCompanyTitle(outcome, candidates)
  if (byCompany !== null) return { kind: 'company_title', applicationId: byCompany }

  return { kind: 'none', candidates: rankCandidates(outcome, candidates) }
}
