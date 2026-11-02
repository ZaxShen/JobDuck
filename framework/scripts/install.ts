// Install the jobduck binary from GitHub Releases into a user directory (no root needed).
// macOS/Linux: curl -fsSL https://raw.githubusercontent.com/ZaxShen/JobDuck/main/framework/scripts/install.ts | bun run -
// Windows:     irm https://raw.githubusercontent.com/ZaxShen/JobDuck/main/framework/scripts/install.ts | bun run -
// Env: JOBDUCK_VERSION (default: latest release), JOBDUCK_CHANNEL (stable, rc or dev; default: stable),
//      JOBDUCK_INSTALL_DIR (default: ~/.local/bin)
// Self-contained on purpose: a piped script cannot resolve relative imports.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

export const REPO = 'ZaxShen/JobDuck'
const RELEASES = `https://github.com/${REPO}/releases`
const CHECKSUMS = 'SHA256SUMS'
const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: 'darwin', linux: 'linux', win32: 'windows' }
const TARGETS = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-x64'])

type Fetch = (url: string) => Promise<Response>

export class InstallError extends Error {}

export interface Source {
  base: string
  label: string
}

export interface InstallOptions {
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  arch?: string
  fetch?: Fetch
  home?: string
  tempRoot?: string
  out?: (line: string) => void
  versionOf?: (binary: string) => string
}

export function assetName(platform: NodeJS.Platform, arch: string): string {
  const os = OS_NAMES[platform]
  if (!os || !TARGETS.has(`${os}-${arch}`)) {
    throw new InstallError(`no jobduck build for ${platform}-${arch}; builds exist for ${[...TARGETS].join(', ')}`)
  }
  return `jobduck-${os}-${arch}${os === 'windows' ? '.exe' : ''}`
}

export function binaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'jobduck.exe' : 'jobduck'
}

export function expectedChecksum(sums: string, name: string): string | undefined {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+?)\s*$/.exec(line)
    if (match && match[2] === name) return match[1]!.toLowerCase()
  }
  return undefined
}

export function newestReleaseTag(feed: string): string | undefined {
  for (const match of feed.matchAll(/releases\/tag\/(v[^"]*)/g)) {
    if (!match[1]!.includes('-dev')) return match[1]
  }
  return undefined
}

async function download(fetch: Fetch, url: string): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url)
  } catch (error) {
    throw new InstallError(`download failed: ${url} (${error instanceof Error ? error.message : String(error)})`)
  }
  if (!res.ok) throw new InstallError(`download failed: ${url} (HTTP ${res.status})`)
  return res
}

export async function resolveSource(env: Record<string, string | undefined>, fetch: Fetch): Promise<Source> {
  const version = (env.JOBDUCK_VERSION ?? '').replace(/^v/, '')
  if (version) return { base: `${RELEASES}/download/v${version}`, label: version }
  const channel = env.JOBDUCK_CHANNEL || 'stable'
  if (channel === 'stable') return { base: `${RELEASES}/latest/download`, label: '(latest)' }
  if (channel === 'dev') return { base: `${RELEASES}/download/dev-latest`, label: '(rolling dev build)' }
  if (channel === 'rc') {
    let feed: string
    try {
      feed = await (await download(fetch, `${RELEASES}.atom`)).text()
    } catch {
      throw new InstallError(`could not read ${RELEASES}.atom`)
    }
    const tag = newestReleaseTag(feed)
    if (!tag) throw new InstallError('no stable or rc release found')
    return { base: `${RELEASES}/download/${tag}`, label: `${tag.replace(/^v/, '')} (newest release, rc channel)` }
  }
  throw new InstallError(`JOBDUCK_CHANNEL must be stable, rc or dev, not ${channel}`)
}

export function onPath(dir: string, pathEnv: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string) => {
    const trimmed = p.replace(/[\\/]+$/, '')
    return platform === 'win32' ? trimmed.toLowerCase() : trimmed
  }
  const sep = platform === process.platform ? delimiter : platform === 'win32' ? ';' : ':'
  return pathEnv.split(sep).some((entry) => entry && norm(entry) === norm(dir))
}

export function pathHint(dir: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    return [
      `${dir} is not on your PATH. Add it from PowerShell, then open a new terminal:`,
      `  [Environment]::SetEnvironmentVariable('Path', "${dir};" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')`,
    ]
  }
  return [`${dir} is not on your PATH. Add it to your shell profile:`, `  export PATH="${dir}:$PATH"`]
}

function place(source: string, dest: string, platform: NodeJS.Platform): void {
  if (platform === 'win32' && existsSync(dest)) {
    const old = `${dest}.old`
    rmSync(old, { force: true })
    renameSync(dest, old)
  }
  try {
    renameSync(source, dest)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    copyFileSync(source, dest)
    unlinkSync(source)
  }
  if (platform !== 'win32') chmodSync(dest, 0o755)
}

function installedVersion(binary: string): string {
  const run = spawnSync(binary, ['--version'], { encoding: 'utf8' })
  if (run.status !== 0) throw new InstallError(`${binary} --version failed: ${(run.stderr || run.error?.message || '').trim()}`)
  return run.stdout.trim()
}

export async function install(options: InstallOptions = {}): Promise<string> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const fetch = options.fetch ?? ((url: string) => globalThis.fetch(url))
  const out = options.out ?? ((line: string) => console.log(line))

  const asset = assetName(platform, options.arch ?? process.arch)
  const source = await resolveSource(env, fetch)
  const dir = resolve(env.JOBDUCK_INSTALL_DIR || join(options.home ?? homedir(), '.local', 'bin'))
  const dest = join(dir, binaryName(platform))

  const tmp = mkdtempSync(join(options.tempRoot ?? tmpdir(), 'jobduck-install-'))
  try {
    out(`Downloading ${asset} ${source.label}`)
    const bytes = new Uint8Array(await (await download(fetch, `${source.base}/${asset}`)).arrayBuffer())
    const sums = await (await download(fetch, `${source.base}/${CHECKSUMS}`)).text()
    const expected = expectedChecksum(sums, asset)
    if (!expected) throw new InstallError(`${CHECKSUMS} has no line for ${asset}`)
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expected) {
      throw new InstallError(`checksum mismatch for ${asset} (expected ${expected}, got ${actual}); not installing`)
    }

    const staged = join(tmp, asset)
    writeFileSync(staged, bytes, { mode: 0o755 })
    mkdirSync(dir, { recursive: true })
    place(staged, dest, platform)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  out(`Installed ${(options.versionOf ?? installedVersion)(dest)} to ${dest}`)
  if (!onPath(dir, env.PATH ?? env.Path ?? '', platform)) {
    out('')
    for (const line of pathHint(dir, platform)) out(line)
  }
  out('')
  out('Next: mkdir ~/JobDuck && cd ~/JobDuck && jobduck init')
  return dest
}

if (import.meta.main) {
  try {
    await install()
  } catch (error) {
    console.error(`jobduck install: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
