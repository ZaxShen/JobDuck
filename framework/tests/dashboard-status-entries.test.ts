import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { type Sandbox, migratedDb, sandbox } from './helpers'
import { handleApi } from '../src/dashboard/api'
import type { Db } from '../src/db/client'
import { createApplication, getApplication, listEvents } from '../src/db/applications'
import { INTERVIEW_STAGES, OFFER_STAGES, STAGE_OUTCOMES } from '../src/db/interviews'
import { recordFollowUp } from '../src/db/follow-ups'
import { upsertPosting } from '../src/db/postings'
import { statusActions } from '../web/src/lib/board'
import {
  BULK_TARGETS, CLOSE_TARGETS, type DialogScope, dialogScope, effectiveDate, entryDraft, entryLabel, entryPatch,
  isEntryDate, revertsTo, statusRequest, timelineOrder, undoableEntryId,
} from '../web/src/lib/status-entries'
import type { ApplicationEvent, StageTypes } from '../web/src/lib/types'

const types: StageTypes = { interviewing: [...INTERVIEW_STAGES], offered: [...OFFER_STAGES], outcomes: [...STAGE_OUTCOMES] }

const event = (id: number, patch: Partial<ApplicationEvent> = {}): ApplicationEvent => ({
  id, from_status: 'saved', to_status: 'applied', note: null, source: 'dashboard', stage_type: null, scheduled_at: null,
  outcome: null, occurred_at: null, kind: null, round_id: null, created_at: '2026-01-01T12:00:00.000Z', ...patch,
})

describe('dialogScope', () => {
  test('Move to interviewing offers interview stage types only', () => {
    expect(dialogScope('interviewing', types)).toEqual({ stageKind: 'interviewing', options: INTERVIEW_STAGES, initial: 'information' })
  })

  test('Mark offer offers verbal and written', () => {
    expect(dialogScope('offered', types)).toEqual({ stageKind: 'offered', options: ['verbal', 'written'], initial: 'verbal' })
  })

  test('Mark applied and Mark accepted offer only their own status', () => {
    expect(dialogScope('applied', types)).toEqual({ stageKind: null, options: ['applied'], initial: 'applied' })
    expect(dialogScope('accepted', types)).toEqual({ stageKind: null, options: ['accepted'], initial: 'accepted' })
  })

  test('Reject, Withdraw and No response offer one of the three, prefilled from the action', () => {
    for (const target of CLOSE_TARGETS) expect(dialogScope(target, types)).toEqual({ stageKind: null, options: CLOSE_TARGETS, initial: target })
    expect(CLOSE_TARGETS.map(entryLabel)).toEqual(['Rejected', 'Withdrew', 'No response'])
  })

  test('every status action maps to a scope whose options include its prefilled choice', () => {
    for (const status of ['saved', 'pending', 'applied', 'interviewing', 'offered']) {
      const { advance, close } = statusActions(status)
      for (const action of [...advance, ...close]) {
        const scope = dialogScope(action.target, types)
        expect(scope.options).toContain(scope.initial)
      }
    }
  })

  test('stage scopes wait for the stage types', () => {
    expect(dialogScope('interviewing', null)).toEqual({ stageKind: 'interviewing', options: [], initial: '' })
  })

  test('bulk offers the status-only targets plus interviewing and offered, all as status changes', () => {
    expect(BULK_TARGETS).toEqual(['applied', 'interviewing', 'offered', 'accepted', 'deny_by_employer', 'deny_by_candidate', 'no_response'])
    expect(dialogScope('interviewing', types, true)).toEqual({ stageKind: null, options: BULK_TARGETS, initial: 'interviewing' })
  })
})

test('isEntryDate takes real YYYY-MM-DD dates only', () => {
  expect(isEntryDate('2026-03-01')).toBe(true)
  expect(isEntryDate('2024-02-29')).toBe(true)
  for (const bad of ['', '2026-02-30', '2026-13-01', '03/01/2026', '2026-03-01T10:00:00Z', 'today']) expect(isEntryDate(bad)).toBe(false)
})

