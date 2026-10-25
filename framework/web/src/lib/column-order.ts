export interface PinnedColumns {
  start?: readonly string[]
  end?: readonly string[]
}

export function columnDefIds(defs: readonly object[]): string[] {
  return defs.flatMap((def) => {
    const { id, accessorKey } = def as { id?: unknown; accessorKey?: unknown }
    if (typeof id === 'string') return [id]
    if (typeof accessorKey === 'string') return [accessorKey]
    return []
  })
}

export function parseStoredOrder(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) && value.every((id) => typeof id === 'string') ? value : null
  } catch {
    return null
  }
}

export function mergeColumnOrder(
  saved: readonly string[] | null,
  defaults: readonly string[],
  pinned: PinnedColumns = {},
): string[] {
  const start = (pinned.start ?? []).filter((id) => defaults.includes(id))
  const end = (pinned.end ?? []).filter((id) => defaults.includes(id))
  const isPinned = (id: string) => start.includes(id) || end.includes(id)
  const movable = defaults.filter((id) => !isPinned(id))

  const merged = [...new Set(saved ?? [])].filter((id) => movable.includes(id))
  movable.forEach((id, index) => {
    if (merged.includes(id)) return
    const previous = movable.slice(0, index).reverse().find((prev) => merged.includes(prev))
    merged.splice(previous === undefined ? 0 : merged.indexOf(previous) + 1, 0, id)
  })

  return [...start, ...merged, ...end]
}

export function moveColumn(
  order: readonly string[],
  activeId: string,
  overId: string,
  pinned: PinnedColumns = {},
): string[] {
  const fixed = [...(pinned.start ?? []), ...(pinned.end ?? [])]
  const from = order.indexOf(activeId)
  const to = order.indexOf(overId)
  if (from === -1 || to === -1 || from === to || fixed.includes(activeId) || fixed.includes(overId)) {
    return [...order]
  }
  const next = [...order]
  next.splice(from, 1)
  next.splice(to, 0, activeId)
  return next
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

interface OrderStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export const columnOrderKey = (key: string) => `${key}-column-order`

export function readColumnOrder(storage: OrderStorage, key: string): string[] | null {
  try {
    return parseStoredOrder(storage.getItem(columnOrderKey(key)))
  } catch {
    return null
  }
}

export function writeColumnOrder(storage: OrderStorage, key: string, order: readonly string[] | null): void {
  try {
    if (order === null) storage.removeItem(columnOrderKey(key))
    else storage.setItem(columnOrderKey(key), JSON.stringify(order))
  } catch {
    return
  }
}
