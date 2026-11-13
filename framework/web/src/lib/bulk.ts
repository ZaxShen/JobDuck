import { errorMessage, isConflict } from './api'

export interface BulkSummary {
  text: string
  isError: boolean
  failed: number[]
}

export function bulkSummary(verb: string, results: readonly PromiseSettledResult<unknown>[]): BulkSummary {
  const failed: number[] = []
  let conflicts = 0
  const errors: string[] = []
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') return
    failed.push(index)
    if (isConflict(result.reason)) conflicts += 1
    else errors.push(errorMessage(result.reason))
  })
  const parts = [`${verb} ${results.length - failed.length}`]
  if (conflicts > 0) parts.push(`${conflicts} changed elsewhere, refreshed`)
  if (errors.length > 0) parts.push(`${errors.length} failed: ${errors[0]}`)
  return { text: parts.join(' · '), isError: failed.length > 0, failed }
}

export interface PageSelection {
  checked: boolean
  indeterminate: boolean
}

/** Header checkbox state for the rows on the current page only. */
export function pageSelection(pageIds: readonly number[], selected: ReadonlySet<number>): PageSelection {
  const count = pageIds.filter((id) => selected.has(id)).length
  const checked = pageIds.length > 0 && count === pageIds.length
  return { checked, indeterminate: count > 0 && !checked }
}

/** Selects or clears the current page's rows, keeping selections on other pages. */
export function togglePageSelection(selected: ReadonlySet<number>, pageIds: readonly number[], checked: boolean): Set<number> {
  const next = new Set(selected)
  for (const id of pageIds) {
    if (checked) next.add(id)
    else next.delete(id)
  }
  return next
}
