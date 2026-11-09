import { describe, expect, test } from 'bun:test'
import { FOLLOW_UP_KINDS, DUE_KINDS, type FollowUpDue } from '../src/db/follow-ups'
import {
  GHOSTED_HINT, allFollowUpsPrompt, dueText, followUpKindLabel, followUpPrompt, followUpSentLabel, waitLabel,
} from '../web/src/lib/follow-ups'
import type { FollowUpItem } from '../web/src/lib/types'

const item = (patch: Partial<FollowUpItem> = {}): FollowUpItem => ({
  kind: 'thank_you', application_id: 7, round_id: 42, company: 'Acme', title: 'Software Engineer', stage_type: 'phone_screen',
  round_at: '2026-03-02T15:00:00.000Z', due_at: '2026-03-03T15:00:00.000Z', follow_ups_sent: 0, suggest_ghosted: false, ...patch,
})

describe('labels', () => {
  test('every due kind and every recorded kind has a Title Case label', () => {
    expect(DUE_KINDS.map(followUpKindLabel)).toEqual(['Thank-You Note', 'Follow-Up'])
    expect(FOLLOW_UP_KINDS.map(followUpSentLabel)).toEqual(['Thank-You Sent', 'Follow-Up Sent'])
  })

  test('the wait reads in business days', () => {
    expect(waitLabel(3)).toBe('After 3 Business Days')
    expect(waitLabel(1)).toBe('After 1 Business Day')
  })

  test('the ghosted hint is Title Case', () => {
    expect(GHOSTED_HINT).toBe('No Reply After 2 Follow-Ups — Consider Marking Ghosted')
  })

  test('a server item is assignable to the client item type', () => {
    const server: FollowUpDue = { ...item(), stage_type: 'phone_screen' }
    const client: FollowUpItem = server
    expect(client).toEqual(item())
  })
})

describe('dueText', () => {
  const now = new Date('2026-03-03T12:00:00.000Z')

  test('a due date still ahead reads Due By', () => {
    expect(dueText(item(), now, 'en-US')).toStartWith('Due By Mar 3')
  })

  test('a due date passed reads Overdue Since', () => {
    expect(dueText(item({ kind: 'follow_up', due_at: '2026-02-27T15:00:00.000Z' }), now, 'en-US')).toStartWith('Overdue Since Feb 27')
    expect(dueText(item({ due_at: now.toISOString() }), now, 'en-US')).toStartWith('Overdue Since')
  })

  test('an unreadable due date reads Due Now', () => {
    expect(dueText(item({ due_at: 'not a date' }), now)).toBe('Due Now')
  })
})

describe('prompt builders', () => {
  test('followUpPrompt names the skill, kind, company, title, stage and round, checks for a reply and never sends', () => {
    const thankYou = followUpPrompt(item())
    expect(thankYou).toContain('Job Duck follow-up skill')
    expect(thankYou).toContain('thank-you note')
    expect(thankYou).toContain('Acme')
    expect(thankYou).toContain('Software Engineer')
    expect(thankYou).toContain('Phone Screen')
    expect(thankYou).toContain('round_id 42')
    expect(thankYou).toContain('check my mail for a reply')
    expect(thankYou).toContain('draft')
    expect(thankYou).toContain('Do not send')

    const followUp = followUpPrompt(item({ kind: 'follow_up', company: 'Example Corp', round_id: 9 }))
    expect(followUp).toContain('follow-up to Example Corp')
    expect(followUp).toContain('round_id 9')
    expect(followUp).not.toContain('thank-you')
  })

  test('allFollowUpsPrompt asks what is due through the skill and never sends', () => {
    const prompt = allFollowUpsPrompt()
    expect(prompt).toStartWith('Any follow-ups due?')
    expect(prompt).toContain('Job Duck follow-up skill')
    expect(prompt).toContain('check my mail for a reply')
    expect(prompt).toContain('Do not send')
  })
})
