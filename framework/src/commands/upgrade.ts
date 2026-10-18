import { createHash } from 'node:crypto'
import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { PACKAGE_VERSION } from '../paths'
import type { FetchLike } from '../sync/client'

export const RELEASE_REPO = 'ZaxShen/JobDuck'
export const CHECKSUMS_ASSET = 'SHA256SUMS'
export const DEV_TAG = 'dev-latest'
export const CHANNELS = ['stable', 'rc', 'dev'] as const
export type Channel = typeof CHANNELS[number]

const MAX_REDIRECTS = 5
const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: 'darwin', linux: 'linux', win32: 'windows' }
const ARCHES = new Set(['arm64', 'x64'])

export interface UpgradeOptions {
  version?: string
  channel?: Channel
  check?: boolean
  fetch?: FetchLike
  execPath?: string
  platform?: NodeJS.Platform
  arch?: string
  out?: (line: string) => void
  err?: (line: string) => void
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
}

interface Release {
  tag_name: string
  name?: string | null
  draft?: boolean
  assets: ReleaseAsset[]
}

interface Version {
  core: [number, number, number]
  pre: string[]
}

class UpgradeError extends Error {}

export function parseVersion(text: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim())
  if (!match) return undefined
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] }
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) throw new UpgradeError(`cannot compare versions ${a} and ${b}`)
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i]! - right.core[i]!
  }
  if (!left.pre.length || !right.pre.length) return right.pre.length - left.pre.length
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (x === y) continue
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) return Number(x) - Number(y)
    if (xNum !== yNum) return xNum ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

export function channelOf(version: string): Channel {
  const pre = parseVersion(version)?.pre ?? []
  if (pre[0] === 'dev') return 'dev'
  return pre.length ? 'rc' : 'stable'
}

export function assetName(platform: NodeJS.Platform, arch: string): string {
  const os = OS_NAMES[platform]
  if (!os || !ARCHES.has(arch)) throw new UpgradeError(`no jobduck release for ${platform}-${arch}`)
  return `jobduck-${os}-${arch}${os === 'windows' ? '.exe' : ''}`
}

export function isGithubHost(url: URL): boolean {
  const host = url.hostname.toLowerCase()
  return url.protocol === 'https:' && (
    host === 'github.com' || host.endsWith('.github.com') || host.endsWith('.githubusercontent.com')
  )
}

async function request(fetch: FetchLike, url: string, headers: Record<string, string>): Promise<Response> {
  let current = new URL(url)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isGithubHost(current)) throw new UpgradeError(`refusing to fetch from ${current.hostname}`)
    const res = await fetch(current.toString(), { headers, redirect: 'manual' })
    if (res.status < 300 || res.status >= 400) return res
    const location = res.headers.get('location')
    if (!location) throw new UpgradeError(`redirect without a location from ${current.hostname}`)
    current = new URL(location, current)
  }
  throw new UpgradeError('too many redirects')
}

async function fetchOk(fetch: FetchLike, url: string, headers: Record<string, string>, what: string): Promise<Response> {
  const res = await request(fetch, url, headers)
  if (!res.ok) throw new UpgradeError(`${what}: HTTP ${res.status}`)
  return res
}

function toRelease(raw: unknown): Release {
  const release = raw as Partial<Release>
  if (typeof release?.tag_name !== 'string' || !Array.isArray(release.assets)) {
    throw new UpgradeError('release response is missing tag_name or assets')
  }
  return { tag_name: release.tag_name, name: release.name, draft: release.draft, assets: release.assets }
}

async function getReleases(fetch: FetchLike, path: string, userAgent: string, what: string): Promise<unknown> {
  const res = await fetchOk(fetch, `https://api.github.com/repos/${RELEASE_REPO}/${path}`, {
    Accept: 'application/vnd.github+json',
    'User-Agent': userAgent,
  }, what)
  return res.json()
}

