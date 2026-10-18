import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { type Sandbox, sandbox, snapshot } from './helpers'
import { claudeCode } from '../src/hosts/claude-code'
import { codex, mergeCodexConfig } from '../src/hosts/codex'
import { unifiedDiff } from '../src/hosts/diff'
import { gemini } from '../src/hosts/gemini'
import { type HostContext, skillFrontMatter } from '../src/hosts'
import { skillNames } from '../src/paths'

let box: Sandbox
let ctx: HostContext
beforeEach(() => {
  box = sandbox()
  ctx = { workspace: box.workspace, userHome: box.userHome, pathEnv: '', dryRun: true }
})
afterEach(() => box.cleanup())

const pointerPaths = (dir: string) => skillNames().map((name) => join(dir, `jobduck-${name}`, 'SKILL.md'))

const write = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

test('unifiedDiff renders creations and edits', () => {
  expect(unifiedDiff('f', null, 'a\nb\n')).toBe('--- /dev/null\n+++ f\n@@ -0,0 +1,2 @@\n+a\n+b\n')
  expect(unifiedDiff('f', 'a\nb\nc\n', 'a\nB\nc\n')).toBe('--- f\n+++ f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n')
  expect(unifiedDiff('f', 'same\n', 'same\n')).toBe('')
})

test('detection uses config files or binaries on PATH', () => {
  expect([claudeCode, codex, gemini].map((host) => host.detect(ctx))).toEqual([false, false, false])
  write(join(box.userHome, '.codex', 'config.toml'), 'model = "o3"\n')
  const bin = join(box.root, 'bin')
  write(join(bin, 'gemini'), '')
  const withPath = { ...ctx, pathEnv: bin }
  expect([claudeCode, codex, gemini].map((host) => host.detect(withPath))).toEqual([false, true, true])
})

test('Claude Code dry run merges .mcp.json, adds pointers, and writes nothing', () => {
  write(join(box.workspace, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } }, extra: 1 }, null, 2))
  write(join(box.workspace, 'CLAUDE.md'), '# Project\n')
  const before = snapshot(box.root)

  const changes = claudeCode.register(ctx)
  expect(snapshot(box.root)).toEqual(before)
  expect(changes.map((c) => c.path)).toEqual([
    ...['.mcp.json', 'AGENTS.md', 'CLAUDE.md'].map((f) => join(box.workspace, f)),
    ...pointerPaths(join(box.workspace, '.claude', 'skills')),
  ])

  const merged = JSON.parse(changes[0]!.after)
  expect(merged).toEqual({
    mcpServers: { other: { command: 'x' }, jobduck: { command: 'jobduck', args: ['mcp'] } },
    extra: 1,
  })
  expect(changes[0]!.diff).toContain('+    "jobduck": {')
  expect(changes[1]!.diff).toContain('--- /dev/null')
  expect(changes[2]!.after).toBe('# Project\n\n@AGENTS.md\n')
  expect(changes[2]!.diff).toContain('+@AGENTS.md')
})

test('Claude Code registration is idempotent once applied', () => {
  write(join(box.workspace, 'AGENTS.md'), 'mine\n')
  expect(claudeCode.isRegistered(ctx)).toBe(false)
  claudeCode.register({ ...ctx, dryRun: false })
  expect(claudeCode.isRegistered(ctx)).toBe(true)
  expect(readFileSync(join(box.workspace, 'AGENTS.md'), 'utf8')).toBe('mine\n')
  expect(readFileSync(join(box.workspace, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n')
  expect(claudeCode.register(ctx)).toEqual([])
  expect(readFileSync(join(box.workspace, '.claude', 'skills', 'jobduck-apply', 'SKILL.md'), 'utf8'))
    .toContain('Read and follow `~/.jobduck/skills/apply.md`.')
})

test('skill pointers carry the jobduck- name and the skill description', () => {
  const changes = claudeCode.register(ctx).filter((change) => change.path.endsWith('SKILL.md'))
  expect(changes).toHaveLength(skillNames().length)
  for (const [index, name] of skillNames().entries()) {
    const meta = skillFrontMatter(changes[index]!.after)
    expect(meta.name).toBe(`jobduck-${name}`)
    expect(meta.description!.length).toBeGreaterThan(20)
    expect(changes[index]!.after).toEndWith(`Read and follow \`~/.jobduck/skills/${name}.md\`.\n`)
    expect(changes[index]!.diff).toContain('--- /dev/null')
  }
})

test('Codex dry run appends the server table and preserves other sections byte for byte', () => {
  const fixture = '# my codex config\nmodel = "o3"   # keep this comment\n\n[mcp_servers.other]\ncommand = "other"\nargs = []\n\n[profiles.fast]\nmodel = "o4-mini"\n'
  const path = join(box.userHome, '.codex', 'config.toml')
  write(path, fixture)
  const before = snapshot(box.root)

  const changes = codex.register(ctx)
  expect(snapshot(box.root)).toEqual(before)
  expect(changes.map((c) => c.path)).toEqual([path, ...pointerPaths(join(box.workspace, '.agents', 'skills'))])
  expect(changes[0]!.after.startsWith(fixture)).toBe(true)
  expect(changes[0]!.after.slice(fixture.length)).toBe('\n[mcp_servers.jobduck]\ncommand = "jobduck"\nargs = ["mcp"]\n')
  expect(changes[0]!.diff).toContain('+[mcp_servers.jobduck]')
  const parsed = parse(changes[0]!.after) as Record<string, any>
  expect(parsed.mcp_servers.other).toEqual({ command: 'other', args: [] })
  expect(parsed.profiles.fast.model).toBe('o4-mini')
})

test('Codex replaces an outdated jobduck table in place', () => {
  const fixture = 'model = "o3"\n\n[mcp_servers.jobduck]\ncommand = "node"\nargs = ["old.js"]\nenv = { A = "1" }\n\n[profiles.fast]\nmodel = "o4-mini"\n'
  const after = mergeCodexConfig(fixture)
  expect(after).toBe('model = "o3"\n\n[mcp_servers.jobduck]\ncommand = "jobduck"\nargs = ["mcp"]\n\n[profiles.fast]\nmodel = "o4-mini"\n')
  expect(mergeCodexConfig(after)).toBe(after)
})

test('Codex creates a config when none exists', () => {
  const changes = codex.register(ctx)
  expect(changes[0]!.before).toBeNull()
  expect(changes[0]!.after).toBe('[mcp_servers.jobduck]\ncommand = "jobduck"\nargs = ["mcp"]\n')
})

test('Gemini dry run merges settings.json and adds GEMINI.md', () => {
  const path = join(box.userHome, '.gemini', 'settings.json')
  write(path, JSON.stringify({ theme: 'Dracula', mcpServers: { other: { command: 'y' } } }, null, 2))
  const before = snapshot(box.root)

  const changes = gemini.register(ctx)
  expect(snapshot(box.root)).toEqual(before)
  expect(changes.map((c) => c.path)).toEqual([path, join(box.workspace, 'AGENTS.md'), join(box.workspace, 'GEMINI.md')])
  expect(JSON.parse(changes[0]!.after)).toEqual({
    theme: 'Dracula',
    mcpServers: { other: { command: 'y' }, jobduck: { command: 'jobduck', args: ['mcp'] } },
  })
  expect(changes[2]!.after).toBe('See AGENTS.md\n')
  expect(changes.some((c) => c.path.endsWith('SKILL.md'))).toBe(false)
  expect(gemini.isRegistered(ctx)).toBe(false)
})
