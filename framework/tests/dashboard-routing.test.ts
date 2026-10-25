import { describe, expect, test } from 'bun:test'
import { landingView, needsWelcome, viewFromHash } from '../web/src/lib/routing'
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

describe('landingView', () => {
  test('a blank profile opens welcome from any hash', () => {
    for (const hash of ['', '#applications', '#profile', '#facts', '#settings', '#nowhere']) {
      expect(landingView(hash, blank)).toBe('welcome')
    }
  })

  test('a #welcome load stays on welcome whatever the profile', () => {
    expect(landingView('#welcome', blank)).toBe('welcome')
    expect(landingView('#welcome', named)).toBe('welcome')
  })

  test('a filled profile never redirects', () => {
    expect(landingView('', named)).toBe('applications')
    expect(landingView('#profile', named)).toBe('profile')
    expect(landingView('#settings', targeted)).toBe('settings')
    expect(landingView('#facts', targeted)).toBe('facts')
  })

  test('a failed profile load keeps the requested view', () => {
    expect(landingView('#settings', undefined)).toBe('settings')
  })
})
