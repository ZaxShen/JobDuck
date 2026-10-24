import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { DashboardView } from '../dashboard/server'
import { openDb } from '../db/client'
import { migrate, pendingMigrations } from '../db/migrate'
import {
  type FileChange, type Host, type HostContext, allHosts, hostById, isWorkspaceLocal, userHomeOf,
} from '../hosts'
import {
  HOME_DIR, PACKAGE_VERSION, PERMISSIONS_FILE, PROFILE_FILE, dbPath, defaultHome, ensureHome, findHome, installSkills,
  installedSkillsPath, isMarkedHome, jobduckHome, resolveWorkspace, skillNames, skillsUpToDate,
} from '../paths'
import { launchDashboard } from './dashboard'

export interface InitOptions {
  workspace?: string
  home?: string
  hosts?: string[]
  dryRun?: boolean
  diff?: boolean
  yes?: boolean
  userHome?: string
  pathEnv?: string
  isTTY?: boolean
  dashboard?: boolean
  launchDashboard?: (options: { view: DashboardView; workspace: string; home: string }) => Promise<string>
  out?: (line: string) => void
  confirm?: (question: string) => Promise<boolean>
}

type Verb = 'create' | 'update'
const PAST: Record<Verb, string> = { create: 'created', update: 'updated' }

async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim())
  } finally {
    rl.close()
  }
}

export function selectHosts(ctx: HostContext, names?: string[]): Host[] {
  if (names && names.length > 0) return [...new Set(names)].map(hostById)
  return allHosts().filter((host) => host.detect(ctx))
}

function dedupe(changes: FileChange[]): FileChange[] {
  const seen = new Set<string>()
  return changes.filter((change) => !seen.has(change.path) && seen.add(change.path))
}

const slashes = (path: string) => path.split(sep).join('/')

export function shortPath(path: string, ctx: HostContext): string {
  const workspace = ctx.workspace.endsWith(sep) ? ctx.workspace : `${ctx.workspace}${sep}`
  if (path.startsWith(workspace)) return slashes(path.slice(workspace.length))
  const home = resolve(userHomeOf(ctx))
  if (path === home) return '~'
  const homePrefix = home.endsWith(sep) ? home : `${home}${sep}`
  if (path.startsWith(homePrefix)) return `~/${slashes(path.slice(homePrefix.length))}`
  return path
}

function verbOf(change: FileChange): Verb {
  return change.before === null ? 'create' : 'update'
}

export function planLines(changes: FileChange[], ctx: HostContext, tense: 'present' | 'past' = 'present'): string[] {
  const pointer = new RegExp(`^(.*)[\\\\/]jobduck-(?:${skillNames().join('|')})[\\\\/]SKILL\\.md$`)
  const entries: Array<{ verb: Verb; label: string; count: number }> = []
  const groups = new Map<string, number>()
  for (const change of changes) {
    const dir = pointer.exec(change.path)?.[1]
    if (dir === undefined) {
      entries.push({ verb: verbOf(change), label: shortPath(change.path, ctx), count: 1 })
      continue
    }
    const index = groups.get(dir)
    if (index === undefined) {
      groups.set(dir, entries.length)
      entries.push({ verb: verbOf(change), label: `${shortPath(dir, ctx)}/jobduck-*/SKILL.md`, count: 1 })
    } else {
      const entry = entries[index]!
      entry.count++
      if (entry.verb !== verbOf(change)) entry.verb = 'update'
    }
  }
  return entries.map(({ verb, label, count }) => {
    const word = tense === 'past' ? PAST[verb] : verb
    return count > 1 ? `${word} ${label} (${count} skill pointers)` : `${word} ${label}`
  })
}

const GITIGNORE = '.gitignore'

function homePlan(home: string, local: boolean, show: (path: string) => string): string[] {
  const steps: string[] = []
  if (!existsSync(home)) steps.push(`create ${show(home)} (mode 0700)`)
  if (local && !existsSync(resolve(home, GITIGNORE))) steps.push(`create ${show(resolve(home, GITIGNORE))} so git ignores the home`)
  const templates = [PROFILE_FILE, PERMISSIONS_FILE].filter((file) => !existsSync(resolve(home, file)))
  if (templates.length > 0) {
    steps.push(`create ${templates.map((file) => show(resolve(home, file))).join(' and ')} from templates`)
  }
  if (!skillsUpToDate(home)) {
    steps.push(`install ${skillNames().length} skills (version ${PACKAGE_VERSION}) to ${show(installedSkillsPath(home))}`)
  }
  const db = dbPath(home)
  if (!existsSync(db)) {
    steps.push(`create ${show(db)} and apply migrations ${pendingMigrations(null).map((m) => m.version).join(', ')}`)
  } else {
    const conn = openDb(db, { readonly: true })
    try {
      const pending = pendingMigrations(conn)
      if (pending.length > 0) steps.push(`apply migrations ${pending.map((m) => m.version).join(', ')} to ${show(db)}`)
    } finally {
      conn.close()
    }
  }
  return steps
}

export const WORKSPACE_FOLDERS = ['inbox', 'cv', 'cover-letters'] as const
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle']

type WorkspaceContext = Pick<HostContext, 'workspace' | 'userHome'>

export function isDedicatedWorkspace(ctx: WorkspaceContext): boolean {
  if (resolve(ctx.workspace) === resolve(userHomeOf(ctx))) return false
  return !PROJECT_MARKERS.some((marker) => existsSync(join(ctx.workspace, marker)))
}

function missingFolders(ctx: HostContext): string[] {
  if (!isDedicatedWorkspace(ctx)) return []
  return WORKSPACE_FOLDERS.filter((folder) => !existsSync(join(ctx.workspace, folder)))
}

