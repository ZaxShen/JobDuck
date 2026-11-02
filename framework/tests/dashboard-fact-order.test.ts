import { expect, test } from 'bun:test'
import { reorderedFacts } from '../web/src/lib/fact-order'
import type { ProfileFact } from '../web/src/lib/types'

const fact = (id: number, project: string, sort_order = 0): ProfileFact => ({
  id, slug: null, company: 'Acme', role: null, project, category: 'action', action: `Fact ${id}`, outcome: null,
  metrics: null, skills: [], tools: [], basis: 'stated', confidence: null, rationale: null, status: 'proposed',
  sort_order, created_at: '2026-01-01T00:00:00.000Z', updated_at: `2026-01-01T00:00:0${id}.000Z`,
})

test('moving a fact patches only the facts whose sort_order changes', () => {
  const a = fact(1, 'Billing'), b = fact(2, 'Billing'), c = fact(3, 'Billing')
  const { moves } = reorderedFacts([a, b, c], [c, a, b])
  expect(moves.map((move) => [move.fact.id, move.sort_order])).toEqual([[1, 1], [2, 2]])
  expect(moves[0]!.fact.updated_at).toBe(a.updated_at)
})

test('the reordered project keeps its slots and other projects stay put', () => {
  const a = fact(1, 'Billing', 0), x = fact(9, 'Search', 0), b = fact(2, 'Billing', 1)
  const { next } = reorderedFacts([a, x, b], [b, a])
  expect(next.map((item) => [item.id, item.sort_order])).toEqual([[2, 0], [9, 0], [1, 1]])
})

test('an unchanged order patches nothing', () => {
  const a = fact(1, 'Billing', 0), b = fact(2, 'Billing', 1)
  expect(reorderedFacts([a, b], [a, b]).moves).toEqual([])
})
