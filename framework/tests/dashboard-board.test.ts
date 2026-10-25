import { describe, expect, test } from 'bun:test'
import { APPLICATION_STATUSES, TERMINAL_STATUSES } from '../src/db/applications'
import { type StageKey, daysSince, stageColumns, stageOf, statusActions } from '../web/src/lib/board'

const terminal = [...TERMINAL_STATUSES]

describe('stage columns', () => {
  test('are Pre-interview, Interviewing, Offer and Closed in order', () => {
    expect(stageColumns(terminal).map((column) => column.label)).toEqual(['Pre-interview', 'Interviewing', 'Offer', 'Closed'])
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
      expect(advance[0]).toMatchObject({ label: 'Mark applied', target: 'applied', hint: 'Records today as the date you applied.' })
      expect(targets(status).close).toEqual(allClose)
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
