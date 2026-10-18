import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { type Sandbox, sandbox } from './helpers'
import { MODULES, type Permissions, isModuleEnabled, loadPermissions, parsePermissions } from '../src/config/permissions'
import { ProfileFrontMatter, loadProfile, parseProfile } from '../src/config/profile'
import { ensureHome, permissionsPath, profilePath } from '../src/paths'

const SAFE_APPLY: Permissions['apply'] = {
  autonomy: 'confirm_each',
  approvals_before_auto: 10,
  consents: {
    privacy_policy: false, terms: false, arbitration: false, background_check: false, e_signature: false, marketing_opt_in: false,
  },
  eeo: 'decline',
  ats_accounts: 'never',
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
