import { expect, test } from 'bun:test'
import { urlKey } from '../src/db/url-key'
import {
  type MatchCandidate, markerId, matchOutcome, normalizeCompany, normalizeTitle, plausibleDate, rankCandidates,
  refMatches, titleSimilarity,
} from '../src/sync/match'

let nextId = 1
function candidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  const id = overrides.id ?? nextId++
  const url = overrides.url ?? `https://jobs.example.com/acme/${id}`
  return {
    id, company: 'Acme', title: 'AI Engineer', url, url_key: urlKey(url)!, source_id: null,
    applied_at: '2026-09-01T00:00:00.000Z', company_override: null, title_override: null, ...overrides,
  }
}

const received = '2026-10-01T12:00:00.000Z'

test('normalizeCompany lower-cases, strips punctuation and trailing suffixes, collapses spaces', () => {
  expect(normalizeCompany('Acme, Inc.')).toBe('acme')
  expect(normalizeCompany('  Acme   Robotics Technologies LLC ')).toBe('acme robotics')
  expect(normalizeCompany('Example Labs GmbH')).toBe('example')
  expect(normalizeCompany('Initech Corp.')).toBe('initech')
  expect(normalizeCompany('Globex Co')).toBe('globex')
  expect(normalizeCompany('Umbrella PLC')).toBe('umbrella')
  expect(normalizeCompany('Hooli Ltd')).toBe('hooli')
  expect(normalizeCompany('Labs')).toBe('labs')
  expect(normalizeCompany(null)).toBe('')
})

test('normalizeTitle drops seniority words and punctuation', () => {
  expect(normalizeTitle('Senior Software Engineer, II')).toBe('software engineer')
  expect(normalizeTitle('Sr. ML Engineer (Staff)')).toBe('ml engineer')
  expect(normalizeTitle('Principal / Lead Data Scientist')).toBe('data scientist')
  expect(normalizeTitle(undefined)).toBe('')
})

test('titleSimilarity is token Jaccard over normalized titles', () => {
  expect(titleSimilarity('Senior AI Engineer', 'AI Engineer')).toBe(1)
  expect(titleSimilarity('AI Engineer', 'AI Platform Engineer')).toBeCloseTo(2 / 3)
  expect(titleSimilarity('Data Scientist', 'AI Engineer')).toBe(0)
  expect(titleSimilarity('', 'AI Engineer')).toBe(0)
})

test('markerId accepts positive integers and numeric strings only', () => {
  expect(markerId(12)).toBe(12)
  expect(markerId('12')).toBe(12)
  expect(markerId('abc')).toBeNull()
  expect(markerId(0)).toBeNull()
  expect(markerId(null)).toBeNull()
})

test('plausibleDate allows one day before applied_at and unknown dates', () => {
  expect(plausibleDate('2026-09-30T12:00:00.000Z', '2026-10-01T00:00:00.000Z')).toBe(true)
  expect(plausibleDate('2026-09-29T00:00:00.000Z', '2026-10-01T00:00:00.000Z')).toBe(false)
  expect(plausibleDate(received, null)).toBe(true)
  expect(plausibleDate('not a date', '2026-10-01T00:00:00.000Z')).toBe(true)
})

test('refMatches compares source_id or a path/query token of the URL', () => {
  const byId = candidate({ source_id: 'R-1234' })
  expect(refMatches(byId, 'r-1234')).toBe(true)
  const byPath = candidate({ url: 'https://acme.example.com/careers/jobs/R5678/apply' })
  expect(refMatches(byPath, 'R5678')).toBe(true)
  const byQuery = candidate({ url: 'https://acme.example.com/careers?gh_jid=4455' })
  expect(refMatches(byQuery, '4455')).toBe(true)
  expect(refMatches(byQuery, '445')).toBe(false)
  expect(refMatches(byQuery, 'acme.example.com')).toBe(false)
})

test('rule 1: the marker wins when the application is a live candidate', () => {
  const target = candidate({ company: 'Globex' })
  const other = candidate()
  expect(matchOutcome({ applicationId: String(target.id), company: 'Acme', receivedAt: received }, [other, target]))
    .toEqual({ kind: 'marker', applicationId: target.id })
})