describe('statusRequest', () => {
  const status: DialogScope = { stageKind: null, options: ['applied'], initial: 'applied' }
  const stage: DialogScope = { stageKind: 'interviewing', options: INTERVIEW_STAGES, initial: 'phone_screen' }

  test('a status-only change PATCHes the status with occurred_at', () => {
    expect(statusRequest(7, status, { choice: 'applied', date: '2026-03-01', note: '' }, 'v1')).toEqual({
      method: 'PATCH', path: '/api/applications/7', body: { status: 'applied', occurred_at: '2026-03-01', expected_updated_at: 'v1' },
    })
    expect(statusRequest(7, status, { choice: 'applied', date: '2026-03-01', note: 'Referral' }, 'v1').body.note).toBe('Referral')
  })

  test('a stage-backed change POSTs a stage with scheduled_at', () => {
    expect(statusRequest(7, stage, { choice: 'phone_screen', date: '2026-03-05', note: '' }, 'v1')).toEqual({
      method: 'POST', path: '/api/applications/7/stages',
      body: { kind: 'interviewing', stage_type: 'phone_screen', scheduled_at: '2026-03-05', expected_updated_at: 'v1' },
    })
  })

  test('refuses to build a request without a valid date', () => {
    expect(() => statusRequest(7, status, { choice: 'applied', date: '', note: '' }, 'v1')).toThrow('Pick the date')
    expect(() => statusRequest(7, stage, { choice: 'technical', date: '2026-02-30', note: '' }, 'v1')).toThrow('Pick the date')
  })
})

describe('timeline helpers', () => {
  test('the effective date is occurred_at, else scheduled_at, else created_at', () => {
    expect(effectiveDate(event(1, { occurred_at: '2026-02-01', scheduled_at: '2026-03-01' }))).toBe('2026-02-01')
    expect(effectiveDate(event(1, { scheduled_at: '2026-03-01' }))).toBe('2026-03-01')
    expect(effectiveDate(event(1))).toBe('2026-01-01T12:00:00.000Z')
  })

  test('timelineOrder sorts newest effective date first, then newest id', () => {
    const events = [
      event(1, { created_at: '2026-01-10T00:00:00.000Z' }),
      event(2, { occurred_at: '2025-12-01' }),
      event(3, { stage_type: 'technical', to_status: 'interviewing', scheduled_at: '2026-02-01' }),
      event(4, { occurred_at: '2026-01-20' }),
      event(5, { occurred_at: '2026-01-20' }),
    ]
    expect(timelineOrder(events).map((item) => item.id)).toEqual([3, 5, 4, 1, 2])
    expect(events.map((item) => item.id)).toEqual([1, 2, 3, 4, 5])
  })

  test('only the newest entry is undoable, and only when it is a non-stage status change', () => {
    const created = event(1, { from_status: null, to_status: 'saved' })
    const applied = event(2, { occurred_at: '2026-01-01' })
    const stage = event(3, { from_status: 'applied', to_status: 'interviewing', stage_type: 'technical' })
    expect(undoableEntryId([created])).toBeNull()
    expect(undoableEntryId([created, applied])).toBe(2)
    expect(undoableEntryId([applied, created])).toBe(2)
    expect(undoableEntryId([created, applied, stage])).toBeNull()
    expect(undoableEntryId([])).toBeNull()
  })

  test('follow-up rows are skipped, so undo targets the newest status entry as the server does', () => {
    const created = event(1, { from_status: null, to_status: 'saved' })
    const applied = event(2, { occurred_at: '2026-01-01' })
    const thankYou = event(3, { from_status: 'applied', to_status: 'applied', kind: 'thank_you_sent', round_id: 2 })
    const followUp = event(4, { from_status: 'applied', to_status: 'applied', kind: 'follow_up_sent', round_id: 2 })
    expect(undoableEntryId([created, applied, thankYou, followUp])).toBe(2)
    expect(undoableEntryId([followUp, applied, created])).toBe(2)
    expect(undoableEntryId([created, thankYou, followUp])).toBeNull()
    expect(undoableEntryId([thankYou, followUp])).toBeNull()
  })

  test('undoing a move out of pending goes back to saved', () => {
    expect(revertsTo(event(1, { from_status: 'pending' }))).toBe('saved')
    expect(revertsTo(event(1, { from_status: 'interviewing', to_status: 'offered' }))).toBe('interviewing')
  })

  test('entryPatch sends only what changed and needs a valid date', () => {
    const original = entryDraft(event(1, { occurred_at: '2026-03-01', note: 'Old' }), (value) => value.slice(0, 10))
    expect(original).toEqual({ date: '2026-03-01', note: 'Old' })
    expect(entryPatch(original, original)).toBeNull()
    expect(entryPatch(original, { date: '2026-03-02', note: 'Old' })).toEqual({ occurred_at: '2026-03-02' })
    expect(entryPatch(original, { date: '2026-03-01', note: ' ' })).toEqual({ note: null })
    expect(entryPatch(original, { date: '', note: 'New' })).toBeNull()
  })
})

