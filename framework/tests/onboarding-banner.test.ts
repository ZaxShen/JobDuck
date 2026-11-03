import { expect, test } from 'bun:test'
import { bannerFor, LINKEDIN_STEPS } from '../web/src/lib/onboarding'
import type { OnboardingStatus } from '../web/src/lib/types'

const status = (overrides: Partial<OnboardingStatus> = {}): OnboardingStatus => ({
  profile_empty: false,
  pending_imports: [],
  dashboard_hint: 'jobduck dashboard --background --view welcome',
  workspace: '/work/JobDuck',
  ...overrides,
})

const pending = [{ path: 'inbox/resume.pdf', name: 'resume.pdf', sha256: 'a'.repeat(64) }]

test('an empty profile with nothing pending shows the empty banner on Profile and Applications', () => {
  for (const page of ['profile', 'applications'] as const) {
    const banner = bannerFor(status({ profile_empty: true }), page)
    expect(banner?.kind).toBe('empty')
    expect(banner?.title).toBe('Your Profile Is Empty')
  }
})

test('pending files show the waiting banner naming the workspace and the file', () => {
  const banner = bannerFor(status({ profile_empty: true, pending_imports: pending }), 'profile')
  expect(banner).toEqual({
    kind: 'pending',
    title: 'Your Resume Is Waiting For Your Agent',
    body: 'Open any agent in /work/JobDuck and it imports resume.pdf automatically.',
  })
  expect(bannerFor(status({ profile_empty: true, pending_imports: pending }), 'applications')?.kind).toBe('pending')
})

test('several pending files are listed in plain words', () => {
  const two = [...pending, { path: 'cv.docx', name: 'cv.docx', sha256: 'b'.repeat(64) }]
  expect(bannerFor(status({ pending_imports: two }), 'profile')?.body).toContain('imports resume.pdf and cv.docx automatically')
})

test('Applications shows a banner only while the profile is empty', () => {
  expect(bannerFor(status({ pending_imports: pending }), 'applications')).toBeNull()
  expect(bannerFor(status({ pending_imports: pending }), 'profile')?.kind).toBe('pending')
})

test('a filled profile with nothing pending shows no banner, nor does an unknown status', () => {
  expect(bannerFor(status(), 'profile')).toBeNull()
  expect(bannerFor(status(), 'applications')).toBeNull()
  expect(bannerFor(null, 'profile')).toBeNull()
})

test('no banner or LinkedIn step asks the user to type an import command', () => {
  const texts = [
    bannerFor(status({ profile_empty: true }), 'profile'),
    bannerFor(status({ pending_imports: pending }), 'profile'),
  ].map((banner) => `${banner?.title} ${banner?.body}`)
  for (const text of [...texts, ...LINKEDIN_STEPS]) expect(text).not.toMatch(/import my|say:/i)
})
