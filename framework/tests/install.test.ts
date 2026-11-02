import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assetName, binaryName, expectedChecksum, install, newestReleaseTag, onPath, pathHint, resolveSource,
} from '../scripts/install'

const RELEASES = 'https://github.com/ZaxShen/JobDuck/releases'
const HASH = 'a'.repeat(64)
const noNetwork = async (url: string): Promise<Response> => {
  throw new Error(`unexpected fetch ${url}`)
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jobduck-install-test-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('asset names cover every release target', () => {
  expect(assetName('darwin', 'arm64')).toBe('jobduck-darwin-arm64')
  expect(assetName('darwin', 'x64')).toBe('jobduck-darwin-x64')
  expect(assetName('linux', 'arm64')).toBe('jobduck-linux-arm64')
  expect(assetName('linux', 'x64')).toBe('jobduck-linux-x64')
  expect(assetName('win32', 'x64')).toBe('jobduck-windows-x64.exe')
  expect(binaryName('win32')).toBe('jobduck.exe')
  expect(binaryName('linux')).toBe('jobduck')
})

test('an unsupported platform or CPU is refused', () => {
  expect(() => assetName('freebsd', 'x64')).toThrow('no jobduck build for freebsd-x64')
  expect(() => assetName('linux', 'ia32')).toThrow('no jobduck build for linux-ia32')
  expect(() => assetName('win32', 'arm64')).toThrow('no jobduck build for win32-arm64')
})

test('SHA256SUMS lines parse with either separator', () => {
  const sums = `${HASH}  jobduck-linux-x64\n${'B'.repeat(64)} *jobduck-windows-x64.exe\r\n`
  expect(expectedChecksum(sums, 'jobduck-linux-x64')).toBe(HASH)
  expect(expectedChecksum(sums, 'jobduck-windows-x64.exe')).toBe('b'.repeat(64))
  expect(expectedChecksum(sums, 'jobduck-darwin-arm64')).toBeUndefined()
  expect(expectedChecksum(sums, 'jobduck-linux')).toBeUndefined()
})

test('a pinned version wins over the channel and drops a leading v', async () => {
  const source = await resolveSource({ JOBDUCK_VERSION: 'v0.1.0', JOBDUCK_CHANNEL: 'dev' }, noNetwork)
  expect(source.base).toBe(`${RELEASES}/download/v0.1.0`)
})

test('stable and dev channels map to fixed download bases', async () => {
  expect((await resolveSource({}, noNetwork)).base).toBe(`${RELEASES}/latest/download`)
  expect((await resolveSource({ JOBDUCK_CHANNEL: 'stable' }, noNetwork)).base).toBe(`${RELEASES}/latest/download`)
  expect((await resolveSource({ JOBDUCK_CHANNEL: 'dev' }, noNetwork)).base).toBe(`${RELEASES}/download/dev-latest`)
})

test('the rc channel takes the newest non-dev tag from the atom feed', async () => {
  const feed = [
    '<link href="https://github.com/ZaxShen/JobDuck/releases/tag/dev-latest"/>',
    '<link href="https://github.com/ZaxShen/JobDuck/releases/tag/v0.3.0-dev.4.gh40"/>',
    '<link href="https://github.com/ZaxShen/JobDuck/releases/tag/v0.2.0-rc.2"/>',
    '<link href="https://github.com/ZaxShen/JobDuck/releases/tag/v0.1.0"/>',
  ].join('\n')
  const seen: string[] = []
  const source = await resolveSource({ JOBDUCK_CHANNEL: 'rc' }, async (url) => {
    seen.push(url)
    return new Response(feed)
  })
  expect(seen).toEqual([`${RELEASES}.atom`])
  expect(source.base).toBe(`${RELEASES}/download/v0.2.0-rc.2`)
  expect(source.label).toContain('0.2.0-rc.2')
  expect(newestReleaseTag('<feed></feed>')).toBeUndefined()
  await expect(resolveSource({ JOBDUCK_CHANNEL: 'rc' }, async () => new Response('<feed/>')))
    .rejects.toThrow('no stable or rc release found')
  await expect(resolveSource({ JOBDUCK_CHANNEL: 'rc' }, async () => new Response('', { status: 500 })))
    .rejects.toThrow(`could not read ${RELEASES}.atom`)
})

test('an unknown channel is refused', async () => {
  await expect(resolveSource({ JOBDUCK_CHANNEL: 'nightly' }, noNetwork))
    .rejects.toThrow('JOBDUCK_CHANNEL must be stable, rc or dev, not nightly')
})

test('PATH membership and hints follow the platform', () => {
  expect(onPath('C:\\Users\\me\\.local\\bin', 'C:\\Windows;c:\\users\\ME\\.local\\bin\\', 'win32')).toBe(true)
  expect(onPath('/home/me/.local/bin', '/usr/bin:/home/me/.local/bin', 'linux')).toBe(true)
  expect(onPath('/home/me/.local/bin', '/usr/bin:/home/ME/.local/bin', 'linux')).toBe(false)
  expect(pathHint('/home/me/.local/bin', 'linux')[1]).toBe('  export PATH="/home/me/.local/bin:$PATH"')
  expect(pathHint('C:\\bin', 'win32')[1]).toContain("[Environment]::SetEnvironmentVariable('Path', \"C:\\bin;\"")
})

test('a checksum mismatch refuses to write into the install dir', async () => {
  const dir = join(root, 'bin')
  const bytes = new TextEncoder().encode('not the real binary')
  const fetched: string[] = []
  const fetch = async (url: string) => {
    fetched.push(url)
    if (url.endsWith('/SHA256SUMS')) return new Response(`${HASH}  jobduck-linux-x64\n`)
    return new Response(bytes)
  }
  await expect(install({
    env: { JOBDUCK_INSTALL_DIR: dir, PATH: '' }, platform: 'linux', arch: 'x64', fetch, out: () => {},
    tempRoot: root, versionOf: () => 'jobduck 0.0.0',
  })).rejects.toThrow('checksum mismatch for jobduck-linux-x64')
  expect(fetched).toEqual([`${RELEASES}/latest/download/jobduck-linux-x64`, `${RELEASES}/latest/download/SHA256SUMS`])
  expect(existsSync(dir)).toBe(false)
  expect(readdirSync(root)).toEqual([])
})

test('a verified download lands in the install dir with a PATH hint', async () => {
  const dir = join(root, 'bin')
  const bytes = new TextEncoder().encode('binary')
  const sum = createHash('sha256').update(bytes).digest('hex')
  const lines: string[] = []
  const dest = await install({
    env: { JOBDUCK_INSTALL_DIR: dir, PATH: '/usr/bin' }, platform: 'linux', arch: 'x64', out: (line) => lines.push(line), tempRoot: root,
    fetch: async (url) => new Response(url.endsWith('/SHA256SUMS') ? `${sum} *jobduck-linux-x64\n` : bytes),
    versionOf: () => '0.2.0',
  })
  expect(dest).toBe(join(dir, 'jobduck'))
  expect(await Bun.file(dest).text()).toBe('binary')
  expect(lines[0]).toBe('Downloading jobduck-linux-x64 (latest)')
  expect(lines[1]).toBe(`Installed 0.2.0 to ${dest}`)
  expect(lines).toContain(`${dir} is not on your PATH. Add it to your shell profile:`)
  expect(lines.at(-1)).toBe('Next: mkdir ~/JobDuck && cd ~/JobDuck && jobduck init')
})
