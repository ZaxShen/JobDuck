import { describe, expect, test } from 'bun:test'
import { SENIORITIES } from '../src/posting/fields'
import { allChecked, setAllChecked, toggleChecked } from '../web/src/lib/checks'
import { CV_FILES, PROFILE_GROUPS, SENIORITY, SETTINGS_GROUPS, visibleFields, type Field, type Group } from '../web/src/lib/forms'
import { SELF_ID_CHOICES, SELF_ID_KEYS, type SelfIdKey } from '../src/config/permissions'

const titleCased = (text: string) =>
  text.split(/[\s-]+/).filter((word) => /^\p{L}/u.test(word)).every((word) => /^\p{Lu}/u.test(word))

const MODES = ['remote', 'hybrid', 'onsite']
const profileField = (key: string): Field | undefined =>
  PROFILE_GROUPS.flatMap((group) => group.fields).find((field) => field.key === `front_matter.${key}`)

describe('Title Case', () => {
  test('every profile and settings group title and field label is Title Case', () => {
    const groups: Group[] = [...PROFILE_GROUPS, CV_FILES, ...SETTINGS_GROUPS]
    const texts = groups.flatMap((group) => [
      group.title,
      ...group.fields.flatMap((field) => [field.label, ...(field.columns ?? []).map((column) => column.label)]),
    ])
    expect(texts.filter((text) => !titleCased(text))).toEqual([])
  })
})

describe('profile target fields', () => {
  test('locations use the location combobox', () => {
    expect(profileField('locations')).toMatchObject({ label: 'Cities Or Regions', type: 'locations' })
  })

  test('seniority uses the career track picker over backend seniorities', () => {
    expect(profileField('seniority')?.type).toBe('seniority')
    expect([...SENIORITY]).toEqual([...SENIORITIES])
  })

  test('work modes offer Any and the pay floor label names the base salary', () => {
    expect(profileField('work_modes')).toMatchObject({ type: 'checks', anyLabel: 'Any' })
    expect(profileField('work_modes')?.options?.map(([value]) => value)).toEqual(MODES)
    expect(profileField('pay_floor')?.label).toBe('Minimum Annual Salary (Base)')
  })
})

describe('settings apply fields', () => {
  test('apply.email_codes is a select offering ask first, then auto_from_mail', () => {
    const field = SETTINGS_GROUPS.flatMap((group) => group.fields).find((f) => f.key === 'apply.email_codes')
    expect(field?.type).toBe('select')
    expect(field?.options).toEqual([['ask', 'Stop and ask me'], ['auto_from_mail', 'Read the code from my mail']])
  })
})

describe('settings self-identification fields', () => {
  const applying = SETTINGS_GROUPS.find((group) => group.title === 'Applying')!
  const selfIdField = (key: SelfIdKey) => applying.fields.find((f) => f.key === `apply.self_id.${key}`)
  const draft = (eeo: string) => ({ modules: { apply: true }, apply: { eeo } })

  test('each field offers exactly the schema choices, Prefer not to disclose first', () => {
    for (const key of SELF_ID_KEYS) {
      const field = selfIdField(key)
      expect(field?.type).toBe('select')
      expect(field?.options?.map(([value]) => value)).toEqual([...SELF_ID_CHOICES[key]])
      expect(field?.options?.[0]).toEqual(['decline', 'Prefer not to disclose'])
    }
  })

  test('the fields show only when demographic questions are answered from settings', () => {
    const shown = (eeo: string) => visibleFields(applying, draft(eeo)).map((f) => f.key).filter((k) => k.startsWith('apply.self_id.'))
    expect(shown('decline')).toEqual([])
    expect(shown('from_profile')).toEqual(SELF_ID_KEYS.map((key) => `apply.self_id.${key}`))
  })
})

describe('check group helpers', () => {
  test('allChecked is true only when every known option is on', () => {
    expect(allChecked(['hybrid', 'remote', 'onsite'], MODES)).toBe(true)
    expect(allChecked(['remote', 'hybrid'], MODES)).toBe(false)
    expect(allChecked([], [])).toBe(false)
  })

  test('toggleChecked keeps option order and unknown saved values', () => {
    expect(toggleChecked(['onsite', 'legacy'], MODES, 'remote', true)).toEqual(['remote', 'onsite', 'legacy'])
    expect(toggleChecked(['remote', 'onsite'], MODES, 'remote', false)).toEqual(['onsite'])
  })

  test('setAllChecked selects or clears every known option and keeps unknown values', () => {
    expect(setAllChecked(['legacy', 'hybrid'], MODES, true)).toEqual([...MODES, 'legacy'])
    expect(setAllChecked(['legacy', 'hybrid'], MODES, false)).toEqual(['legacy'])
  })
})
