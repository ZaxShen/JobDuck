import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { type Sandbox, sandbox, snapshot } from './helpers'
import { runDashboard } from '../src/commands/dashboard'
import { runDoctor } from '../src/commands/doctor'
import { CODEX_TRUST_NOTE, DEDICATED_TIP, chooseHome, runInit } from '../src/commands/init'
import { runSync } from '../src/commands/sync'
import { TEMPLATES } from '../src/assets'
import { claudeCode, mergeAgentsMd } from '../src/hosts/claude-code'
import { codex, mergeCodexConfig } from '../src/hosts/codex'
import { gemini } from '../src/hosts/gemini'
import { type HostContext, MCP_SERVER, allHosts, homeLabel, isWorkspaceLocal, mcpServer } from '../src/hosts'
import { NoHomeError, findHome, jobduckHome, resolveWorkspace } from '../src/paths'

let box: Sandbox
let lines: string[]
let errors: string[]
const out = (line: string) => { lines.push(line) }
const err = (line: string) => { errors.push(line) }

beforeEach(() => {
  box = sandbox()
  delete process.env.JOBDUCK_HOME
  lines = []
  errors = []
})
afterEach(() => {
  process.env.JOBDUCK_HOME = box.home
  box.cleanup()
})

const mark = (home: string, file = 'jobduck.db') => {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, file), '')
}

const ctxFor = (workspace: string, home: string): HostContext =>
  ({ workspace, home, userHome: box.userHome, pathEnv: '', dryRun: true })

const cli = join(import.meta.dir, '..', 'src', 'cli.ts')

test('jobduckHome prefers JOBDUCK_HOME, then the nearest marked .jobduck upward, else throws NoHomeError', () => {
  const deep = join(box.workspace, 'cv', 'deep')
  mkdirSync(deep, { recursive: true })
  expect(() => jobduckHome(deep, box.userHome)).toThrow(NoHomeError)
  expect(() => jobduckHome(deep, box.userHome)).toThrow(`No Job Duck home in ${deep} or any folder above it`)
  expect(() => jobduckHome(deep, box.userHome)).toThrow('run jobduck init in a dedicated folder, or set JOBDUCK_HOME')

  mark(join(box.workspace, '.jobduck'))
  expect(jobduckHome(deep, box.userHome)).toBe(join(box.workspace, '.jobduck'))

  mark(join(box.workspace, 'cv', '.jobduck'), 'permissions.toml')
  expect(jobduckHome(deep, box.userHome)).toBe(join(box.workspace, 'cv', '.jobduck'))

  process.env.JOBDUCK_HOME = join(box.root, 'elsewhere')
  expect(jobduckHome(deep, box.userHome)).toBe(join(box.root, 'elsewhere'))
})

test('a marked .jobduck in the user home folder is ignored by the walk-up but works through JOBDUCK_HOME', () => {
  const userLevel = join(box.userHome, '.jobduck')
  mark(userLevel)
  const deep = join(box.userHome, 'notes', 'deep')
  mkdirSync(deep, { recursive: true })
  expect(findHome(box.userHome, box.userHome)).toBeUndefined()
  expect(() => jobduckHome(deep, box.userHome)).toThrow(NoHomeError)

  mark(join(box.root, '.jobduck'))
  expect(jobduckHome(deep, box.userHome)).toBe(join(box.root, '.jobduck'))

  process.env.JOBDUCK_HOME = userLevel
  expect(jobduckHome(deep, box.userHome)).toBe(userLevel)
})

test('a bare .jobduck folder without jobduck.db or permissions.toml is not a home', () => {
  mkdirSync(join(box.workspace, '.jobduck', 'skills'), { recursive: true })
  writeFileSync(join(box.workspace, '.jobduck', 'profile.md'), '')
  expect(findHome(box.workspace, box.userHome)).toBeUndefined()
  expect(() => jobduckHome(box.workspace, box.userHome)).toThrow(NoHomeError)
})

