import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Sandbox, sandbox } from './helpers'
import {
  ApplyManifest, MODULES, type Permissions, isModuleEnabled, loadPermissions, parsePermissions, serializePermissions,
} from '../src/config/permissions'
import { ProfileFrontMatter, loadProfile, parseProfile } from '../src/config/profile'
import { ensureHome, permissionsPath, profilePath } from '../src/paths'

const SAFE_APPLY: Permissions['apply'] = {
  autonomy: 'confirm_each',
  approvals_before_auto: 10,
  consents: {
    privacy_policy: false, terms: false, arbitration: false, background_check: false, e_signature: false, marketing_opt_in: false,
  },
  eeo: 'decline',
  self_id: { gender: 'decline', veteran_status: 'decline', disability_status: 'decline' },
  ats_accounts: 'never',
  email_codes: 'ask',
  salary_mode: 'leave_blank',
  salary_floor: 0,
  salary_fixed_total: 0,
  salary_fixed_base: 0,
  uploads: ['cv'],
  cover_letter: 'only_when_required',
  tailor_cv: 'never',
  free_text: 'draft_for_approval',
  skip_companies: [],
  max_per_run: 10,
  marker: true,
  answers: {},
}

let box: Sandbox
beforeEach(() => { box = sandbox() })
afterEach(() => box.cleanup())

test('ensureHome creates a private home with both templates', () => {
  const { created } = ensureHome()
  expect(created).toHaveLength(3)
  expect(statSync(box.home).mode & 0o777).toBe(0o700)
  expect(ensureHome().created).toEqual([])
})

test('ensureHome keeps existing files', () => {
  ensureHome()
  writeFileSync(permissionsPath(), '[modules]\ntrack = true\n')
  ensureHome()
  expect(readFileSync(permissionsPath(), 'utf8')).toBe('[modules]\ntrack = true\n')
})

test('permissions template parses with every module off and safe defaults', () => {
  ensureHome()
  const permissions = loadPermissions()
  for (const name of MODULES) expect(permissions.modules[name]).toBe(false)
  expect(permissions.apply).toEqual(SAFE_APPLY)
  expect(permissions.track).toEqual({ sync_url: '', sync_token: '' })
  expect(permissions.cv).toEqual({ page_limit: 2 })
})

test('an empty permissions file gets the same safe defaults', () => {
  expect(parsePermissions('').apply).toEqual(SAFE_APPLY)
  expect(parsePermissions('[apply]\n').apply).toEqual(SAFE_APPLY)
})

test('isModuleEnabled reflects edits', () => {
  ensureHome()
  const text = readFileSync(permissionsPath(), 'utf8').replace('track = false', 'track = true')
  writeFileSync(permissionsPath(), text)
  expect(isModuleEnabled('track')).toBe(true)
  expect(isModuleEnabled('apply')).toBe(false)
})

test('apply manifest accepts the final schema', () => {
  const ok = parsePermissions([
    '[modules]', 'apply = true',
    '[apply]', 'autonomy = "auto_after_approvals"', 'approvals_before_auto = 5', 'salary_mode = "fixed"',
    'salary_fixed_total = 150000', 'uploads = ["cv", "portfolio"]', 'skip_companies = ["Acme"]', 'marker = false',
    '[apply.consents]', 'background_check = true',
    '[apply.answers]', 'non_compete = "No"',
  ].join('\n'))
  expect(ok.apply.autonomy).toBe('auto_after_approvals')
  expect(ok.apply.approvals_before_auto).toBe(5)
  expect(ok.apply.consents).toEqual({ ...SAFE_APPLY.consents, background_check: true })
  expect(ok.apply.uploads).toEqual(['cv', 'portfolio'])
  expect(ok.apply.answers).toEqual({ non_compete: 'No' })
  expect(ok.apply.marker).toBe(false)
  expect(ok.apply.tailor_cv).toBe('never')
})

test('apply manifest rejects unknown keys and bad values', () => {
  for (const bad of [
    '[apply]\nautonomy = "confirm"\n',
    '[apply]\nautonomy = "yolo"\n',
    '[apply]\nunknown_key = 1\n',
    '[apply]\neeo = "always"\n',
    '[apply.self_id]\ngender = "unknown"\n',
    '[apply.self_id]\nveteran_status = true\n',
    '[apply.self_id]\ndisability_status = "maybe"\n',
    '[apply.self_id]\nrace = "decline"\n',
    '[apply]\nats_accounts = "sometimes"\n',
    '[apply]\nsalary_mode = "max"\n',
    '[apply]\nuploads = ["selfie"]\n',
    '[apply]\ncover_letter = "sometimes"\n',
    '[apply]\ntailor_cv = "maybe"\n',
    '[apply]\nfree_text = "draft"\n',
    '[apply]\nmax_per_run = 0\n',
    '[apply]\nmarker = "yes"\n',
    '[apply.consents]\nsell_my_data = true\n',
    '[apply.consents]\nterms = "yes"\n',
    '[apply.answers]\nrelocation = true\n',
    '[modules]\nteleport = true\n',
  ]) expect(() => parsePermissions(bad)).toThrow()
})

