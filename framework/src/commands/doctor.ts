import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadPermissions } from '../config/permissions'
import { loadProfile } from '../config/profile'
import { openDb } from '../db/client'
import { currentVersion, loadMigrations, migrate } from '../db/migrate'
import { type HostContext, allHosts } from '../hosts'
import { SKILLS_VERSION_FILE, dbPath, ensureHome, installedSkillsPath, jobduckHome, skillNames } from '../paths'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

export interface DoctorOptions {
  json?: boolean
  workspace?: string
  userHome?: string
  pathEnv?: string
  out?: (line: string) => void
}

const MIN_NODE_MAJOR = 20

function attempt(name: string, fn: () => string): Check {
  try {
    return { name, ok: true, detail: fn() }
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

export function runDoctor(options: DoctorOptions = {}): number {
  const out = options.out ?? ((line: string) => console.log(line))
  const home = jobduckHome()
  const checks: Check[] = []

  const nodeMajor = Number(process.versions.node.split('.')[0])
  checks.push({ name: 'node', ok: nodeMajor >= MIN_NODE_MAJOR, detail: `v${process.versions.node} (need >= ${MIN_NODE_MAJOR})` })

  checks.push(attempt('home', () => {
    ensureHome(home)
    const mode = statSync(home).mode & 0o777
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
    const enabled = Object.entries(loadPermissions().modules).filter(([, on]) => on).map(([name]) => name)
    return `parses; modules enabled: ${enabled.length > 0 ? enabled.join(', ') : 'none'}`
  }))

  checks.push(attempt('profile.md', () => {
    loadProfile()
    return 'parses'
  }))

  checks.push(attempt('skills', () => {
    const dir = installedSkillsPath(home)
    const versionFile = join(dir, SKILLS_VERSION_FILE)
    const names = skillNames()
    const installed = names.filter((name) => existsSync(join(dir, `${name}.md`)))
    if (!existsSync(versionFile)) return `${installed.length} installed (run npx jobduck init to install)`
    const version = readFileSync(versionFile, 'utf8').trim()
    const missing = names.filter((name) => !installed.includes(name))
    if (missing.length > 0) throw new Error(`missing ${missing.join(', ')} (version ${version}); run npx jobduck init`)
    return `${installed.length} installed (version ${version})`
  }))

  const ctx: HostContext = {
    workspace: resolve(options.workspace ?? process.cwd()),
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
    out(JSON.stringify({ ok, home, checks, hosts }, null, 2))
  } else {
    for (const check of checks) out(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`)
    for (const host of hosts) {
      const state = host.registered ? 'registered' : host.detected ? 'detected, not registered' : 'not detected'
      out(`     host ${host.label}: ${state} (${host.config})`)
    }
  }
  return ok ? 0 : 1
}
