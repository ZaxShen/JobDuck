import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEV_TAG, RELEASE_REPO, assetName, channelOf, compareVersions, runUpgrade } from '../src/commands/upgrade'
import { PACKAGE_VERSION } from '../src/paths'
import type { FetchLike } from '../src/sync/client'

const NEW_VERSION = '9.9.9'
const ASSET = 'jobduck-darwin-arm64'
const NEW_BYTES = 'new jobduck binary'
const DOWNLOAD = `https://github.com/${RELEASE_REPO}/releases/download/v${NEW_VERSION}`
const CDN = 'https://objects.githubusercontent.com/release-asset'

let dir: string
let execPath: string
let calls: { url: string; init: RequestInit }[]
let lines: string[]
let errors: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jobduck-upgrade-'))
  execPath = join(dir, 'jobduck')
  writeFileSync(execPath, 'old jobduck binary', { mode: 0o755 })
  calls = []
  lines = []
  errors = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

function release(tag = `v${NEW_VERSION}`) {
  return {
    tag_name: tag,
    assets: [ASSET, 'jobduck-linux-x64', 'SHA256SUMS'].map((name) => ({ name, browser_download_url: `${DOWNLOAD}/${name}` })),
  }
}

interface GithubOptions { tag?: string; api?: (url: string) => unknown; sums?: string; binary?: string; binaryRedirect?: string }

function github(options: GithubOptions = {}): FetchLike {
  const sums = options.sums ?? `${sha(NEW_BYTES)}  ${ASSET}\n${sha('linux')}  jobduck-linux-x64\n`
  return async (url, init) => {
    calls.push({ url, init })
    if (url.startsWith(`https://api.github.com/repos/${RELEASE_REPO}/releases`)) return Response.json(options.api ? options.api(url) : release(options.tag))
    if (url === `${DOWNLOAD}/SHA256SUMS`) return new Response(sums)
    if (url === `${DOWNLOAD}/${ASSET}`) {
      return new Response(null, { status: 302, headers: { Location: options.binaryRedirect ?? `${CDN}/${ASSET}?sig=abc` } })
    }
    if (url === `${CDN}/${ASSET}?sig=abc`) return new Response(options.binary ?? NEW_BYTES)
    return new Response('not found', { status: 404 })
  }
}

const run = (fetch: FetchLike, extra: Parameters<typeof runUpgrade>[0] = {}) => runUpgrade({
  fetch, execPath, platform: 'darwin', arch: 'arm64', out: (line) => { lines.push(line) }, err: (line) => { errors.push(line) }, ...extra,
})

test('asset names follow jobduck-<os>-<arch> with .exe on Windows', () => {
  expect(assetName('darwin', 'arm64')).toBe('jobduck-darwin-arm64')
  expect(assetName('linux', 'x64')).toBe('jobduck-linux-x64')
  expect(assetName('win32', 'x64')).toBe('jobduck-windows-x64.exe')
  expect(() => assetName('freebsd', 'x64')).toThrow('no jobduck release for freebsd-x64')
  expect(() => assetName('linux', 'ia32')).toThrow()
})

test('a verified download replaces the executable', async () => {
  expect(await run(github())).toBe(0)
  expect(readFileSync(execPath, 'utf8')).toBe(NEW_BYTES)
  expect(statSync(execPath).mode & 0o777).toBe(0o755)
  expect(existsSync(`${execPath}.new`)).toBe(false)
  expect(existsSync(`${execPath}.old`)).toBe(false)
  expect(lines).toEqual([`upgraded ${PACKAGE_VERSION} -> ${NEW_VERSION}`])
  expect(errors).toEqual([])
  const api = calls[0]!
  expect(api.url).toBe(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`)
  expect(api.init.headers).toMatchObject({ Accept: 'application/vnd.github+json', 'User-Agent': `jobduck/${PACKAGE_VERSION}` })
  expect(calls.map((call) => call.url).slice(1)).toEqual([`${DOWNLOAD}/SHA256SUMS`, `${DOWNLOAD}/${ASSET}`, `${CDN}/${ASSET}?sig=abc`])
})

test('a checksum mismatch leaves the executable untouched', async () => {
  expect(await run(github({ binary: 'tampered bytes' }))).toBe(1)
  expect(readFileSync(execPath, 'utf8')).toBe('old jobduck binary')
  expect(existsSync(`${execPath}.new`)).toBe(false)
  expect(errors[0]).toContain(`checksum mismatch for ${ASSET}`)
  expect(lines).toEqual([])
})

test('a SHA256SUMS without a line for the asset refuses to upgrade', async () => {
  expect(await run(github({ sums: `${sha('linux')}  jobduck-linux-x64\n` }))).toBe(1)
  expect(readFileSync(execPath, 'utf8')).toBe('old jobduck binary')
  expect(errors[0]).toContain(`SHA256SUMS has no line for ${ASSET}`)
  expect(calls.some((call) => call.url.includes(CDN))).toBe(false)
})

test('--check prints current and latest without downloading', async () => {
  expect(await run(github(), { check: true })).toBe(0)
  expect(lines).toEqual([`current ${PACKAGE_VERSION}`, `latest ${NEW_VERSION}`, 'channel stable'])
  expect(calls).toHaveLength(1)
  expect(readFileSync(execPath, 'utf8')).toBe('old jobduck binary')
})

test('--check returns 1 on a network failure', async () => {
  const offline: FetchLike = async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com') }
  expect(await run(offline, { check: true })).toBe(1)
  expect(errors[0]).toContain('ENOTFOUND')
})

test('the same version reports already up to date and downloads nothing', async () => {
  expect(await run(github({ tag: `v${PACKAGE_VERSION}` }))).toBe(0)
  expect(lines).toEqual([`already up to date (${PACKAGE_VERSION})`])
  expect(calls).toHaveLength(1)
})

test('an explicit version fetches that release tag', async () => {
  expect(await run(github(), { version: NEW_VERSION, check: true })).toBe(0)
  expect(calls[0]!.url).toBe(`https://api.github.com/repos/${RELEASE_REPO}/releases/tags/v${NEW_VERSION}`)
})

test('a redirect off GitHub is never followed', async () => {
  expect(await run(github({ binaryRedirect: 'https://evil.example.com/jobduck' }))).toBe(1)
  expect(errors[0]).toContain('refusing to fetch from evil.example.com')
  expect(calls.some((call) => call.url.includes('evil.example.com'))).toBe(false)
  expect(readFileSync(execPath, 'utf8')).toBe('old jobduck binary')
})

test('on Windows the running file is moved to .old before the swap', async () => {
  const sums = `${sha(NEW_BYTES)}  jobduck-windows-x64.exe\n`
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    if (url.startsWith('https://api.github.com/')) {
      return Response.json({
        tag_name: `v${NEW_VERSION}`,
        assets: ['jobduck-windows-x64.exe', 'SHA256SUMS'].map((name) => ({ name, browser_download_url: `${DOWNLOAD}/${name}` })),
      })
    }
    return new Response(url.endsWith('SHA256SUMS') ? sums : NEW_BYTES)
  }
  expect(await run(fetch, { platform: 'win32', arch: 'x64' })).toBe(0)
  expect(readFileSync(execPath, 'utf8')).toBe(NEW_BYTES)
  expect(readFileSync(`${execPath}.old`, 'utf8')).toBe('old jobduck binary')
})

