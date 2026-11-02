import { describe, expect, test } from 'bun:test'
import { SENIORITIES } from '../src/posting/fields'
import { SENIORITY } from '../web/src/lib/forms'
import { LOCATION_LIMIT, LOCATIONS, searchLocations } from '../web/src/lib/locations'
import { inferTrack, levelsFor, pruneToTrack, SENIORITY_LABELS, toggleLevel, TRACKS } from '../web/src/lib/seniority'
import { careerDna, DEFAULT_QUIZ, isToggle, modeOf, QUIZ, workModesOf } from '../web/src/lib/wizard'
import { doneSummary, NOTHING_SAVED } from '../web/src/lib/wizard-done'

const titleCased = (text: string) =>
  text.split(/[\s-]+/).filter((word) => /^\p{L}/u.test(word)).every((word) => /^\p{Lu}/u.test(word))

describe('quiz', () => {
  test('asks builder, risk, team, mode, then motivation', () => {
    expect(QUIZ.map((question) => question.title)).toEqual([
      'Build New Or Improve?',
      'Startup Or Established Company?',
      'Team Size',
      'Work Mode',
      'What Drives You?',
    ])
  })

  test('every title, subtitle and label is Title Case', () => {
    const texts = QUIZ.flatMap((question) => [
      question.title,
      question.subtitle,
      ...(isToggle(question) ? question.options.map(([, label]) => label) : [question.left, question.right]),
    ])
    const wrong = texts.filter((text) => !titleCased(text))
    expect(wrong).toEqual([])
  })

  test('wizard labels outside the quiz are Title Case too', () => {
    const texts = [
      ...TRACKS.map(([, label]) => label),
      ...Object.values(SENIORITY_LABELS),
      doneSummary({ uploaded: false, saved: NOTHING_SAVED, modulesOn: 0 }).title,
      doneSummary({ uploaded: true, saved: { quiz: true, targets: true, modules: true }, modulesOn: 1 }).title,
    ]
    expect(texts.filter((text) => !titleCased(text))).toEqual([])
  })

  test('the Title Case check rejects a lowercase word', () => {
    expect(titleCased('Startup or Established Company?')).toBe(false)
    expect(titleCased('On-site')).toBe(false)
    expect(titleCased('On-Site')).toBe(true)
  })
})

describe('work mode', () => {
  test('offers Remote, Hybrid, On-Site and Any', () => {
    const mode = QUIZ.find((question) => question.key === 'mode')
    expect(mode && isToggle(mode) ? mode.options.map(([, label]) => label) : []).toEqual(['Remote', 'Hybrid', 'On-Site', 'Any'])
  })

  test('Any saves every work mode and reads back as Any', () => {
    expect(workModesOf('any')).toEqual(['remote', 'hybrid', 'onsite'])
    expect(modeOf(workModesOf('any'))).toBe('any')
    expect(modeOf(['onsite', 'remote', 'hybrid'])).toBe('any')
  })

  test('a single mode saves and reads back as itself', () => {
    expect(workModesOf('hybrid')).toEqual(['hybrid'])
    expect(modeOf(['hybrid'])).toBe('hybrid')
    expect(modeOf(['remote', 'hybrid'])).toBe('remote')
  })

  test('nothing usable saved leaves the mode unset', () => {
    expect(modeOf([])).toBeUndefined()
    expect(modeOf(['mars'])).toBeUndefined()
  })

  test('Career DNA names Any', () => {
    expect(careerDna({ ...DEFAULT_QUIZ, mode: 'any' })).toContain('- Work Mode: Any')
  })
})

describe('seniority', () => {
  test('the web list matches the backend enum exactly', () => {
    expect([...SENIORITY]).toEqual([...SENIORITIES])
    expect(Object.keys(SENIORITY_LABELS)).toEqual([...SENIORITIES])
    expect(SENIORITY_LABELS.entry).toBe('Entry Level')
  })

  test('each track lists its levels in enum order', () => {
    expect(levelsFor('ic')).toEqual(['intern', 'entry', 'mid', 'senior', 'staff', 'principal', 'lead'])
    expect(levelsFor('manager')).toEqual(['lead', 'manager', 'director', 'executive'])
    expect(levelsFor('both')).toEqual([...SENIORITIES])
  })

  test('the track is inferred from saved levels, with lead counting for neither', () => {
    expect(inferTrack([])).toBe('ic')
    expect(inferTrack(['senior', 'staff'])).toBe('ic')
    expect(inferTrack(['director'])).toBe('manager')
    expect(inferTrack(['senior', 'manager'])).toBe('both')
    expect(inferTrack(['lead'])).toBe('ic')
    expect(inferTrack(['lead', 'director'])).toBe('manager')
    expect(inferTrack(['lead', 'staff'])).toBe('ic')
  })

  test('switching track drops levels outside it', () => {
    expect(pruneToTrack(['senior', 'lead', 'director'], 'ic')).toEqual(['senior', 'lead'])
    expect(pruneToTrack(['senior', 'lead', 'director'], 'manager')).toEqual(['lead', 'director'])
    expect(pruneToTrack(['senior', 'director'], 'both')).toEqual(['senior', 'director'])
  })

  test('toggling keeps selections in enum order without duplicates', () => {
    expect(toggleLevel(['staff'], 'entry', true)).toEqual(['entry', 'staff'])
    expect(toggleLevel(['entry', 'staff'], 'staff', true)).toEqual(['entry', 'staff'])
    expect(toggleLevel(['entry', 'staff'], 'entry', false)).toEqual(['staff'])
  })
})

describe('locations', () => {
  test('the list holds Remote, countries, states, provinces and metros, once each', () => {
    expect(LOCATIONS[0]).toBe('Remote')
    for (const place of ['United States', 'Germany', 'California, US', 'Ontario, CA', 'San Francisco Bay Area, US', 'London, GB', 'Bengaluru, IN']) {
      expect(LOCATIONS).toContain(place)
    }
    expect(new Set(LOCATIONS).size).toBe(LOCATIONS.length)
    expect(LOCATIONS.length).toBeGreaterThan(249 + 50 + 13 + 100)
  })

  test('search is case-insensitive substring matching', () => {
    expect(searchLocations('LONDON')).toContain('London, GB')
    expect(searchLocations('fornia')).toContain('California, US')
    expect(searchLocations('sao paulo')).toContain('São Paulo, BR')
    expect(searchLocations('zzqx')).toEqual([])
  })

  test('matches that start with the query come first', () => {
    expect(searchLocations('san')[0]).toBe('San Francisco Bay Area, US')
  })

  test('results are capped', () => {
    expect(searchLocations('a').length).toBe(LOCATION_LIMIT)
    expect(searchLocations('').length).toBe(LOCATION_LIMIT)
    expect(LOCATION_LIMIT).toBe(50)
  })
})
