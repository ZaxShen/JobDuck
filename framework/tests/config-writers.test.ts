import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { type Sandbox, sandbox } from './helpers'
import { RevisionConflict } from '../src/config/files'
import { loadPermissions, readStoredPermissions, writePermissions } from '../src/config/permissions'
import { loadProfile, readStoredProfile, splitSections, updateProfile } from '../src/config/profile'
import { ensureHome, permissionsPath, profilePath } from '../src/paths'

let box: Sandbox

beforeEach(() => {
  box = sandbox()
  ensureHome(box.home)
})

afterEach(() => box.cleanup())

test('updateProfile sets only the given fields, merges links and keeps other sections', () => {
  const path = profilePath(box.home)
  const before = readStoredProfile(path)
  const after = updateProfile({
    frontMatter: { name: '<your name>', target_titles: ['Staff Engineer'], links: { github: 'https://github.com/example' } },
    sections: { Summary: 'Builds things at Acme.', Publications: 'A paper.' },
    revision: before.revision,
  }, path)

  expect(after.revision).not.toBe(before.revision)
  expect(after.frontMatter.name).toBe('<your name>')
  expect(after.frontMatter.target_titles).toEqual(['Staff Engineer'])
  expect(after.frontMatter.links).toEqual({ linkedin: '', github: 'https://github.com/example', portfolio: '' })
  expect(after.frontMatter.relocation).toBe('ask')
  const sections = splitSections(after.body).sections
  expect(sections.find((s) => s.title === 'Summary')?.content.trim()).toBe('Builds things at Acme.')
  expect(sections.find((s) => s.title === 'Experience')?.content).toContain('One entry per role')
  expect(sections.at(-1)).toEqual({ title: 'Publications', content: 'A paper.' })
  expect(loadProfile(path)).toEqual({ frontMatter: after.frontMatter, body: after.body })
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test('updateProfile replaces sections by title, case-insensitive', () => {
  const path = profilePath(box.home)
  updateProfile({ sections: { summary: 'First.' } }, path)
  const after = updateProfile({ sections: { SUMMARY: 'Second.' } }, path)
  const summaries = splitSections(after.body).sections.filter((s) => s.title.toLowerCase() === 'summary')
  expect(summaries).toHaveLength(1)
  expect(summaries[0]!.content.trim()).toBe('Second.')
})

test('updateProfile rejects a stale revision and unknown or invalid fields without writing', () => {
  const path = profilePath(box.home)
  const original = readFileSync(path, 'utf8')
  expect(() => updateProfile({ frontMatter: { name: 'x' }, revision: 'stale' }, path)).toThrow(RevisionConflict)
  expect(() => updateProfile({ frontMatter: { nickname: 'x' } }, path)).toThrow(/nickname/)
  expect(() => updateProfile({ frontMatter: { relocation: 'maybe' } }, path)).toThrow(/relocation/)
  expect(readFileSync(path, 'utf8')).toBe(original)
})

test('writePermissions round-trips, keeps unknown tables and comments the choices', () => {
  const path = permissionsPath(box.home)
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n[custom]\nkeep = true\n`)
  const before = readStoredPermissions(path)
  const next = structuredClone(before.permissions)
  next.modules.track = true
  next.apply.answers = { 'How did you hear about us?': 'Job board' }
  const after = writePermissions(next, before.revision, path)

  expect(after.permissions).toEqual(next)
  expect(loadPermissions(path)).toEqual(next)
  const text = readFileSync(path, 'utf8')
  expect(text).toContain('[custom]')
  expect(text).toContain('autonomy = "confirm_each"  # confirm_each | confirm_batch | auto_after_approvals')
  expect(text).toContain('"How did you hear about us?" = "Job board"')
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test('writePermissions rejects a stale revision and unknown keys without writing', () => {
  const path = permissionsPath(box.home)
  const original = readFileSync(path, 'utf8')
  const { permissions } = readStoredPermissions(path)
  expect(() => writePermissions(permissions, 'stale', path)).toThrow(RevisionConflict)
  expect(() => writePermissions({ ...permissions, modules: { ...permissions.modules, fly: true } }, undefined, path)).toThrow(/fly/)
  expect(readFileSync(path, 'utf8')).toBe(original)
})
