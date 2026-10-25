import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitsSinceStable, devVersion, lastStableTag } from '../scripts/dev-version'

test('a prerelease package version builds dev versions of its core', () => {
  expect(devVersion('0.2.0-rc.1', 7)).toBe('0.2.0-dev.7')
})

test('a stable package version builds dev versions of the next patch', () => {
  expect(devVersion('0.1.1', 3)).toBe('0.1.2-dev.3')
})

test('a PR appends a .gh label', () => {
  expect(devVersion('0.2.0-rc.1', 7, 17)).toBe('0.2.0-dev.7.gh17')
  expect(devVersion('0.1.1', 0, 1)).toBe('0.1.2-dev.0.gh1')
})

test('a non-positive or fractional PR is refused', () => {
  expect(() => devVersion('0.2.0', 1, 0)).toThrow('positive integer')
  expect(() => devVersion('0.2.0', 1, -3)).toThrow('positive integer')
  expect(() => devVersion('0.2.0', 1, 1.5)).toThrow('positive integer')
})

test('a malformed package version or count is refused', () => {
  expect(() => devVersion('0.2', 1)).toThrow('not X.Y.Z')
  expect(() => devVersion('0.2.0', -1)).toThrow('non-negative')
})

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

let repo: string

function git(...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd: repo, env: ENV })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
}

function commit(message: string): void {
  writeFileSync(join(repo, 'file.txt'), message)
  git('add', '-A')
  git('commit', '-q', '-m', message)
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'jobduck-dev-version-'))
  git('init', '-q', '-b', 'dev')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'tag.gpgsign', 'false')
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

test('without a stable tag every first-parent commit counts', () => {
  commit('one')
  commit('two')
  git('tag', 'v0.1.0-rc.1')
  expect(lastStableTag(repo)).toBeUndefined()
  expect(commitsSinceStable('HEAD', repo)).toBe(2)
})

test('the count starts at the highest stable tag by semver and skips prereleases', () => {
  commit('one')
  git('tag', 'v0.10.0')
  commit('two')
  git('tag', 'v0.9.0')
  commit('three')
  git('tag', 'v0.11.0-rc.1')
  commit('four')
  expect(lastStableTag(repo)).toBe('v0.10.0')
  expect(commitsSinceStable('HEAD', repo)).toBe(3)
  expect(commitsSinceStable('HEAD~1', repo)).toBe(2)
})

test('a merged branch counts once along the first parent', () => {
  commit('one')
  git('tag', 'v0.1.0')
  git('switch', '-q', '-c', 'feature')
  commit('a')
  commit('b')
  commit('c')
  git('switch', '-q', 'dev')
  git('merge', '-q', '--no-ff', '-m', 'merge feature', 'feature')
  expect(commitsSinceStable('HEAD', repo)).toBe(1)
})
