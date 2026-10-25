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
