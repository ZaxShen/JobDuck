import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GATE = join(import.meta.dir, '..', 'scripts', 'release-gate.sh')
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  RELEASE_DEV_REF: 'dev',
  RELEASE_MAIN_REF: 'main',
}

let repo: string

function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: repo, env: ENV })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function commit(files: Record<string, string>, message: string): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  git('add', '-A')
  git('commit', '-q', '-m', message)
}

const pkg = (version: string, extra = '') => `{\n  "name": "jobduck",\n  "version": "${version}",${extra}\n  "type": "module"\n}\n`

function gate(tag: string): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(['bash', GATE, tag], { cwd: join(repo, 'framework'), env: ENV })
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'jobduck-gate-'))
  git('init', '-q', '-b', 'dev')
  commit({ 'framework/package.json': pkg('0.1.0'), 'framework/src.ts': 'one' }, 'first')
  git('tag', 'v0.1.0-rc.1')
  git('tag', 'v0.1.0')
  commit({ 'framework/package.json': pkg('0.2.0-rc.1'), 'framework/src.ts': 'two' }, 'feature')
  git('tag', 'v0.2.0-rc.1')
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

test('an rc tag on dev ships as a prerelease', () => {
  expect(gate('v0.2.0-rc.1')).toEqual({ code: 0, out: 'channel=rc\n', err: '' })
})

test('an rc tag off dev is refused', () => {
  git('switch', '-q', '-c', 'side')
  commit({ 'framework/src.ts': 'untested' }, 'side work')
  git('tag', 'v0.2.0-rc.2')
  const result = gate('v0.2.0-rc.2')
  expect(result.code).toBe(1)
  expect(result.err).toContain('is not on dev')
})

test('a stable tag on main that only bumps the version after its rc ships', () => {
  commit({ 'framework/package.json': pkg('0.2.0') }, 'release 0.2.0')
  git('branch', 'main')
  git('tag', 'v0.2.0')
  expect(gate('v0.2.0')).toEqual({ code: 0, out: 'channel=stable\nrc=v0.2.0-rc.1\nprevious=v0.1.0\n', err: '' })
})

test('a stable tag without a release candidate is refused', () => {
  commit({ 'framework/package.json': pkg('0.3.0') }, 'skip the rc')
  git('branch', 'main')
  git('tag', 'v0.3.0')
  const result = gate('v0.3.0')
  expect(result.code).toBe(1)
  expect(result.err).toContain('no v0.3.0-rc.N tag')
})

test('a stable tag that changes code since its rc is refused', () => {
  commit({ 'framework/package.json': pkg('0.2.0'), 'framework/src.ts': 'last-minute fix' }, 'release 0.2.0')
  git('branch', 'main')
  git('tag', 'v0.2.0')
  const result = gate('v0.2.0')
  expect(result.code).toBe(1)
  expect(result.err).toContain('changes files since v0.2.0-rc.1: framework/src.ts')
})

test('a stable tag that changes package.json beyond the version is refused', () => {
  commit({ 'framework/package.json': pkg('0.2.0', '\n  "dependencies": { "left-pad": "1.3.0" },') }, 'release 0.2.0')
  git('branch', 'main')
  git('tag', 'v0.2.0')
  const result = gate('v0.2.0')
  expect(result.code).toBe(1)
  expect(result.err).toContain('beyond the version')
})

test('a stable tag off main is refused', () => {
  commit({ 'framework/package.json': pkg('0.2.0') }, 'release 0.2.0')
  git('tag', 'v0.2.0')
  git('branch', 'main', 'v0.1.0')
  const result = gate('v0.2.0')
  expect(result.code).toBe(1)
  expect(result.err).toContain('is not on main')
})

test('tags that are neither vX.Y.Z nor vX.Y.Z-rc.N are refused', () => {
  git('tag', 'v0.2.0-beta.1')
  const result = gate('v0.2.0-beta.1')
  expect(result.code).toBe(1)
  expect(result.err).toContain('neither vX.Y.Z nor vX.Y.Z-rc.N')
})
