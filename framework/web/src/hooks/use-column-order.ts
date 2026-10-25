import { useCallback, useMemo, useState } from 'react'
import type { ColumnOrderState, Updater } from '@tanstack/react-table'
import { type PinnedColumns, mergeColumnOrder, readColumnOrder, writeColumnOrder } from '@/lib/column-order'

function browserStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function useColumnOrder(
  key: string,
  defaultOrder: readonly string[],
  pinned: PinnedColumns,
): [ColumnOrderState, (updater: Updater<ColumnOrderState>) => void, () => void] {
  const [saved, setSaved] = useState<string[] | null>(() => {
    const storage = browserStorage()
    return storage ? readColumnOrder(storage, key) : null
  })

  const columnOrder = useMemo(
    () => mergeColumnOrder(saved, defaultOrder, pinned),
    [saved, defaultOrder, pinned],
  )

  const setColumnOrder = useCallback(
    (updater: Updater<ColumnOrderState>) => {
      const requested = typeof updater === 'function' ? updater(columnOrder) : updater
      const next = mergeColumnOrder(requested, defaultOrder, pinned)
      const storage = browserStorage()
      if (storage) writeColumnOrder(storage, key, next)
      setSaved(next)
    },
    [key, columnOrder, defaultOrder, pinned],
  )

  const reset = useCallback(() => {
    const storage = browserStorage()
    if (storage) writeColumnOrder(storage, key, null)
    setSaved(null)
  }, [key])

  return [columnOrder, setColumnOrder, reset]
}
