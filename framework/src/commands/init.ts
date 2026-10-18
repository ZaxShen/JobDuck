import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { openDb } from '../db/client'
import { migrate, pendingMigrations } from '../db/migrate'
import { type FileChange, type Host, type HostContext, allHosts, hostById } from '../hosts'
import {
  PACKAGE_VERSION, PERMISSIONS_FILE, PROFILE_FILE, dbPath, ensureHome, installSkills, installedSkillsPath, jobduckHome,
  skillNames, skillsUpToDate,
} from '../paths'

export interface InitOptions {
  workspace?: string
  hosts?: string[]
  dryRun?: boolean
  yes?: boolean
  userHome?: string
  pathEnv?: string
  isTTY?: boolean
  out?: (line: string) => void
  confirm?: (question: string) => Promise<boolean>
}

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

function homePlan(home: string): string[] {
  const steps: string[] = []
  if (!existsSync(home)) steps.push(`create ${home} (mode 0700)`)
  for (const file of [PROFILE_FILE, PERMISSIONS_FILE]) {
    if (!existsSync(resolve(home, file))) steps.push(`create ${resolve(home, file)} from template`)
  }
  if (!skillsUpToDate(home)) {
    steps.push(`install ${skillNames().length} skills (version ${PACKAGE_VERSION}) to ${installedSkillsPath(home)}`)
  }
  const db = dbPath(home)
  if (!existsSync(db)) {
    steps.push(`create ${db} and apply migrations ${pendingMigrations(null).map((m) => m.version).join(', ')}`)
  } else {
    const conn = openDb(db, { readonly: true })
    try {
      const pending = pendingMigrations(conn)
      if (pending.length > 0) steps.push(`apply migrations ${pending.map((m) => m.version).join(', ')} to ${db}`)
    } finally {
      conn.close()
    }
  }
  return steps
}

export async function runInit(options: InitOptions = {}): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line))
  const home = jobduckHome()
  const ctx: HostContext = {
    workspace: resolve(options.workspace ?? process.cwd()),
    userHome: options.userHome,
    pathEnv: options.pathEnv,
    dryRun: true,
  }
  const hosts = selectHosts(ctx, options.hosts)
  const steps = homePlan(home)
  const changes = dedupe(hosts.flatMap((host) => host.register(ctx)))

  out(`Job Duck home: ${home}`)
  out(`Workspace: ${ctx.workspace}`)
  out(`Hosts: ${hosts.length > 0 ? hosts.map((host) => host.label).join(', ') : 'none detected (use --hosts)'}`)
  for (const step of steps) out(`- ${step}`)
  for (const change of changes) out(`- ${change.before === null ? 'create' : 'update'} ${change.path}\n${change.diff}`)
  if (steps.length === 0 && changes.length === 0) out('Nothing to do.')

  if (options.dryRun) {
    out('Dry run: nothing written.')
    return 0
  }
  if (!options.yes) {
    if (!(options.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY))) {
      out('Not a terminal: pass --yes to apply or --dry-run to preview.')
      return 1
    }
    if (!(await (options.confirm ?? promptYesNo)('Apply these changes?'))) {
      out('Aborted.')
      return 1
    }
  }

  const { created } = ensureHome(home)
  const skills = installSkills(home)
  const db = openDb(dbPath(home))
  let applied: number[]
  try {
    applied = migrate(db)
  } finally {
    db.close()
  }
  const written = dedupe(hosts.flatMap((host) => host.register({ ...ctx, dryRun: false })))
  for (const path of created) out(`created ${path}`)
  out(`installed ${skills.length} skills to ${installedSkillsPath(home)}`)
  if (applied.length > 0) out(`applied migrations ${applied.join(', ')}`)
  for (const change of written) out(`${change.before === null ? 'created' : 'updated'} ${change.path}`)
  return 0
}
