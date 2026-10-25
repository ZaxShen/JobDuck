export function appliedAtSortValue(appliedAt: string | null | undefined): number | undefined {
  if (!appliedAt) return undefined
  const time = Date.parse(appliedAt)
  return Number.isNaN(time) ? undefined : time
}