test('init picks --home, then JOBDUCK_HOME, then an existing home, then the workspace when dedicated, else none', () => {
  const ctx = { workspace: box.workspace, userHome: box.userHome }
  expect(chooseHome(ctx, 'store')).toBe(join(box.workspace, 'store'))
  expect(chooseHome(ctx)).toBe(join(box.workspace, '.jobduck'))

  writeFileSync(join(box.workspace, 'package.json'), '{}')
  expect(chooseHome(ctx)).toBeUndefined()
  expect(chooseHome({ workspace: box.userHome, userHome: box.userHome })).toBeUndefined()

  mark(join(box.workspace, '.jobduck'))
  expect(chooseHome(ctx)).toBe(join(box.workspace, '.jobduck'))

  process.env.JOBDUCK_HOME = join(box.root, 'env-home')
  expect(chooseHome(ctx)).toBe(join(box.root, 'env-home'))
  expect(chooseHome(ctx, 'store')).toBe(join(box.workspace, 'store'))
})

test('init never picks a marked .jobduck in the user home folder', () => {
  mark(join(box.userHome, '.jobduck'), 'permissions.toml')
  expect(chooseHome({ workspace: box.workspace, userHome: box.userHome })).toBe(join(box.workspace, '.jobduck'))
  expect(chooseHome({ workspace: box.userHome, userHome: box.userHome })).toBeUndefined()
})

test('init outside a dedicated folder without --home or JOBDUCK_HOME refuses, prints the tip and writes nothing', async () => {
  writeFileSync(join(box.workspace, 'package.json'), '{}')
  const before = snapshot(box.root)
  for (const workspace of [box.workspace, box.userHome]) {
    lines = []
    errors = []
    const code = await runInit({
      workspace, userHome: box.userHome, pathEnv: '', isTTY: false, yes: true, out, err, hosts: ['claude', 'codex', 'gemini'],
    })
    expect(code).not.toBe(0)
    expect(errors[0]).toContain(`No Job Duck home for ${workspace}`)
    expect(errors.slice(1)).toEqual(DEDICATED_TIP)
    expect(lines).toEqual([])
    expect(snapshot(box.root)).toEqual(before)
  }

  expect(await runInit({ workspace: box.workspace, userHome: box.userHome, pathEnv: '', dryRun: true, out, err, home: 'store' })).toBe(0)
  process.env.JOBDUCK_HOME = join(box.root, 'env-home')
  expect(await runInit({ workspace: box.workspace, userHome: box.userHome, pathEnv: '', dryRun: true, out, err })).toBe(0)
  expect(snapshot(box.root)).toEqual(before)
})

