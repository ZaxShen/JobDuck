import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  AGENT_HOSTS,
  AGENT_PART,
  DASHBOARD_PART,
  GUIDE_SEEN_KEY,
  GUIDE_SKILLS,
  type GuideStorage,
  guideSeen,
  markGuideSeen,
  shouldAutoShowGuide,
} from '../web/src/lib/getting-started'
import { AGENTS } from '../web/src/lib/onboarding'
import { VIEWS } from '../web/src/lib/routing'

const skillStems = readdirSync(join(import.meta.dir, '..', 'skills'))
  .filter((file) => file.endsWith('.md'))
  .map((file) => file.slice(0, -3))

const isTitleCase = (text: string) => text.split(/\s+/).every((word) => /^[A-Z]/.test(word))

const fakeStorage = (): GuideStorage & { items: Map<string, string> } => {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  }
}

test('every skill file has exactly one guide entry and every entry maps to a skill file', () => {
  expect(skillStems.length).toBeGreaterThan(0)
  for (const stem of skillStems) expect(GUIDE_SKILLS.filter((entry) => entry.skill === stem)).toHaveLength(1)
  for (const entry of GUIDE_SKILLS) expect(skillStems).toContain(entry.skill)
})

test('each guide entry has a Title Case title, a purpose and at least one example prompt', () => {
  for (const entry of GUIDE_SKILLS) {
    expect(isTitleCase(entry.title)).toBe(true)
    expect(entry.purpose.length).toBeGreaterThan(0)
    expect(entry.prompts.length).toBeGreaterThanOrEqual(1)
    expect(entry.prompts.length).toBeLessThanOrEqual(3)
    for (const prompt of entry.prompts) expect(prompt.length).toBeGreaterThan(0)
  }
})

test('the guide has a dashboard part and an agent part naming every host', () => {
  expect(DASHBOARD_PART.title).toBe('What The Dashboard Does')
  for (const page of ['Applications', 'Jobs', 'Profile', 'Settings']) expect(DASHBOARD_PART.body).toContain(page)
  expect(AGENT_PART.title).toBe('What Your Agent Does')
  expect(AGENT_HOSTS.join(', ')).toBe(AGENTS)
  for (const host of AGENT_HOSTS) expect(AGENT_PART.body).toContain(host)
})

test('guideSeen and markGuideSeen round-trip through storage', () => {
  const storage = fakeStorage()
  expect(guideSeen(storage)).toBe(false)
  markGuideSeen(storage)
  expect(storage.items.has(GUIDE_SEEN_KEY)).toBe(true)
  expect(guideSeen(storage)).toBe(true)
})

test('an unreadable storage counts as not seen and a failed write is ignored', () => {
  const broken: GuideStorage = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('quota')
    },
  }
  expect(guideSeen(broken)).toBe(false)
  expect(() => markGuideSeen(broken)).not.toThrow()
})

test('the guide auto-shows only on a non-welcome view for an onboarded profile that has not seen it', () => {
  for (const view of VIEWS.filter((name) => name !== 'welcome')) {
    expect(shouldAutoShowGuide({ view, needsWelcome: false, seen: false })).toBe(true)
    expect(shouldAutoShowGuide({ view, needsWelcome: true, seen: false })).toBe(false)
    expect(shouldAutoShowGuide({ view, needsWelcome: false, seen: true })).toBe(false)
  }
  expect(shouldAutoShowGuide({ view: 'welcome', needsWelcome: false, seen: false })).toBe(false)
})
