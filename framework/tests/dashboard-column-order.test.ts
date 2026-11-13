import { describe, expect, test } from 'bun:test'
import { TERMINAL_STATUSES } from '../src/db/applications'
import { ApiError } from '../web/src/lib/api'
import { appliedAtSortValue } from '../web/src/lib/applied-sort'
import { MOVE_REFUSED, stageMove } from '../web/src/lib/board'
import { bulkSummary, pageSelection, togglePageSelection } from '../web/src/lib/bulk'
import {
  columnDefIds,
  columnOrderKey,
  mergeColumnOrder,
  moveColumn,
  parseStoredOrder,
  readColumnOrder,
  sameOrder,
  writeColumnOrder,
} from '../web/src/lib/column-order'

const DEFAULTS = ['select', 'company', 'title', 'status', 'location', 'appliedAt', 'updatedAt']
const PINNED = { start: ['select'] }
const terminal = [...TERMINAL_STATUSES]

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

describe('columnDefIds', () => {
  test('prefers id, falls back to accessorKey, skips neither', () => {
    expect(columnDefIds([{ id: 'a' }, { accessorKey: 'b' }, { id: 'c', accessorKey: 'x' }, {}])).toEqual(['a', 'b', 'c'])
  })
})

describe('parseStoredOrder', () => {
  test('parses a string array', () => expect(parseStoredOrder('["a","b"]')).toEqual(['a', 'b']))
  test('rejects null, bad JSON and wrong shapes', () => {
    expect(parseStoredOrder(null)).toBeNull()
    expect(parseStoredOrder('{oops')).toBeNull()
    expect(parseStoredOrder('{"a":1}')).toBeNull()
    expect(parseStoredOrder('["a",1]')).toBeNull()
  })
})

describe('mergeColumnOrder', () => {
  test('no stored order returns the defaults', () => expect(mergeColumnOrder(null, DEFAULTS, PINNED)).toEqual(DEFAULTS))

  test('applies a stored order', () => {
    expect(mergeColumnOrder(['status', 'company', 'title', 'location', 'appliedAt', 'updatedAt'], DEFAULTS, PINNED)).toEqual([
      'select', 'status', 'company', 'title', 'location', 'appliedAt', 'updatedAt',
    ])
  })

  test('drops unknown ids', () => {
    expect(mergeColumnOrder(['gone', 'title', 'company', 'status', 'location', 'appliedAt', 'updatedAt'], DEFAULTS, PINNED)).toEqual([
      'select', 'title', 'company', 'status', 'location', 'appliedAt', 'updatedAt',
    ])
  })

  test('appends new columns after their default predecessor', () => {
    expect(mergeColumnOrder(['title', 'company', 'status', 'location', 'appliedAt'], DEFAULTS, PINNED)).toEqual([
      'select', 'title', 'company', 'status', 'location', 'appliedAt', 'updatedAt',
    ])
    expect(mergeColumnOrder(['company', 'status', 'location', 'appliedAt', 'updatedAt'], DEFAULTS, PINNED)).toEqual([
      'select', 'company', 'title', 'status', 'location', 'appliedAt', 'updatedAt',
    ])
  })

  test('keeps the selection column pinned first and deduplicates', () => {
    expect(mergeColumnOrder(['company', 'company', 'select', 'title'], DEFAULTS, PINNED)[0]).toBe('select')
    expect(mergeColumnOrder(['company', 'company', 'title'], DEFAULTS, PINNED)).toEqual(DEFAULTS)
  })
})

describe('moveColumn', () => {
  test('moves a column forward and backward', () => {
    expect(moveColumn(DEFAULTS, 'company', 'status', PINNED)).toEqual([
      'select', 'title', 'status', 'company', 'location', 'appliedAt', 'updatedAt',
    ])
    expect(moveColumn(DEFAULTS, 'status', 'company', PINNED)).toEqual([
      'select', 'status', 'company', 'title', 'location', 'appliedAt', 'updatedAt',
    ])
  })

  test('the pinned selection column cannot move or be displaced', () => {
    expect(moveColumn(DEFAULTS, 'select', 'title', PINNED)).toEqual(DEFAULTS)
    expect(moveColumn(DEFAULTS, 'title', 'select', PINNED)).toEqual(DEFAULTS)
  })

  test('unknown ids are a no-op', () => expect(moveColumn(DEFAULTS, 'nope', 'title', PINNED)).toEqual(DEFAULTS))
})

describe('sameOrder', () => {
  test('compares element-wise', () => {
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameOrder(['a'], ['a', 'b'])).toBe(false)
  })
})

