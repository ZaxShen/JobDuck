import { existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { loadPermissions } from '../config/permissions'
import { loadProfile } from '../config/profile'
import { openDb } from '../db/client'
import { currentVersion, loadMigrations, migrate } from '../db/migrate'
import { type HostContext, allHosts, userHomeOf } from '../hosts'
import {
  HOME_DIR, NoHomeError, PACKAGE_VERSION, SKILLS_VERSION_FILE, dbPath, discoverHome, ensureHome, installedSkillsPath, permissionsPath, profilePath,
  resolveWorkspace, skillNames,
} from '../paths'
import { workspaceLine } from './init'

export interface Check {
  name: string
  ok: boolean
  warn?: boolean
  detail: string
}

export interface DoctorOptions {
  json?: boolean
  workspace?: string
  userHome?: string
  pathEnv?: string
  out?: (line: string) => void
}

const EXECUTABLES = ['jobduck', 'jobduck.exe']

function findOnPath(pathEnv: string): string | undefined {
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const name of EXECUTABLES) {
      const candidate = join(dir, name)
      if (!existsSync(candidate)) continue
      const stat = statSync(candidate)
      if (stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0)) return candidate
    }
  }
  return undefined
}

function attempt(name: string, fn: () => string): Check {
  try {
    return { name, ok: true, detail: fn() }
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

export function runDoctor(options: DoctorOptions = {}): number {
  const out = options.out ?? ((line: string) => console.log(line))
  const given = resolve(options.workspace ?? process.cwd())
  const workspace = resolveWorkspace(given, userHomeOf({ userHome: options.userHome }))
  const home = discoverHome(workspace, userHomeOf({ userHome: options.userHome }))
  const checks: Check[] = []

  checks.push({ name: 'runtime', ok: true, detail: `jobduck ${PACKAGE_VERSION} on bun ${Bun.version}` })

  const onPath = findOnPath(options.pathEnv ?? process.env.PATH ?? '')
  checks.push(onPath
    ? { name: 'path', ok: true, detail: `jobduck found at ${onPath}` }
    : { name: 'path', ok: false, detail: 'not on PATH; hosts start the MCP server with `jobduck mcp`' })

  if (home === undefined) {
    checks.push({ name: 'home', ok: false, detail: new NoHomeError(workspace).message })
  } else {
    checks.push(...homeChecks(home))
  }

  const ctx: HostContext = {
    workspace,
    home: home ?? join(workspace, HOME_DIR),
    userHome: options.userHome,
    pathEnv: options.pathEnv,
    dryRun: true,
  }
  const hosts = allHosts().map((host) => ({
    id: host.id,
    label: host.label,
    detected: host.detect(ctx),
    registered: host.isRegistered(ctx),
    config: host.configPath(ctx),
  }))

  const ok = checks.every((check) => check.ok)
  if (options.json) {
    out(JSON.stringify({ ok, home: home ?? null, checks, hosts }, null, 2))
  } else {
    if (workspace !== given) out(workspaceLine(given, workspace))
    for (const check of checks) out(`${check.warn ? 'warn' : check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`)
    for (const host of hosts) {
      const state = host.registered ? 'registered' : host.detected ? 'detected, not registered' : 'not detected'
      out(`     host ${host.label}: ${state} (${host.config})`)
    }
  }
  return ok ? 0 : 1
}

function homeChecks(home: string): Check[] {
  const checks: Check[] = []
  checks.push(attempt('home', () => {
    ensureHome(home)
    const mode = statSync(home).mode & 0o777
    if (process.platform === 'win32') return home
    if (mode & 0o077) throw new Error(`${home} is mode ${mode.toString(8)}; run chmod 700 ${home}`)
    return `${home} (mode ${mode.toString(8)})`
  }))

  checks.push(attempt('database', () => {
    const db = openDb(dbPath(home))
    try {
      migrate(db)
      const version = currentVersion(db)
      const latest = loadMigrations().at(-1)?.version ?? 0
      if (version !== latest) throw new Error(`migration version ${version}, expected ${latest}`)
      return `migration version ${version}`
    } finally {
      db.close()
    }
  }))

  checks.push(attempt('permissions.toml', () => {
    const enabled = Object.entries(loadPermissions(permissionsPath(home)).modules).filter(([, on]) => on).map(([name]) => name)
    return `parses; modules enabled: ${enabled.length > 0 ? enabled.join(', ') : 'none'}`
  }))

  checks.push(attempt('profile.md', () => {
    loadProfile(profilePath(home))
    return 'parses'
  }))

  checks.push(attempt('skills', () => {
    const dir = installedSkillsPath(home)
    const versionFile = join(dir, SKILLS_VERSION_FILE)
    const names = skillNames()
    const installed = names.filter((name) => existsSync(join(dir, `${name}.md`)))
    if (!existsSync(versionFile)) return `${installed.length} installed (run jobduck init to install)`
    const version = readFileSync(versionFile, 'utf8').trim()
    const missing = names.filter((name) => !installed.includes(name))
    if (missing.length > 0) throw new Error(`missing ${missing.join(', ')} (version ${version}); run jobduck init`)
    return `${installed.length} installed (version ${version})`
  }))
  const skills = checks.at(-1)!
  const stamped = join(installedSkillsPath(home), SKILLS_VERSION_FILE)
  const installedVersion = existsSync(stamped) ? readFileSync(stamped, 'utf8').trim() : null
  if (skills.ok && installedVersion !== null && installedVersion !== PACKAGE_VERSION) {
    skills.warn = true
    skills.detail = `version ${installedVersion} installed, jobduck is ${PACKAGE_VERSION}; run jobduck init to refresh them`
  }
  return checks
}