test('init in a dedicated folder keeps the home and every host config in the workspace', async () => {
  const home = join(box.workspace, '.jobduck')
  expect(chooseHome({ workspace: box.workspace, userHome: box.userHome })).toBe(home)
  const code = await runInit({
    workspace: box.workspace, userHome: box.userHome, pathEnv: '', isTTY: false, yes: true, out, hosts: ['claude', 'codex', 'gemini'],
  })
  expect(code).toBe(0)
  expect(readdirSync(box.userHome)).toEqual([])
  expect(existsSync(box.home)).toBe(false)
  for (const file of ['jobduck.db', 'profile.md', 'permissions.toml', 'skills']) expect(existsSync(join(home, file))).toBe(true)
  expect(readFileSync(join(home, '.gitignore'), 'utf8')).toBe('*\n')
  expect(lines).toContain('Job Duck home: .jobduck')
  expect(lines).toContain(CODEX_TRUST_NOTE)

  const server = { ...MCP_SERVER, env: { JOBDUCK_HOME: home } }
  expect(JSON.parse(readFileSync(join(box.workspace, '.mcp.json'), 'utf8')).mcpServers.jobduck).toEqual(server)
  expect(JSON.parse(readFileSync(join(box.workspace, '.gemini', 'settings.json'), 'utf8')).mcpServers.jobduck).toEqual(server)
  const toml = parse(readFileSync(join(box.workspace, '.codex', 'config.toml'), 'utf8')) as Record<string, any>
  expect(toml.mcp_servers.jobduck).toEqual(server)

  const agents = readFileSync(join(box.workspace, 'AGENTS.md'), 'utf8')
  expect(agents).toContain('`.jobduck/skills/cv.md`')
  expect(agents).not.toContain('{{home}}')
  expect(readFileSync(join(box.workspace, '.agents', 'skills', 'jobduck-cv', 'SKILL.md'), 'utf8'))
    .toEndWith('Read and follow `.jobduck/skills/cv.md`.\n')

  lines = []
  expect(await runInit({
    workspace: box.workspace, userHome: box.userHome, pathEnv: '', dryRun: true, out, hosts: ['claude', 'codex', 'gemini'],
  })).toBe(0)
  expect(lines).toContain('Nothing to do.')

  const deep = join(box.workspace, 'cv', 'deep')
  mkdirSync(deep, { recursive: true })
  lines = []
  runDoctor({ workspace: deep, userHome: box.userHome, pathEnv: '', json: true, out })
  expect(JSON.parse(lines.join('\n')).home).toBe(home)
  expect(readdirSync(box.userHome)).toEqual([])
})

test('a JOBDUCK_HOME outside the workspace keeps the global host configs, with the home in every entry', async () => {
  const home = join(box.userHome, '.jobduck')
  mark(home)
  process.env.JOBDUCK_HOME = home
  expect(await runInit({
    workspace: box.workspace, userHome: box.userHome, pathEnv: '', isTTY: false, yes: true, out, hosts: ['codex', 'gemini'],
  })).toBe(0)
  expect(existsSync(join(box.workspace, '.jobduck'))).toBe(false)
  expect(existsSync(join(box.workspace, '.codex'))).toBe(false)
  expect(existsSync(join(home, '.gitignore'))).toBe(false)
  expect(readFileSync(join(box.userHome, '.codex', 'config.toml'), 'utf8'))
    .toBe(`[mcp_servers.jobduck]\ncommand = "jobduck"\nargs = ["mcp"]\nenv = { JOBDUCK_HOME = ${JSON.stringify(home)} }\n`)
  expect(JSON.parse(readFileSync(join(box.userHome, '.gemini', 'settings.json'), 'utf8')).mcpServers.jobduck)
    .toEqual({ ...MCP_SERVER, env: { JOBDUCK_HOME: home } })
  expect(lines).not.toContain(CODEX_TRUST_NOTE)
  expect(readFileSync(join(box.workspace, 'AGENTS.md'), 'utf8')).toBe(mergeAgentsMd(null, homeLabel(ctxFor(box.workspace, home))))
})

test('every host entry carries JOBDUCK_HOME for every home', () => {
  const homes = [
    join(box.workspace, '.jobduck'),
    join(box.userHome, '.jobduck'),
    join(box.userHome, 'search', '.jobduck'),
    join(box.root, 'other-home'),
  ]
  for (const home of homes) {
    const ctx = ctxFor(box.workspace, home)
    expect(mcpServer(ctx)).toEqual({ ...MCP_SERVER, env: { JOBDUCK_HOME: home } })
    for (const host of allHosts()) {
      const change = host.register(ctx).find((candidate) => candidate.path === host.configPath(ctx))!
      const entry = host.id === 'codex'
        ? (parse(change.after) as Record<string, any>).mcp_servers.jobduck
        : JSON.parse(change.after).mcpServers.jobduck
      expect(entry).toEqual({ ...MCP_SERVER, env: { JOBDUCK_HOME: home } })
    }
  }

  const ctx = ctxFor(box.workspace, join(box.root, 'other-home'))
  expect(isWorkspaceLocal(ctx)).toBe(false)
  expect(codex.configPath(ctx)).toBe(join(box.userHome, '.codex', 'config.toml'))
  expect(gemini.configPath(ctx)).toBe(join(box.userHome, '.gemini', 'settings.json'))
  expect(claudeCode.configPath(ctx)).toBe(join(box.workspace, '.mcp.json'))
})

