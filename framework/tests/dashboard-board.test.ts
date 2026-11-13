import { describe, expect, test } from 'bun:test'
import { APPLICATION_STATUSES, TERMINAL_STATUSES } from '../src/db/applications'
import { APPLICATIONS_FETCH_LIMIT, applicationsPath } from '../web/src/lib/api'
import { type StageKey, daysSince, stageColumns, stageOf, statusActions } from '../web/src/lib/board'
import {
  CARD_CAP, COLLAPSED_KEY, DENSITY_KEY, type StorageLike, preInterviewGroups, readCollapsed, readDensity, saveCollapsed,
  saveDensity, visibleCards,
} from '../web/src/lib/board-density'

const terminal = [...TERMINAL_STATUSES]

describe('stage columns', () => {
  test('are Pre-Interview, Interviewing, Offer and Closed in order', () => {
    expect(stageColumns(terminal).map((column) => column.label)).toEqual(['Pre-Interview', 'Interviewing', 'Offer', 'Closed'])
  })

  test('map every application status to one column', () => {
    const expected: Record<(typeof APPLICATION_STATUSES)[number], StageKey> = {
      saved: 'pre_interview',
      pending: 'pre_interview',
      applied: 'pre_interview',
      interviewing: 'interviewing',
      offered: 'offer',
      accepted: 'closed',
      deny_by_employer: 'closed',
      deny_by_candidate: 'closed',
      no_response: 'closed',
    }
    for (const status of APPLICATION_STATUSES) expect(stageOf(status, terminal)).toBe(expected[status])
    const listed = stageColumns(terminal).flatMap((column) => column.statuses)
    expect([...listed].sort()).toEqual([...APPLICATION_STATUSES].sort())
  })
})

describe('statusActions', () => {
  const targets = (status: string) => {
    const { advance, close } = statusActions(status)
    return { advance: advance.map((a) => a.target), close: close.map((a) => a.target) }
  }
  const allClose = ['deny_by_employer', 'deny_by_candidate', 'no_response']

  test('saved and pending offer Mark applied with the applied-date hint', () => {
    for (const status of ['saved', 'pending']) {
      const { advance } = statusActions(status)
      expect(advance).toHaveLength(1)
      expect(advance[0]).toMatchObject({ label: 'Mark applied', target: 'applied', hint: 'You pick the date you applied.' })
      expect(targets(status).close).toEqual(allClose)
    }
  })

  test('every hint says you pick the date and none implies today', () => {
    for (const status of APPLICATION_STATUSES) {
      const { advance, close } = statusActions(status)
      for (const action of [...advance, ...close]) {
        expect(action.hint).toContain('pick')
        expect(action.hint.toLowerCase()).not.toContain('today')
      }
    }
  })

  test('applied moves to interviewing', () => {
    expect(statusActions('applied').advance[0]).toMatchObject({ label: 'Move to interviewing', target: 'interviewing' })
    expect(targets('applied').close).toEqual(allClose)
  })

  test('interviewing marks an offer', () => {
    expect(statusActions('interviewing').advance[0]).toMatchObject({ label: 'Mark offer', target: 'offered' })
  })

  test('offered marks accepted', () => {
    expect(statusActions('offered').advance[0]).toMatchObject({ label: 'Mark accepted', target: 'accepted' })
    expect(statusActions('offered').close.map((a) => a.label)).toEqual(['Reject', 'Withdraw', 'No response'])
  })

  test('terminal statuses offer nothing', () => {
    for (const status of terminal) expect(targets(status)).toEqual({ advance: [], close: [] })
  })

  test('no action ever targets pending', () => {
    for (const status of APPLICATION_STATUSES) {
      const { advance, close } = statusActions(status)
      expect([...advance, ...close].some((a) => a.target === 'pending')).toBe(false)
    }
  })
})

test('daysSince counts whole days and never goes negative', () => {
  const now = Date.parse('2026-01-10T12:00:00Z')
  expect(daysSince('2026-01-07T13:00:00Z', now)).toBe(2)
  expect(daysSince('2026-01-11T00:00:00Z', now)).toBe(0)
})

