import { describe, expect, test } from 'bun:test'
import { TERMINAL_STATUSES } from '../src/db/applications'
import { ApiError } from '../web/src/lib/api'
import { appliedAtSortValue } from '../web/src/lib/applied-sort'
import { stageMove } from '../web/src/lib/board'
import { bulkSummary } from '../web/src/lib/bulk'
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

  test('a forward drop sets the column primary status without confirmation', () => {
    expect(stageMove('applied', 'interviewing', terminal)).toEqual({ to: 'interviewing', target: 'interviewing', confirm: null })
    expect(stageMove('saved', 'offer', terminal)).toEqual({ to: 'offer', target: 'offered', confirm: null })
  })

  test('a drop into Closed asks first', () => {
    expect(stageMove('interviewing', 'closed', terminal)).toEqual({ to: 'closed', target: 'deny_by_employer', confirm: 'close' })
  })

  test('a backward drop asks first', () => {
    expect(stageMove('offered', 'pre_interview', terminal)).toEqual({ to: 'pre_interview', target: 'applied', confirm: 'back' })
    expect(stageMove('accepted', 'interviewing', terminal)).toEqual({ to: 'interviewing', target: 'interviewing', confirm: 'back' })
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
