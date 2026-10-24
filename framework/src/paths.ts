import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import pkg from '../package.json'
import { SKILLS, TEMPLATES } from './assets'

export const HOME_DIR = '.jobduck'
export const DB_FILE = 'jobduck.db'
export const PROFILE_FILE = 'profile.md'
export const PERMISSIONS_FILE = 'permissions.toml'
export const SKILLS_DIR = 'skills'
export const SKILLS_VERSION_FILE = '.version'
export const DASHBOARD_STATE_FILE = 'dashboard.json'
export const PACKAGE_VERSION: string = pkg.version

export const defaultHome = (userHome = homedir()) => join(resolve(userHome), HOME_DIR)

export function isMarkedHome(dir: string): boolean {
  return [DB_FILE, PERMISSIONS_FILE].some((file) => existsSync(join(dir, file)))
}

export function findHome(start: string): string | undefined {
  let dir = resolve(start)
  while (true) {
    const candidate = join(dir, HOME_DIR)
    if (isMarkedHome(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export function jobduckHome(start = process.cwd(), userHome = homedir()): string {
  const fromEnv = process.env.JOBDUCK_HOME
  if (fromEnv) return resolve(fromEnv)
  return findHome(start) ?? defaultHome(userHome)
}

export const dbPath = (home = jobduckHome()) => join(home, DB_FILE)
export const profilePath = (home = jobduckHome()) => join(home, PROFILE_FILE)
export const permissionsPath = (home = jobduckHome()) => join(home, PERMISSIONS_FILE)
export const installedSkillsPath = (home = jobduckHome()) => join(home, SKILLS_DIR)
export const dashboardStatePath = (home = jobduckHome()) => join(home, DASHBOARD_STATE_FILE)

export function skillNames(): string[] {
  return Object.keys(SKILLS).sort()
}

export function skillsUpToDate(home = jobduckHome()): boolean {
  const target = installedSkillsPath(home)
  const versionFile = join(target, SKILLS_VERSION_FILE)
  if (!existsSync(versionFile) || readFileSync(versionFile, 'utf8').trim() !== PACKAGE_VERSION) return false
  return skillNames().every((name) => {
    const installed = join(target, `${name}.md`)
    return existsSync(installed) && readFileSync(installed, 'utf8') === SKILLS[name]
  })
}

export function installSkills(home = jobduckHome()): string[] {
  const target = installedSkillsPath(home)
  mkdirSync(target, { recursive: true, mode: 0o700 })
  const written: string[] = []
  for (const name of skillNames()) {
    const path = join(target, `${name}.md`)
    writeFileSync(path, SKILLS[name]!, { mode: 0o600 })
    chmodSync(path, 0o600)
    written.push(path)
  }
  const versionFile = join(target, SKILLS_VERSION_FILE)
  writeFileSync(versionFile, `${PACKAGE_VERSION}\n`, { mode: 0o600 })
  chmodSync(versionFile, 0o600)
  return written
}

export function refreshStaleSkills(home = jobduckHome()): boolean {
  if (!existsSync(home) || skillsUpToDate(home)) return false
  installSkills(home)
  return true
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
    writeFileSync(target, TEMPLATES[file]!, { mode: 0o600 })
    chmodSync(target, 0o600)
    created.push(target)
  }
  return { home, created }
}
