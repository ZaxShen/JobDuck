import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { type Sandbox, sandbox } from './helpers'
import { runDoctor } from '../src/commands/doctor'
import { CODEX_TRUST_NOTE, chooseHome, runInit } from '../src/commands/init'
import { TEMPLATES } from '../src/assets'
import { claudeCode, mergeAgentsMd } from '../src/hosts/claude-code'
import { codex, mergeCodexConfig } from '../src/hosts/codex'
import { gemini } from '../src/hosts/gemini'
import { type HostContext, MCP_SERVER, homeLabel, isWorkspaceLocal, mcpServer } from '../src/hosts'
import { defaultHome, findHome, jobduckHome } from '../src/paths'

let box: Sandbox
let lines: string[]
const out = (line: string) => { lines.push(line) }

beforeEach(() => {
  box = sandbox()
  delete process.env.JOBDUCK_HOME
  lines = []
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

test('jobduckHome prefers JOBDUCK_HOME, then the nearest marked .jobduck upward, then the default', () => {
  const deep = join(box.workspace, 'cv', 'deep')
  mkdirSync(deep, { recursive: true })
  expect(jobduckHome(deep, box.userHome)).toBe(join(box.userHome, '.jobduck'))

  mark(join(box.workspace, '.jobduck'))
  expect(jobduckHome(deep, box.userHome)).toBe(join(box.workspace, '.jobduck'))

  mark(join(box.workspace, 'cv', '.jobduck'), 'permissions.toml')
  expect(jobduckHome(deep, box.userHome)).toBe(join(box.workspace, 'cv', '.jobduck'))

  process.env.JOBDUCK_HOME = join(box.root, 'elsewhere')
  expect(jobduckHome(deep, box.userHome)).toBe(join(box.root, 'elsewhere'))
})

test('a bare .jobduck folder without jobduck.db or permissions.toml is not a home', () => {
  mkdirSync(join(box.workspace, '.jobduck', 'skills'), { recursive: true })
  writeFileSync(join(box.workspace, '.jobduck', 'profile.md'), '')
  expect(findHome(box.workspace)).toBeUndefined()
  expect(jobduckHome(box.workspace, box.userHome)).toBe(defaultHome(box.userHome))
})

test('init picks --home, then JOBDUCK_HOME, then an existing home, then the workspace when dedicated', () => {
  const ctx = { workspace: box.workspace, userHome: box.userHome }
  expect(chooseHome(ctx, 'store')).toBe(join(box.workspace, 'store'))
  expect(chooseHome(ctx)).toBe(join(box.workspace, '.jobduck'))

  writeFileSync(join(box.workspace, 'package.json'), '{}')
  expect(chooseHome(ctx)).toBe(join(box.userHome, '.jobduck'))

  process.env.JOBDUCK_HOME = join(box.root, 'env-home')
  expect(chooseHome(ctx)).toBe(join(box.root, 'env-home'))
  expect(chooseHome(ctx, 'store')).toBe(join(box.workspace, 'store'))
})

test('init keeps an existing ~/.jobduck even in a dedicated folder outside the user home', () => {
  mark(join(box.userHome, '.jobduck'), 'permissions.toml')
  expect(chooseHome({ workspace: box.workspace, userHome: box.userHome })).toBe(join(box.userHome, '.jobduck'))
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
  expect(agents).not.toContain('~/.jobduck')
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

test('an existing ~/.jobduck keeps the global host configs and entries without env', async () => {
  const home = join(box.userHome, '.jobduck')
  mark(home)
  expect(await runInit({
    workspace: box.workspace, userHome: box.userHome, pathEnv: '', isTTY: false, yes: true, out, hosts: ['codex', 'gemini'],
  })).toBe(0)
  expect(existsSync(join(box.workspace, '.jobduck'))).toBe(false)
  expect(existsSync(join(box.workspace, '.codex'))).toBe(false)
  expect(existsSync(join(home, '.gitignore'))).toBe(false)
  expect(readFileSync(join(box.userHome, '.codex', 'config.toml'), 'utf8'))
    .toBe('[mcp_servers.jobduck]\ncommand = "jobduck"\nargs = ["mcp"]\n')
  expect(JSON.parse(readFileSync(join(box.userHome, '.gemini', 'settings.json'), 'utf8')).mcpServers.jobduck).toEqual(MCP_SERVER)
  expect(lines).not.toContain(CODEX_TRUST_NOTE)
  expect(readFileSync(join(box.workspace, 'AGENTS.md'), 'utf8')).toBe(TEMPLATES['AGENTS.md']!)
})

test('server entries carry JOBDUCK_HOME only for a home other than ~/.jobduck', () => {
  expect(mcpServer(ctxFor(box.workspace, join(box.userHome, '.jobduck')))).toBe(MCP_SERVER)
  const other = join(box.root, 'other-home')
  expect(mcpServer(ctxFor(box.workspace, other))).toEqual({ ...MCP_SERVER, env: { JOBDUCK_HOME: other } })

  const ctx = ctxFor(box.workspace, other)
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
  expect(homeLabel(ctxFor(box.workspace, join(box.userHome, '.jobduck')))).toBe('~/.jobduck')
  expect(homeLabel(ctxFor(box.workspace, join(box.userHome, 'search', '.jobduck')))).toBe('~/search/.jobduck')
  expect(homeLabel(ctxFor(box.workspace, join(box.root, 'other')))).toBe(join(box.root, 'other'))
})

test('AGENTS.md and skill pointers name the home by its label', () => {
  const block = mergeAgentsMd(null, '.jobduck')
  expect(block.startsWith('<!-- jobduck:start')).toBe(true)
  expect(block.trimEnd().endsWith('<!-- jobduck:end -->')).toBe(true)
  expect(block).toContain('`.jobduck/profile.md`')
  expect(block).toContain('`.jobduck` is this workspace\'s Job Duck home')
  expect(block).not.toContain('~/.jobduck')

  const stale = `# Notes\n\n${TEMPLATES['AGENTS.md']!.trimEnd()}\n\n## Mine\n`
  expect(mergeAgentsMd(stale, '.jobduck')).toBe(`# Notes\n\n${block.trimEnd()}\n\n## Mine\n`)
  const legacy = readFileSync(join(import.meta.dir, 'fixtures', 'agents-0.1.md'), 'utf8')
  expect(mergeAgentsMd(legacy, '.jobduck')).toBe(block)

  const pointers = claudeCode.register(ctxFor(box.workspace, join(box.userHome, 'search', '.jobduck')))
    .filter((change) => change.path.endsWith(join('jobduck-cv', 'SKILL.md')))
  expect(pointers[0]!.after).toEndWith('Read and follow `~/search/.jobduck/skills/cv.md`.\n')
})
