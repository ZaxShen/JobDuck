import { createHash } from 'node:crypto'
import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { PACKAGE_VERSION } from '../paths'
import type { FetchLike } from '../sync/client'

export const RELEASE_REPO = 'ZaxShen/JobDuck'
export const CHECKSUMS_ASSET = 'SHA256SUMS'

const MAX_REDIRECTS = 5
const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: 'darwin', linux: 'linux', win32: 'windows' }
const ARCHES = new Set(['arm64', 'x64'])

export interface UpgradeOptions {
  version?: string
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
  assets: ReleaseAsset[]
}

class UpgradeError extends Error {}

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

async function fetchRelease(fetch: FetchLike, version: string | undefined, userAgent: string): Promise<Release> {
  const path = version ? `releases/tags/v${version.replace(/^v/, '')}` : 'releases/latest'
  const res = await fetchOk(fetch, `https://api.github.com/repos/${RELEASE_REPO}/${path}`, {
    Accept: 'application/vnd.github+json',
    'User-Agent': userAgent,
  }, version ? `release v${version.replace(/^v/, '')}` : 'latest release')
  const release = await res.json() as Partial<Release>
  if (typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) {
    throw new UpgradeError('release response is missing tag_name or assets')
  }
  return { tag_name: release.tag_name, assets: release.assets }
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
    const release = await fetchRelease(fetch, options.version, userAgent)
    const latest = release.tag_name.replace(/^v/, '')
    if (options.check) {
      out(`current ${PACKAGE_VERSION}`)
      out(`${options.version ? 'requested' : 'latest'} ${latest}`)
      return 0
    }
    if (latest === PACKAGE_VERSION) {
      out(`already up to date (${PACKAGE_VERSION})`)
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
    out(`upgraded ${PACKAGE_VERSION} -> ${latest}`)
    return 0
  } catch (error) {
    err(`upgrade failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