test('a marker for an unknown application falls through to the next rules', () => {
  const only = candidate()
  expect(matchOutcome({ applicationId: 9999, company: 'Acme', receivedAt: received }, [only]))
    .toEqual({ kind: 'company_title', applicationId: only.id })
})

test('rule 2: the job URL matches through urlKey', () => {
  const target = candidate({ url: 'https://boards.greenhouse.io/acme/jobs/123' })
  const other = candidate()
  expect(matchOutcome({ jobUrl: 'https://job-boards.greenhouse.io/acme/jobs/123/#apply', receivedAt: received }, [other, target]))
    .toEqual({ kind: 'url', applicationId: target.id })
})

test('rule 3: the job ref matches source_id or a URL token, only when unique', () => {
  const target = candidate({ company: 'Globex', source_id: 'JR-77' })
  const other = candidate({ company: 'Globex' })
  expect(matchOutcome({ jobRef: 'JR-77', company: 'Globex', receivedAt: received }, [other, target]))
    .toEqual({ kind: 'ref', applicationId: target.id })
  const twin = candidate({ company: 'Globex', source_id: 'JR-77' })
  expect(matchOutcome({ jobRef: 'JR-77', receivedAt: received }, [target, twin]).kind).toBe('none')
})

test('rule 4: a single candidate at the company matches, override wins', () => {
  const target = candidate({ company: 'Old Name', company_override: 'Acme Labs' })
  const other = candidate({ company: 'Globex' })
  expect(matchOutcome({ company: 'ACME, Inc.', title: 'Something else', receivedAt: received }, [other, target]))
    .toEqual({ kind: 'company_title', applicationId: target.id })
})

test('rule 4: several candidates at the company are split by title similarity', () => {
  const engineer = candidate({ title: 'Senior AI Engineer' })
  const scientist = candidate({ title: 'Data Scientist' })
  expect(matchOutcome({ company: 'Acme', title: 'AI Engineer', receivedAt: received }, [scientist, engineer]))
    .toEqual({ kind: 'company_title', applicationId: engineer.id })
})

test('rule 4: a tie or a weak title leaves the outcome unmatched', () => {
  const a = candidate({ title: 'AI Engineer' })
  const b = candidate({ title: 'AI Engineer' })
  expect(matchOutcome({ company: 'Acme', title: 'AI Engineer', receivedAt: received }, [a, b]).kind).toBe('none')
  const c = candidate({ title: 'Platform Engineer' })
  const d = candidate({ title: 'Data Scientist' })
  expect(matchOutcome({ company: 'Acme', title: 'AI Research Engineer', receivedAt: received }, [c, d]).kind).toBe('none')
})

test('rule 4: an email older than applied_at minus a day never matches', () => {
  const late = candidate({ applied_at: '2026-10-05T00:00:00.000Z' })
  const decision = matchOutcome({ company: 'Acme', title: 'AI Engineer', receivedAt: received }, [late])
  expect(decision.kind).toBe('none')
})

test('no match returns the top three candidates by company then title', () => {
  const rows = [
    candidate({ company: 'Acme', title: 'Data Scientist' }),
    candidate({ company: 'Acme', title: 'AI Engineer' }),
    candidate({ company: 'Acme', title: 'AI Engineer' }),
    candidate({ company: 'Globex', title: 'AI Engineer' }),
    candidate({ company: 'Initech', title: 'Accountant' }),
  ]
  const decision = matchOutcome({ company: 'Acme', title: 'AI Engineer', receivedAt: received }, rows)
  expect(decision.kind).toBe('none')
  if (decision.kind !== 'none') throw new Error('unreachable')
  expect(decision.candidates.map((row) => row.application_id)).toEqual([rows[1]!.id, rows[2]!.id, rows[0]!.id])
  expect(decision.candidates[0]).toEqual({ application_id: rows[1]!.id, company: 'Acme', title: 'AI Engineer', score: 1 })
  expect(rankCandidates({ company: 'Nobody', title: 'Pilot', receivedAt: received }, rows)).toEqual([])
})

test('no company and no identifiers is unmatched with no candidates', () => {
  expect(matchOutcome({ receivedAt: received }, [candidate()])).toEqual({ kind: 'none', candidates: [] })
})
