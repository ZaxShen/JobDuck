import { describe, expect, test } from 'bun:test'
import { hashFor, landingRoute, needsWelcome, profileSection, routeFromHash, viewFromHash } from '../web/src/lib/routing'
import type { FrontMatter, ProfileView } from '../web/src/lib/types'

const profileWith = (front_matter: FrontMatter): ProfileView => ({
  front_matter,
  sections: [],
  revision: 'r1',
  path: '<home>/profile.md',
})

const blank = profileWith({ name: '', target_titles: [] })
const named = profileWith({ name: '<your name>', target_titles: [] })
const targeted = profileWith({ name: '', target_titles: ['Software Engineer'] })

describe('needsWelcome', () => {
  test('a blank profile needs welcome', () => {
    expect(needsWelcome(blank)).toBe(true)
    expect(needsWelcome(profileWith({}))).toBe(true)
  })

  test('a name or a target title is enough', () => {
    expect(needsWelcome(named)).toBe(false)
    expect(needsWelcome(targeted)).toBe(false)
  })
})

describe('viewFromHash', () => {
  test('known views pass, anything else falls back to applications', () => {
    expect(viewFromHash('#settings')).toBe('settings')
    expect(viewFromHash('')).toBe('applications')
    expect(viewFromHash('#nowhere')).toBe('applications')
  })
})

describe('routeFromHash', () => {
  test('#profile/<slug> carries the section', () => {
    expect(routeFromHash('#profile/experience')).toEqual({ view: 'profile', section: 'experience' })
    expect(routeFromHash('#profile')).toEqual({ view: 'profile', section: null })
    expect(routeFromHash('#profile/')).toEqual({ view: 'profile', section: null })
  })

  test('only Profile has sections', () => {
    expect(routeFromHash('#settings/experience')).toEqual({ view: 'settings', section: null })
  })

  test('#facts redirects to the Experience facts section of Profile', () => {
    expect(routeFromHash('#facts')).toEqual({ view: 'profile', section: 'facts' })
    expect(hashFor(routeFromHash('#facts'))).toBe('#profile/facts')
  })

  test('hashFor round-trips', () => {
    for (const hash of ['#applications', '#profile', '#profile/cv-files', '#settings', '#welcome']) {
      expect(hashFor(routeFromHash(hash))).toBe(hash)
    }
  })
})

describe('profileSection', () => {
  const slugs = ['contact', 'eligibility', 'experience', 'facts']

  test('a known slug is kept', () => {
    expect(profileSection('experience', slugs)).toBe('experience')
  })

  test('a missing or unknown slug falls back to the first section', () => {
    expect(profileSection(null, slugs)).toBe('contact')
    expect(profileSection('nowhere', slugs)).toBe('contact')
  })
})

describe('landingRoute', () => {
  test('a blank profile opens welcome from any hash', () => {
    for (const hash of ['', '#applications', '#profile', '#facts', '#settings', '#nowhere']) {
      expect(landingRoute(hash, blank).view).toBe('welcome')
    }
  })

  test('a #welcome load stays on welcome whatever the profile', () => {
    expect(landingRoute('#welcome', blank).view).toBe('welcome')
    expect(landingRoute('#welcome', named).view).toBe('welcome')
  })

  test('a filled profile never redirects', () => {
    expect(landingRoute('', named).view).toBe('applications')
    expect(landingRoute('#profile', named).view).toBe('profile')
    expect(landingRoute('#settings', targeted).view).toBe('settings')
    expect(hashFor(landingRoute('#profile/experience', named))).toBe('#profile/experience')
  })

  test('a #facts load lands on #profile/facts', () => {
    expect(hashFor(landingRoute('#facts', targeted))).toBe('#profile/facts')
  })

  test('a failed profile load keeps the requested view', () => {
    expect(landingRoute('#settings', undefined).view).toBe('settings')
  })
})