test('versions order by semver: dev < rc < stable within a version, rc.10 after rc.9', () => {
  const sorted = ['0.2.0-rc.1', '0.1.1', '0.1.1-rc.10', '0.1.0', '0.1.1-rc.9', '0.1.1-dev.3+abc1234', 'v0.1.1-rc.2']
    .sort(compareVersions)
  expect(sorted).toEqual(['0.1.0', '0.1.1-dev.3+abc1234', 'v0.1.1-rc.2', '0.1.1-rc.9', '0.1.1-rc.10', '0.1.1', '0.2.0-rc.1'])
  expect(() => compareVersions('0.1', '0.1.0')).toThrow()
})

test('the channel follows the installed version', () => {
  expect(channelOf('0.1.1')).toBe('stable')
  expect(channelOf('0.2.0-rc.1')).toBe('rc')
  expect(channelOf('0.1.2-dev.7+abc1234')).toBe('dev')
})

test('the rc channel picks the highest stable or rc release, skipping drafts and dev builds', async () => {
  const list = [
    release('v9.9.8'),
    release(DEV_TAG),
    { ...release('v9.9.9-rc.3'), draft: true },
    release('v9.9.9-rc.2'),
    release('nightly'),
  ]
  expect(await run(github({ api: () => list }), { channel: 'rc', check: true })).toBe(0)
  expect(calls[0]!.url).toBe(`https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=30`)
  expect(lines).toEqual([`current ${PACKAGE_VERSION}`, 'latest 9.9.9-rc.2', 'channel rc'])
})

test('the stable channel never downgrades on its own', async () => {
  expect(await run(github({ tag: 'v0.0.1' }))).toBe(0)
  expect(lines[0]).toContain(`current ${PACKAGE_VERSION} is newer than the latest stable release 0.0.1`)
  expect(calls).toHaveLength(1)
  expect(readFileSync(execPath, 'utf8')).toBe('old jobduck binary')
})

test('switching channel installs that channel even when it is older', async () => {
  expect(await run(github({ api: () => [release('v0.0.1-rc.1')] }), { channel: 'rc' })).toBe(0)
  expect(lines).toEqual([`downgraded ${PACKAGE_VERSION} -> 0.0.1-rc.1`])
  expect(readFileSync(execPath, 'utf8')).toBe(NEW_BYTES)
})

test('the dev channel installs the rolling dev-latest build named by its title', async () => {
  const dev = { ...release(DEV_TAG), name: '9.9.9-dev.4+abc1234' }
  expect(await run(github({ api: () => dev }), { channel: 'dev' })).toBe(0)
  expect(calls[0]!.url).toBe(`https://api.github.com/repos/${RELEASE_REPO}/releases/tags/${DEV_TAG}`)
  expect(lines).toEqual([`upgraded ${PACKAGE_VERSION} -> 9.9.9-dev.4+abc1234`])
  expect(readFileSync(execPath, 'utf8')).toBe(NEW_BYTES)
})

test('a dev-latest release without a dev version title is refused', async () => {
  expect(await run(github({ api: () => ({ ...release(DEV_TAG), name: 'dev-latest' }) }), { channel: 'dev' })).toBe(1)
  expect(errors[0]).toContain('not titled with a dev version')
  expect(readFileSync(execPath, 'utf8')).toBe('old jobduck binary')
})

test('a version and a channel together are refused', async () => {
  expect(await run(github(), { version: NEW_VERSION, channel: 'rc' })).toBe(1)
  expect(errors[0]).toContain('not both')
  expect(calls).toHaveLength(0)
})