describe('requests the dialog builds are accepted by the API', () => {
  let box: Sandbox
  let db: Db
  beforeEach(() => {
    box = sandbox()
    db = migratedDb(box.home)
  })
  afterEach(() => {
    db.close()
    box.cleanup()
  })

  const call = (method: string, path: string, body: unknown) =>
    handleApi({ db, home: box.home }, { method, path, query: new URLSearchParams(), body }) as { status: number; body: any }

  test('Mark applied, Move to interviewing, Mark offer and Reject each record the chosen date', () => {
    const posting = upsertPosting(db, { source: 'manual', url: 'https://acme.com/jobs/1', title: 'Engineer', company: 'Acme' })
    const { id } = createApplication(db, { postingId: posting.id })
    const steps: [string, string, string][] = [
      ['applied', 'applied', '2026-03-01'],
      ['interviewing', 'technical', '2026-03-05'],
      ['offered', 'written', '2026-03-20'],
      ['deny_by_candidate', 'deny_by_candidate', '2026-03-25'],
    ]
    for (const [target, choice, date] of steps) {
      const request = statusRequest(id, dialogScope(target, types), { choice, date, note: '' }, getApplication(db, id)!.updated_at)
      const response = call(request.method, request.path, request.body)
      expect(response.status).toBe(200)
      expect(getApplication(db, id)!.status as string).toBe(target)
      expect(effectiveDate(listEvents(db, id).at(-1)! as ApplicationEvent)).toBe(date)
    }
    expect(getApplication(db, id)).toMatchObject({ applied_at: '2026-03-01', closed_at: '2026-03-25' })

    const undo = undoableEntryId(listEvents(db, id) as ApplicationEvent[])!
    expect(call('DELETE', `/api/events/${undo}`, { expected_updated_at: getApplication(db, id)!.updated_at }).status).toBe(200)
    expect(getApplication(db, id)!.status).toBe('offered')
  })

  test('after a recorded follow-up, undo targets the newest status entry and the API accepts it', () => {
    const posting = upsertPosting(db, { source: 'manual', url: 'https://acme.com/jobs/3', title: 'Engineer', company: 'Acme' })
    const { id } = createApplication(db, { postingId: posting.id, status: 'applied' })
    for (const [target, choice, date] of [['interviewing', 'technical', '2026-05-01'], ['deny_by_employer', 'deny_by_employer', '2026-05-04']]) {
      const request = statusRequest(id, dialogScope(target!, types), { choice: choice!, date: date!, note: '' }, getApplication(db, id)!.updated_at)
      expect(call(request.method, request.path, request.body).status).toBe(200)
    }
    const round = listEvents(db, id).find((entry) => entry.stage_type === 'technical')!
    const denied = listEvents(db, id).at(-1)!
    const followUp = recordFollowUp(db, { roundId: round.id, kind: 'follow_up_sent', sentAt: '2026-05-05' })

    const undo = undoableEntryId(listEvents(db, id) as ApplicationEvent[])
    expect(undo).not.toBe(followUp.id)
    expect(undo).toBe(denied.id)
    expect(call('DELETE', `/api/events/${undo}`, { expected_updated_at: getApplication(db, id)!.updated_at }).status).toBe(200)
    expect(getApplication(db, id)!.status).toBe('interviewing')
  })

  test('a bulk status change to interviewing PATCHes with occurred_at', () => {
    const posting = upsertPosting(db, { source: 'manual', url: 'https://acme.com/jobs/2', title: 'Engineer', company: 'Acme' })
    const { id } = createApplication(db, { postingId: posting.id, status: 'applied' })
    const request = statusRequest(id, dialogScope('interviewing', types, true), { choice: 'interviewing', date: '2026-04-02', note: '' },
      getApplication(db, id)!.updated_at)
    expect(request.method).toBe('PATCH')
    expect(call(request.method, request.path, request.body).status).toBe(200)
    expect(listEvents(db, id).at(-1)).toMatchObject({ to_status: 'interviewing', occurred_at: '2026-04-02' })
  })
})