export function chooseHome(ctx: WorkspaceContext, flag?: string): string {
  if (flag) return resolve(ctx.workspace, flag)
  if (process.env.JOBDUCK_HOME) return resolve(process.env.JOBDUCK_HOME)
  const found = findHome(ctx.workspace)
  if (found) return found
  const fallback = defaultHome(userHomeOf(ctx))
  if (isMarkedHome(fallback)) return fallback
  return isDedicatedWorkspace(ctx) ? join(resolve(ctx.workspace), HOME_DIR) : fallback
}

export const workspaceLine = (given: string, workspace: string) =>
  `Workspace: ${workspace}${workspace === given ? '' : ` (holds ${HOME_DIR}/)`}`

export const CODEX_TRUST_NOTE = 'Codex reads .codex/config.toml only in trusted projects: trust this folder when Codex asks.'

export const DEDICATED_TIP = [
  'Tip: Job Duck works best in a folder of its own, where your CVs, cover letters, imports and the',
  "agent's notes stay together. This folder looks like a code project or your home folder, so no",
  'document folders were created here. For example: mkdir ~/JobDuck && cd ~/JobDuck && jobduck init',
]

export async function runInit(options: InitOptions = {}): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line))
  const given = resolve(options.workspace ?? process.cwd())
  const workspace = resolveWorkspace(given, userHomeOf({ userHome: options.userHome }))
  const home = chooseHome({ workspace: given, userHome: options.userHome }, options.home)
  const ctx: HostContext = { workspace, home, userHome: options.userHome, pathEnv: options.pathEnv, dryRun: true }
  const local = isWorkspaceLocal(ctx)
  const show = (path: string) => shortPath(path, ctx)
  const hosts = selectHosts(ctx, options.hosts)
  const folders = missingFolders(ctx)
  const steps = homePlan(home, local, show)
  if (folders.length > 0) steps.push(`create ${folders.map((folder) => `${folder}/`).join(', ')} for your documents`)
  const changes = dedupe(hosts.flatMap((host) => host.register(ctx)))

  out(`Job Duck home: ${show(home)}`)
  out(workspaceLine(given, workspace))
  out(`Hosts: ${hosts.length > 0 ? hosts.map((host) => host.label).join(', ') : 'none detected (use --hosts)'}`)
  if (steps.length === 0 && changes.length === 0) {
    out('Nothing to do.')
  } else {
    out('')
    for (const step of steps) out(`- ${step}`)
    for (const line of planLines(changes, ctx)) out(`- ${line}`)
    out('')
    if (options.diff) {
      for (const change of changes) out(change.diff)
    } else if (changes.length > 0) {
      out('Pass --diff to see every change in full.')
    }
  }
  if (!isDedicatedWorkspace(ctx)) for (const line of DEDICATED_TIP) out(line)

  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)
  if (options.dryRun) {
    out('Dry run: nothing written.')
    return 0
  }
  if (!options.yes) {
    if (!isTTY) {
      out('Not a terminal: pass --yes to apply or --dry-run to preview.')
      return 1
    }
    if (!(await (options.confirm ?? promptYesNo)('Apply these changes?'))) {
      out('Aborted.')
      return 1
    }
  }

  const { created } = ensureHome(home)
  const gitignore = join(home, GITIGNORE)
  if (local && !existsSync(gitignore)) {
    writeFileSync(gitignore, '*\n', { mode: 0o600 })
    chmodSync(gitignore, 0o600)
    created.push(gitignore)
  }
  const skills = installSkills(home)
  const db = openDb(dbPath(home))
  let applied: number[]
  try {
    applied = migrate(db)
  } finally {
    db.close()
  }
  const written = dedupe(hosts.flatMap((host) => host.register({ ...ctx, dryRun: false })))
  for (const folder of folders) mkdirSync(join(ctx.workspace, folder), { recursive: true })
  for (const path of created) out(`created ${show(path)}`)
  out(`installed ${skills.length} skills to ${show(installedSkillsPath(home))}`)
  if (applied.length > 0) out(`applied migrations ${applied.join(', ')}`)
  for (const line of planLines(written, ctx, 'past')) out(line)
  if (folders.length > 0) out(`created ${folders.map((folder) => `${folder}/`).join(', ')}`)
  if (local && hosts.some((host) => host.id === 'codex')) out(CODEX_TRUST_NOTE)
  if (hosts.length > 0) await finishSetup(ctx, isTTY, options, out)
  return 0
}

async function finishSetup(ctx: HostContext, isTTY: boolean, options: InitOptions, out: (line: string) => void) {
  const { workspace, home } = ctx
  out('Done. Open your agent in this workspace once the setup wizard is finished.')
  if (isTTY && options.dashboard !== false) {
    try {
      const url = await (options.launchDashboard ?? launchDashboard)({ view: 'welcome', workspace, home })
      out(`Finish setup in your browser: ${url}`)
      return
    } catch (error) {
      out(`Could not start the dashboard: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const elsewhere = workspace === resolve(process.cwd()) ? '' : ` --workspace ${JSON.stringify(workspace)}`
  const env = home === jobduckHome(workspace, userHomeOf(ctx)) ? '' : `JOBDUCK_HOME=${JSON.stringify(home)} `
  out(`Finish setup in your browser: ${env}jobduck dashboard --background --view welcome${elsewhere}`)
  out(existsSync(join(workspace, 'inbox'))
    ? 'To fill in your profile later, drop your resume or LinkedIn PDF in inbox/, or run: jobduck dashboard --view profile'
    : 'To fill in your profile later, run: jobduck dashboard --view profile')
}
