import type { ProfileFact } from './types'

export interface FactMove {
  fact: ProfileFact
  sort_order: number
}

export function reorderedFacts(all: ProfileFact[], ordered: ProfileFact[]): { next: ProfileFact[]; moves: FactMove[] } {
  const moves = ordered.flatMap((fact, sort_order) => (fact.sort_order === sort_order ? [] : [{ fact, sort_order }]))
  const placed = ordered.map((fact, sort_order) => ({ ...fact, sort_order }))
  const ids = new Set(ordered.map((fact) => fact.id))
  let slot = 0
  const next = all.map((fact) => (ids.has(fact.id) ? placed[slot++]! : fact))
  return { next, moves }
}