describe('stored column order', () => {
  test('is saved under applications-column-order and reset removes it', () => {
    const storage = memoryStorage()
    writeColumnOrder(storage, 'applications', ['title', 'company'])
    expect(columnOrderKey('applications')).toBe('applications-column-order')
    expect(readColumnOrder(storage, 'applications')).toEqual(['title', 'company'])
    writeColumnOrder(storage, 'applications', null)
    expect(storage.items.size).toBe(0)
    expect(mergeColumnOrder(readColumnOrder(storage, 'applications'), DEFAULTS, PINNED)).toEqual(DEFAULTS)
  })

  test('a throwing or corrupt storage reads as no order', () => {
    const throwing = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') },
    }
    expect(readColumnOrder(throwing, 'applications')).toBeNull()
    expect(() => writeColumnOrder(throwing, 'applications', ['title'])).not.toThrow()
    const corrupt = memoryStorage()
    corrupt.setItem(columnOrderKey('applications'), '{oops')
    expect(readColumnOrder(corrupt, 'applications')).toBeNull()
  })
})

describe('appliedAtSortValue', () => {
  test('orders later dates higher and leaves missing or invalid dates undefined', () => {
    expect(appliedAtSortValue('2026-10-09')!).toBeGreaterThan(appliedAtSortValue('2026-10-08')!)
    expect(appliedAtSortValue(null)).toBeUndefined()
    expect(appliedAtSortValue('')).toBeUndefined()
    expect(appliedAtSortValue('not a date')).toBeUndefined()
  })
})

describe('stageMove', () => {
  test('a drop in the same column does nothing', () => {
    expect(stageMove('saved', 'pre_interview', terminal)).toBeNull()
    expect(stageMove('no_response', 'closed', terminal)).toBeNull()
  })

  test('a forward drop is allowed and targets the column primary status', () => {
    expect(stageMove('applied', 'interviewing', terminal)).toEqual({ to: 'interviewing', target: 'interviewing', allowed: true })
    expect(stageMove('saved', 'offer', terminal)).toEqual({ to: 'offer', target: 'offered', allowed: true })
    expect(stageMove('interviewing', 'closed', terminal)).toEqual({ to: 'closed', target: 'deny_by_employer', allowed: true })
  })

  test('a backward drop or a drop out of Closed is refused', () => {
    expect(stageMove('offered', 'pre_interview', terminal)).toEqual({ to: 'pre_interview', target: 'applied', allowed: false })
    expect(stageMove('interviewing', 'pre_interview', terminal)?.allowed).toBe(false)
    for (const status of terminal) {
      for (const to of ['pre_interview', 'interviewing', 'offer'] as const) expect(stageMove(status, to, terminal)?.allowed).toBe(false)
    }
  })

  test('the refusal points at Undo in the timeline', () => {
    expect(MOVE_REFUSED).toContain('Undo')
    expect(MOVE_REFUSED).toContain('Timeline')
  })
})

describe('bulkSummary', () => {
  const ok = { status: 'fulfilled', value: {} } as const
  const conflict = { status: 'rejected', reason: new ApiError(409, 'changed') } as const
  const broken = { status: 'rejected', reason: new ApiError(500, 'disk full') } as const

  test('reports every row updated', () => {
    expect(bulkSummary('Updated', [ok, ok, ok])).toEqual({ text: 'Updated 3', isError: false, failed: [] })
  })

  test('reports conflicts and failures with their row indexes', () => {
    expect(bulkSummary('Updated', [ok, conflict, ok, ok])).toEqual({
      text: 'Updated 3 · 1 changed elsewhere, refreshed', isError: true, failed: [1],
    })
    expect(bulkSummary('Deleted', [broken, conflict])).toEqual({
      text: 'Deleted 0 · 1 changed elsewhere, refreshed · 1 failed: disk full', isError: true, failed: [0, 1],
    })
  })
})

describe('page selection', () => {
  const page2 = [51, 52, 53]

  test('header state counts only the current page', () => {
    expect(pageSelection(page2, new Set([1, 2, 3]))).toEqual({ checked: false, indeterminate: false })
    expect(pageSelection(page2, new Set([1, 52]))).toEqual({ checked: false, indeterminate: true })
    expect(pageSelection(page2, new Set([1, 51, 52, 53]))).toEqual({ checked: true, indeterminate: false })
    expect(pageSelection([], new Set([1]))).toEqual({ checked: false, indeterminate: false })
  })

  test('select all adds only the current page and keeps other pages', () => {
    expect([...togglePageSelection(new Set([1, 2]), page2, true)].sort((a, b) => a - b)).toEqual([1, 2, 51, 52, 53])
  })

  test('clear removes only the current page and keeps other pages', () => {
    expect([...togglePageSelection(new Set([1, 51, 53]), page2, false)]).toEqual([1])
  })

  test('does not mutate the given set', () => {
    const selected = new Set([1])
    togglePageSelection(selected, page2, true)
    expect([...selected]).toEqual([1])
  })
})