test('self_id defaults every field to decline', () => {
  expect(ApplyManifest.parse({}).self_id).toEqual({ gender: 'decline', veteran_status: 'decline', disability_status: 'decline' })
})

test('self_id keeps answered and declined fields apart and round-trips with comments', () => {
  const permissions = parsePermissions([
    '[apply]', 'eeo = "from_profile"',
    '[apply.self_id]', 'gender = "non_binary"', 'veteran_status = "not_veteran"',
  ].join('\n'))
  expect(permissions.apply.self_id).toEqual({ gender: 'non_binary', veteran_status: 'not_veteran', disability_status: 'decline' })
  const text = serializePermissions(permissions)
  expect(text).toContain('[apply.self_id]')
  expect(text).toContain('gender = "non_binary"  # decline | female | male | non_binary')
  expect(text).toContain('disability_status = "decline"  # decline | no | yes')
  expect(parsePermissions(text).apply.self_id).toEqual(permissions.apply.self_id)
})

test('email_codes defaults to ask', () => {
  expect(ApplyManifest.parse({}).email_codes).toBe('ask')
  expect(parsePermissions('[apply]\n').apply.email_codes).toBe('ask')
})

test('email_codes = "auto_from_mail" round-trips through serializePermissions with its comment', () => {
  const permissions = parsePermissions('[apply]\nemail_codes = "auto_from_mail"\n')
  expect(permissions.apply.email_codes).toBe('auto_from_mail')
  const text = serializePermissions(permissions)
  expect(text).toContain('email_codes = "auto_from_mail"  # ask | auto_from_mail\n')
  expect(parsePermissions(text).apply.email_codes).toBe('auto_from_mail')
})

test('email_codes rejects an unknown value', () => {
  for (const bad of ['always', 'sms', '', true]) expect(() => ApplyManifest.parse({ email_codes: bad })).toThrow()
  expect(() => parsePermissions('[apply]\nemail_codes = "auto"\n')).toThrow()
})

test('the template documents email_codes = "ask" with its options', () => {
  const text = readFileSync(join(import.meta.dir, '..', 'templates', 'permissions.toml'), 'utf8')
  expect(text).toMatch(/^email_codes = "ask" +# ask \| auto_from_mail$/m)
})

test('profile template parses front matter and keeps the body', () => {
  ensureHome()
  const profile = loadProfile(profilePath())
  expect(profile.frontMatter).toEqual(ProfileFrontMatter.parse({}))
  expect(profile.frontMatter.relocation).toBe('ask')
  expect(profile.frontMatter.links).toEqual({ linkedin: '', github: '', portfolio: '' })
  for (const section of ['Summary', 'Experience', 'Projects', 'Education', 'Writing style', 'Facts never to change']) {
    expect(profile.body).toContain(`# ${section}\n`)
  }
  const edited = parseProfile('+++\nname = "Ada"\ntarget_titles = ["AI Engineer"]\n+++\nHello\n')
  expect(edited.frontMatter.name).toBe('Ada')
  expect(edited.frontMatter.target_titles).toEqual(['AI Engineer'])
  expect(edited.body).toBe('Hello\n')
  expect(edited.frontMatter.company_stages).toEqual([])
})

test('profile front matter reads cv_files tables, links and company stages', () => {
  const profile = parseProfile([
    '+++', 'company_stages = ["series_a", "public"]', 'sponsorship_required = true', 'relocation = "yes"',
    '[links]', 'github = "https://github.com/example"',
    '[[cv_files]]', 'match = "scientist"', 'path = "/cv/scientist.pdf"',
    '[[cv_files]]', 'match = ".*"', 'path = "/cv/general.pdf"', '+++', '',
  ].join('\n'))
  expect(profile.frontMatter.company_stages).toEqual(['series_a', 'public'])
  expect(profile.frontMatter.links.github).toBe('https://github.com/example')
  expect(profile.frontMatter.cv_files.map((file) => file.path)).toEqual(['/cv/scientist.pdf', '/cv/general.pdf'])
  expect(() => parseProfile('+++\nrelocation = "maybe"\n+++\n')).toThrow()
})
