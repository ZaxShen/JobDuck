import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from '../package.json'

export const DB_FILE = 'jobduck.db'
export const PROFILE_FILE = 'profile.md'
export const PERMISSIONS_FILE = 'permissions.toml'
export const SKILLS_DIR = 'skills'
export const SKILLS_VERSION_FILE = '.version'
export const PACKAGE_VERSION: string = pkg.version

export function jobduckHome(): string {
  const fromEnv = process.env.JOBDUCK_HOME
  return fromEnv ? resolve(fromEnv) : join(homedir(), '.jobduck')
}

export const dbPath = (home = jobduckHome()) => join(home, DB_FILE)
export const profilePath = (home = jobduckHome()) => join(home, PROFILE_FILE)
export const permissionsPath = (home = jobduckHome()) => join(home, PERMISSIONS_FILE)
export const installedSkillsPath = (home = jobduckHome()) => join(home, SKILLS_DIR)

function findAsset(candidates: string[]): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 4; depth++) {
    for (const candidate of candidates) {
      const path = join(dir, candidate)
      if (existsSync(path) && statSync(path).isDirectory()) return path
    }
    dir = dirname(dir)
  }
  throw new Error(`jobduck asset not found: ${candidates.join(' or ')}`)
}

export const templatesDir = () => findAsset(['templates'])
export const migrationsDir = () => findAsset(['migrations', 'db/migrations'])
export const dashboardDir = () => findAsset(['dashboard/public', 'dashboard'])
export const skillsDir = () => findAsset([SKILLS_DIR])

export function skillNames(): string[] {
  return readdirSync(skillsDir()).filter((file) => file.endsWith('.md')).map((file) => file.slice(0, -3)).sort()
}

export function skillsUpToDate(home = jobduckHome()): boolean {
  const target = installedSkillsPath(home)
  const versionFile = join(target, SKILLS_VERSION_FILE)
  if (!existsSync(versionFile) || readFileSync(versionFile, 'utf8').trim() !== PACKAGE_VERSION) return false
  return skillNames().every((name) => {
    const installed = join(target, `${name}.md`)
    return existsSync(installed) && readFileSync(installed, 'utf8') === readFileSync(join(skillsDir(), `${name}.md`), 'utf8')
  })
}

export function installSkills(home = jobduckHome()): string[] {
  const target = installedSkillsPath(home)
  mkdirSync(target, { recursive: true, mode: 0o700 })
  const written: string[] = []
  for (const name of skillNames()) {
    const path = join(target, `${name}.md`)
    copyFileSync(join(skillsDir(), `${name}.md`), path)
    chmodSync(path, 0o600)
    written.push(path)
  }
  const versionFile = join(target, SKILLS_VERSION_FILE)
  writeFileSync(versionFile, `${PACKAGE_VERSION}\n`, { mode: 0o600 })
  chmodSync(versionFile, 0o600)
  return written
}

export interface EnsureHomeResult {
  home: string
  created: string[]
}

export function ensureHome(home = jobduckHome()): EnsureHomeResult {
  const created: string[] = []
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    chmodSync(home, 0o700)
    created.push(home)
  }
  for (const file of [PROFILE_FILE, PERMISSIONS_FILE]) {
    const target = join(home, file)
    if (existsSync(target)) continue
    copyFileSync(join(templatesDir(), file), target)
    chmodSync(target, 0o600)
    created.push(target)
  }
  return { home, created }
}