describe('preInterviewGroups', () => {
  test('splits Pre-Interview into Pending, Saved and Applied in that order with counts', () => {
    const rows = [
      { id: 1, status: 'applied' },
      { id: 2, status: 'saved' },
      { id: 3, status: 'pending' },
      { id: 4, status: 'applied' },
      { id: 5, status: 'interviewing' },
    ]
    const groups = preInterviewGroups(rows)
    expect(groups.map((group) => [group.status, group.label, group.count])).toEqual([
      ['pending', 'Pending', 1],
      ['saved', 'Saved', 1],
      ['applied', 'Applied', 2],
    ])
    expect(groups[2]!.rows.map((row) => row.id)).toEqual([1, 4])
  })

  test('keeps empty groups so every section still renders', () => {
    expect(preInterviewGroups([]).map((group) => group.count)).toEqual([0, 0, 0])
  })
})

describe('visibleCards', () => {
  const rows = Array.from({ length: 60 }, (_, index) => index)

  test('shows at most 25 cards and offers the next batch', () => {
    expect(CARD_CAP).toBe(25)
    const first = visibleCards(rows, 0)
    expect(first.visible).toEqual(rows.slice(0, 25))
    expect(first.remaining).toBe(35)
    expect(first.more).toBe(25)
  })

  test('the last batch offers only what is left', () => {
    const second = visibleCards(rows, 50)
    expect(second.visible.length).toBe(50)
    expect(second.more).toBe(10)
    expect(visibleCards(rows, 60)).toEqual({ visible: rows, remaining: 0, more: 0 })
  })

  test('short columns show everything with no button', () => {
    expect(visibleCards([1, 2, 3], 25)).toEqual({ visible: [1, 2, 3], remaining: 0, more: 0 })
    expect(visibleCards(rows, 0, 10).visible.length).toBe(10)
  })
})

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial }
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => { data[key] = value } }
}

const throwingStorage: StorageLike = {
  getItem: () => { throw new Error('denied') },
  setItem: () => { throw new Error('denied') },
}

describe('board density storage', () => {
  test('defaults to comfortable and round-trips compact', () => {
    const storage = memoryStorage()
    expect(readDensity(storage)).toBe('comfortable')
    saveDensity('compact', storage)
    expect(storage.data[DENSITY_KEY]).toBe('compact')
    expect(readDensity(storage)).toBe('compact')
    saveDensity('comfortable', storage)
    expect(readDensity(storage)).toBe('comfortable')
  })

  test('ignores unknown values', () => {
    expect(readDensity(memoryStorage({ [DENSITY_KEY]: 'tiny' }))).toBe('comfortable')
  })

  test('falls back to comfortable when storage throws, and saving does not throw', () => {
    expect(readDensity(throwingStorage)).toBe('comfortable')
    expect(() => saveDensity('compact', throwingStorage)).not.toThrow()
  })
})

describe('collapsed groups storage', () => {
  test('defaults to Applied collapsed with Pending and Saved open', () => {
    expect(readCollapsed(memoryStorage())).toEqual(['applied'])
  })

  test('remembers the collapsed groups', () => {
    const storage = memoryStorage()
    saveCollapsed(['saved', 'pending'], storage)
    expect(readCollapsed(storage)).toEqual(['pending', 'saved'])
    saveCollapsed([], storage)
    expect(readCollapsed(storage)).toEqual([])
  })

  test('falls back to the default on bad data or when storage throws', () => {
    expect(readCollapsed(memoryStorage({ [COLLAPSED_KEY]: '{oops' }))).toEqual(['applied'])
    expect(readCollapsed(memoryStorage({ [COLLAPSED_KEY]: '"applied"' }))).toEqual(['applied'])
    expect(readCollapsed(memoryStorage({ [COLLAPSED_KEY]: '["bogus","saved"]' }))).toEqual(['saved'])
    expect(readCollapsed(throwingStorage)).toEqual(['applied'])
    expect(() => saveCollapsed(['applied'], throwingStorage)).not.toThrow()
  })
})

test('the Applications fetch asks for up to 5000 rows', () => {
  expect(applicationsPath({ status: '', q: '', limit: APPLICATIONS_FETCH_LIMIT })).toBe('/api/applications?limit=5000')
})