test('Codex rewrites a jobduck table whose JOBDUCK_HOME is stale and keeps a current one', () => {
  const entry = { ...MCP_SERVER, env: { JOBDUCK_HOME: '/srv/a' } }
  const after = mergeCodexConfig('model = "o3"\n', entry)
  expect(after).toBe('model = "o3"\n\n[mcp_servers.jobduck]\ncommand = "jobduck"\nargs = ["mcp"]\nenv = { JOBDUCK_HOME = "/srv/a" }\n')
  expect(mergeCodexConfig(after, entry)).toBe(after)
  expect(mergeCodexConfig(after, { ...MCP_SERVER, env: { JOBDUCK_HOME: '/srv/b' } })).toContain('JOBDUCK_HOME = "/srv/b"')
  expect(mergeCodexConfig(after)).toBe('model = "o3"\n\n[mcp_servers.jobduck]\ncommand = "jobduck"\nargs = ["mcp"]\n')
})

test('the home label is .jobduck in the workspace, ~/ under the user home, else absolute', () => {
  expect(homeLabel(ctxFor(box.workspace, join(box.workspace, '.jobduck')))).toBe('.jobduck')
  expect(homeLabel(ctxFor(box.workspace, join(box.userHome, 'search', '.jobduck')))).toBe('~/search/.jobduck')
  expect(homeLabel(ctxFor(box.workspace, join(box.root, 'other')))).toBe(join(box.root, 'other'))
})

test('AGENTS.md and skill pointers name the home by its label', () => {
  expect(TEMPLATES['AGENTS.md']).toContain('`{{home}}/profile.md`')
  const block = mergeAgentsMd(null, '.jobduck')
  expect(block.startsWith('<!-- jobduck:start')).toBe(true)
  expect(block.trimEnd().endsWith('<!-- jobduck:end -->')).toBe(true)
  expect(block).toContain('`.jobduck/profile.md`')
  expect(block).toContain('`.jobduck` is this workspace\'s Job Duck home')
  expect(block).not.toContain('{{home}}')

  const stale = `# Notes\n\n${TEMPLATES['AGENTS.md']!.trimEnd()}\n\n## Mine\n`
  expect(mergeAgentsMd(stale, '.jobduck')).toBe(`# Notes\n\n${block.trimEnd()}\n\n## Mine\n`)
  const legacy = readFileSync(join(import.meta.dir, 'fixtures', 'agents-0.1.md'), 'utf8')
  expect(mergeAgentsMd(legacy, '.jobduck')).toBe(block)

  const pointers = claudeCode.register(ctxFor(box.workspace, join(box.userHome, 'search', '.jobduck')))
    .filter((change) => change.path.endsWith(join('jobduck-cv', 'SKILL.md')))
  expect(pointers[0]!.after).toEndWith('Read and follow `~/search/.jobduck/skills/cv.md`.\n')
})

test('resolveWorkspace snaps a folder inside a workspace home to the folder that holds .jobduck/', () => {
  const deep = join(box.workspace, 'cv', 'deep')
  mkdirSync(deep, { recursive: true })
  expect(resolveWorkspace(deep, box.userHome)).toBe(deep)

  mark(join(box.userHome, '.jobduck'))
  expect(resolveWorkspace(deep, box.userHome)).toBe(deep)
  expect(resolveWorkspace(join(box.userHome, 'notes'), box.userHome)).toBe(join(box.userHome, 'notes'))

  mark(join(box.workspace, '.jobduck'))
  expect(resolveWorkspace(deep, box.userHome)).toBe(box.workspace)
  expect(resolveWorkspace(box.workspace, box.userHome)).toBe(box.workspace)
  expect(resolveWorkspace(box.root, box.userHome)).toBe(box.root)

  process.env.JOBDUCK_HOME = join(box.workspace, '.jobduck')
  const outside = join(box.root, 'outside')
  expect(resolveWorkspace(outside, box.userHome)).toBe(outside)
  expect(resolveWorkspace(deep, box.userHome)).toBe(box.workspace)

  process.env.JOBDUCK_HOME = join(box.userHome, '.jobduck')
  expect(resolveWorkspace(join(box.userHome, 'notes'), box.userHome)).toBe(join(box.userHome, 'notes'))
})