async function findRelease(
  fetch: FetchLike, version: string | undefined, channel: Channel, userAgent: string,
): Promise<{ release: Release; version: string }> {
  if (version) {
    const tag = `v${version.replace(/^v/, '')}`
    const release = toRelease(await getReleases(fetch, `releases/tags/${tag}`, userAgent, `release ${tag}`))
    return { release, version: release.tag_name.replace(/^v/, '') }
  }
  if (channel === 'stable') {
    const release = toRelease(await getReleases(fetch, 'releases/latest', userAgent, 'latest release'))
    return { release, version: release.tag_name.replace(/^v/, '') }
  }
  if (channel === 'dev') {
    const release = toRelease(await getReleases(fetch, `releases/tags/${DEV_TAG}`, userAgent, 'dev build'))
    const name = release.name?.trim() ?? ''
    if (channelOf(name) !== 'dev') throw new UpgradeError(`the ${DEV_TAG} release is not titled with a dev version`)
    return { release, version: name }
  }
  const list = await getReleases(fetch, 'releases?per_page=30', userAgent, 'release list')
  if (!Array.isArray(list)) throw new UpgradeError('release list response is not a list')
  let best: { release: Release; version: string } | undefined
  for (const raw of list) {
    const release = toRelease(raw)
    const candidate = release.tag_name.replace(/^v/, '')
    if (release.draft || !parseVersion(candidate) || channelOf(candidate) === 'dev') continue
    if (!best || compareVersions(candidate, best.version) > 0) best = { release, version: candidate }
  }
  if (!best) throw new UpgradeError('no stable or rc release found')
  return best
}

export function expectedChecksum(sums: string, name: string): string | undefined {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (match && match[2] === name) return match[1]!.toLowerCase()
  }
  return undefined
}

function defaultExecPath(): string {
  const path = process.execPath
  if (!/^jobduck(\.exe)?$/i.test(basename(path)) && !/^jobduck-/.test(basename(path))) {
    throw new UpgradeError(`upgrade replaces the installed jobduck binary; this process runs under ${path}`)
  }
  return path
}

function swap(execPath: string, bytes: Uint8Array, platform: NodeJS.Platform): void {
  const next = `${execPath}.new`
  writeFileSync(next, bytes, { mode: 0o755 })
  chmodSync(next, 0o755)
  try {
    if (platform === 'win32') {
      const old = `${execPath}.old`
      rmSync(old, { force: true })
      if (existsSync(execPath)) renameSync(execPath, old)
    }
    renameSync(next, execPath)
  } catch (error) {
    rmSync(next, { force: true })
    throw error
  }
}

export async function runUpgrade(options: UpgradeOptions = {}): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line))
  const err = options.err ?? ((line: string) => console.error(line))
  const fetch = options.fetch ?? globalThis.fetch
  const platform = options.platform ?? process.platform
  const userAgent = `jobduck/${PACKAGE_VERSION}`

  try {
    if (options.version && options.channel) throw new UpgradeError('give a version or --channel, not both')
    const current = channelOf(PACKAGE_VERSION)
    const channel = options.channel ?? current
    const { release, version: target } = await findRelease(fetch, options.version, channel, userAgent)
    if (options.check) {
      out(`current ${PACKAGE_VERSION}`)
      out(`${options.version ? 'requested' : 'latest'} ${target}`)
      if (!options.version) out(`channel ${channel}`)
      return 0
    }
    if (target === PACKAGE_VERSION) {
      out(`already up to date (${PACKAGE_VERSION})`)
      return 0
    }
    const newer = compareVersions(target, PACKAGE_VERSION) > 0
    if (!options.version && channel === current && channel !== 'dev' && !newer) {
      out(`current ${PACKAGE_VERSION} is newer than the latest ${channel} release ${target}; \`jobduck upgrade ${target}\` installs it anyway`)
      return 0
    }

    const name = assetName(platform, options.arch ?? process.arch)
    const execPath = options.execPath ?? defaultExecPath()
    const binary = release.assets.find((asset) => asset.name === name)
    const sumsAsset = release.assets.find((asset) => asset.name === CHECKSUMS_ASSET)
    if (!binary) throw new UpgradeError(`release ${release.tag_name} has no ${name}`)
    if (!sumsAsset) throw new UpgradeError(`release ${release.tag_name} has no ${CHECKSUMS_ASSET}`)

    const headers = { Accept: 'application/octet-stream', 'User-Agent': userAgent }
    const sums = await (await fetchOk(fetch, sumsAsset.browser_download_url, headers, CHECKSUMS_ASSET)).text()
    const expected = expectedChecksum(sums, name)
    if (!expected) throw new UpgradeError(`${CHECKSUMS_ASSET} has no line for ${name}; refusing to upgrade`)

    const bytes = new Uint8Array(await (await fetchOk(fetch, binary.browser_download_url, headers, name)).arrayBuffer())
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expected) {
      throw new UpgradeError(`checksum mismatch for ${name} (expected ${expected}, got ${actual}); refusing to upgrade`)
    }

    swap(execPath, bytes, platform)
    out(`${newer ? 'upgraded' : 'downgraded'} ${PACKAGE_VERSION} -> ${target}`)
    return 0
  } catch (error) {
    err(`upgrade failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
