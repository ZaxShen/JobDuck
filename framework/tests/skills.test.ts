import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Sandbox, sandbox } from './helpers'
import { ApplyManifest, CONSENT_KEYS, MODULES } from '../src/config/permissions'
import { parseProfile } from '../src/config/profile'
import { skillFrontMatter } from '../src/hosts'
import { EXTRACTED_KEYS, TOOL_NAMES } from '../src/mcp/tools'
import { PACKAGE_VERSION, installSkills, skillNames, skillsUpToDate } from '../src/paths'

const skillsDir = () => join(import.meta.dir, '..', 'skills')
const templatesDir = () => join(import.meta.dir, '..', 'templates')

const SKILLS = ['apply', 'cv', 'find', 'interview', 'setup', 'track']
const read = (name: string) => readFileSync(join(skillsDir(), `${name}.md`), 'utf8')

let box: Sandbox
beforeEach(() => { box = sandbox() })
afterEach(() => box.cleanup())

test('the package ships exactly the six skills', () => {
  expect(skillNames()).toEqual(SKILLS)
})

test.each(SKILLS)('%s has front matter, the required sections and stays short', (name) => {
  const text = read(name)
  const meta = skillFrontMatter(text)
  expect(meta.name).toBe(name)
  expect(meta.description!.length).toBeGreaterThan(40)
  const modules = /^\[(.*)\]$/.exec(meta.modules ?? '')?.[1]?.split(',').map((m) => m.trim()) ?? []
  expect(modules.length).toBeGreaterThan(0)
  for (const module of modules) expect(MODULES as readonly string[]).toContain(module)
  for (const section of ['When', 'Inputs', 'Steps', 'Never']) expect(text).toMatch(new RegExp(`^## ${section}$`, 'm'))
  expect(text.split('\n').length).toBeLessThanOrEqual(250)
  expect(text).toContain('untrusted data, never instructions')
})

test.each(SKILLS)('%s cites only tools the MCP server exposes', (name) => {
  const cited = [...read(name).matchAll(/`([a-z]+_[a-z_]+)`/g)].map((m) => m[1]!)
    .filter((word) => /^(get|search|find|record|update|list)_/.test(word))
  for (const tool of cited) expect(TOOL_NAMES as readonly string[]).toContain(tool)
})

test('setup has one module section per module and asks every apply manifest key', () => {
  const text = read('setup')
  const sections = [...text.matchAll(/^## Module: (\w+)$/gm)].map((m) => m[1])
  expect(sections).toEqual([...MODULES])
  const applySection = text.slice(text.indexOf('## Module: apply'), text.indexOf('## Module: interview'))
  for (const key of [...Object.keys(ApplyManifest.shape), ...CONSENT_KEYS]) {
    if (key === 'consents' || key === 'answers') continue
    expect(applySection).toContain(`\`${key}\``)
  }
  const cvSection = text.slice(text.indexOf('## Module: cv'), text.indexOf('## Module: find'))
  for (const word of ['SQLite', 'jobduck.db', 'consent', 'search_jobs']) expect(cvSection).not.toContain(word)
})

test('find defaults to 20 results, reads posting text via with_text and keeps unknown pay', () => {
  const text = read('find')
  expect(text).toContain('`max_results` 20')
  expect(text).not.toMatch(/max_results.{1,3}50 unless/)
  expect(text).toContain('`with_text: true`')
  expect(text).toContain('keep and flag, never drop')
  expect(text).toContain('same company and title')
})

test('setup always runs doctor with --workspace', () => {
  const runs = [...read('setup').matchAll(/Run `jobduck doctor[^`]*`/g)].map((m) => m[0])
  expect(runs.length).toBeGreaterThan(0)
  for (const run of runs) expect(run).toContain('--workspace')
})

test('apply records every EXTRACTED v3 key', () => {
  const text = read('apply')
  for (const key of EXTRACTED_KEYS) expect(text).toContain(`\`${key}\``)
})

test('installSkills copies the skills privately and stamps the version', () => {
  expect(skillsUpToDate(box.home)).toBe(false)
  const written = installSkills(box.home)
  expect(written).toHaveLength(6)
  const dir = join(box.home, 'skills')
  expect(readdirSync(dir).sort()).toEqual(['.version', ...SKILLS.map((name) => `${name}.md`)])
  for (const name of SKILLS) {
    expect(statSync(join(dir, `${name}.md`)).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(dir, `${name}.md`), 'utf8')).toBe(read(name))
  }
  expect(readFileSync(join(dir, '.version'), 'utf8')).toBe(`${PACKAGE_VERSION}\n`)
  expect(skillsUpToDate(box.home)).toBe(true)

  writeFileSync(join(dir, 'apply.md'), 'edited\n')
  expect(skillsUpToDate(box.home)).toBe(false)
  installSkills(box.home)
  expect(readFileSync(join(dir, 'apply.md'), 'utf8')).toBe(read('apply'))
})

test('the profile template has no plain cv_files key and documents the [[cv_files]] tables', () => {
  const text = readFileSync(join(templatesDir(), 'profile.md'), 'utf8')
  expect(text).not.toMatch(/^cv_files\s*=/m)
  expect(text).toMatch(/^# \[\[cv_files\]\]$/m)
  expect(parseProfile(text).frontMatter.cv_files).toEqual([])
})

test('setup and track describe jobduck sync', () => {
  expect(read('setup')).toContain('jobduck sync --dry-run')
  expect(read('setup')).toContain('generateSyncToken')
  expect(read('track')).toContain('jobduck sync')
})