test('init and doctor from a subfolder of a workspace home use the folder that holds .jobduck/', async () => {
  const home = join(box.workspace, '.jobduck')
  mark(home)
  const cv = join(box.workspace, 'cv')
  mkdirSync(cv)
  expect(await runInit({ workspace: cv, userHome: box.userHome, pathEnv: '', dryRun: true, out, hosts: ['codex', 'gemini'] })).toBe(0)
  expect(lines).toContain(`Workspace: ${box.workspace} (holds .jobduck/)`)
  expect(lines).toContain('- create .codex/config.toml')
  expect(lines).toContain('- create .gemini/settings.json')
  expect(lines.some((line) => line.includes('~/'))).toBe(false)
  expect(lines.some((line) => line.includes('cv/'))).toBe(false)

  lines = []
  runDoctor({ workspace: cv, userHome: box.userHome, pathEnv: '', json: true, out })
  const hosts = JSON.parse(lines.join('\n')).hosts as Array<{ id: string; config: string }>
  expect(hosts.find((host) => host.id === 'codex')!.config).toBe(join(box.workspace, '.codex', 'config.toml'))
  expect(hosts.find((host) => host.id === 'gemini')!.config).toBe(join(box.workspace, '.gemini', 'settings.json'))

  lines = []
  runDoctor({ workspace: cv, userHome: box.userHome, pathEnv: '', out })
  expect(lines[0]).toBe(`Workspace: ${box.workspace} (holds .jobduck/)`)
})

test('doctor without a home reports a failing home check and still prints its other lines', () => {
  const before = snapshot(box.root)
  expect(runDoctor({ workspace: box.workspace, userHome: box.userHome, pathEnv: '', out })).toBe(1)
  expect(lines[0]).toStartWith('ok   runtime: ')
  expect(lines[1]).toStartWith('FAIL path: ')
  expect(lines[2]).toBe(`FAIL home: ${new NoHomeError(box.workspace).message}`)
  expect(lines.filter((line) => line.startsWith('     host '))).toHaveLength(3)
  expect(snapshot(box.root)).toEqual(before)

  lines = []
  expect(runDoctor({ workspace: box.workspace, userHome: box.userHome, pathEnv: '', json: true, out })).toBe(1)
  const report = JSON.parse(lines.join('\n'))
  expect(report.ok).toBe(false)
  expect(report.home).toBeNull()
  expect(report.checks.find((check: { name: string }) => check.name === 'home').ok).toBe(false)
})

test('dashboard and sync without a home print the error and exit 1', async () => {
  const message = new NoHomeError(box.workspace).message
  expect(await runDashboard({ workspace: box.workspace, port: 0, open: false, out, err })).toBe(1)
  expect(await runSync({ workspace: box.workspace, out, err, fetch: () => { throw new Error('no network') } })).toBe(1)
  expect(errors).toEqual([message, message])
  expect(lines).toEqual([])
})

test('mcp without a home exits 1 with the message on stderr and nothing on stdout', () => {
  const result = spawnSync('bun', [cli, 'mcp'], {
    cwd: box.workspace,
    env: { ...process.env, HOME: box.userHome, USERPROFILE: box.userHome },
    input: '',
    encoding: 'utf8',
  })
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('No Job Duck home in ')
  expect(result.stderr).toContain('run jobduck init in a dedicated folder, or set JOBDUCK_HOME')
}, 20_000)
