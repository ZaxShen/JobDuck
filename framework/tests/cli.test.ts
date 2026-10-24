import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Sandbox, sandbox, snapshot } from './helpers'
import { runDoctor } from '../src/commands/doctor'
import { runInit } from '../src/commands/init'
import { PACKAGE_VERSION, installSkills } from '../src/paths'

const SKILLS = ['apply', 'augment', 'cv', 'find', 'interview', 'setup', 'track']

let box: Sandbox
let lines: string[]
const out = (line: string) => { lines.push(line) }

beforeEach(() => {
  box = sandbox()
  lines = []
})
afterEach(() => box.cleanup())

function fixtures() {
  mkdirSync(join(box.userHome, '.codex'))
  writeFileSync(join(box.userHome, '.codex', 'config.toml'), 'model = "o3"\n')
  mkdirSync(join(box.userHome, '.gemini'))
  writeFileSync(join(box.userHome, '.gemini', 'settings.json'), '{"theme":"Dracula"}\n')
  writeFileSync(join(box.workspace, 'CLAUDE.md'), '# Project\n')
}

const base = () => ({ workspace: box.workspace, userHome: box.userHome, pathEnv: '', isTTY: false, out })

function doctorBase() {
  const bin = join(box.root, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'jobduck'), '#!/bin/sh\n', { mode: 0o755 })
  return { ...base(), pathEnv: bin }
}

test('init --dry-run --diff prints the three host diffs and touches nothing', async () => {
  fixtures()
  const before = snapshot(box.root)
  const code = await runInit({ ...base(), hosts: ['claude', 'codex', 'gemini'], dryRun: true, diff: true })
  expect(code).toBe(0)
  expect(snapshot(box.root)).toEqual(before)
  expect(existsSync(box.home)).toBe(false)
  const text = lines.join('\n')
  expect(text).toContain(`+++ ${join(box.workspace, '.mcp.json')}`)
  expect(text).toContain(`+++ ${join(box.userHome, '.codex', 'config.toml')}`)
  expect(text).toContain(`+++ ${join(box.userHome, '.gemini', 'settings.json')}`)
  expect(text).toContain('Dry run: nothing written.')
})

test('init --dry-run --diff for claude and codex diffs twelve SKILL.md pointers', async () => {
  const before = snapshot(box.root)
  expect(await runInit({ ...base(), hosts: ['claude', 'codex'], dryRun: true, diff: true })).toBe(0)
  expect(snapshot(box.root)).toEqual(before)
  const pointers = lines.join('\n').split('\n').filter((line) => /^\+\+\+ .*\/SKILL\.md$/.test(line))
  expect(pointers).toHaveLength(14)
  for (const name of SKILLS) {
    expect(pointers).toContain(`+++ ${join(box.workspace, '.claude', 'skills', `jobduck-${name}`, 'SKILL.md')}`)
    expect(pointers).toContain(`+++ ${join(box.workspace, '.agents', 'skills', `jobduck-${name}`, 'SKILL.md')}`)
  }
  expect(lines.some((line) => line.startsWith('- install 7 skills'))).toBe(true)
})

test('init --dry-run without --diff prints one line per file and groups skill pointers', async () => {
  fixtures()
  expect(await runInit({ ...base(), hosts: ['claude', 'codex'], dryRun: true })).toBe(0)
  expect(lines).toContain(`Job Duck home: ${box.home}`)
  expect(lines).toContain('- create .mcp.json')
  expect(lines).toContain('- create AGENTS.md')
  expect(lines).toContain('- update CLAUDE.md')
  expect(lines).toContain('- create .claude/skills/jobduck-*/SKILL.md (7 skill pointers)')
  expect(lines).toContain('- update ~/.codex/config.toml')
  expect(lines).toContain('- create .agents/skills/jobduck-*/SKILL.md (7 skill pointers)')
  expect(lines).toContain('Pass --diff to see every change in full.')
  expect(lines).toContain('- create inbox/, cv/, cover-letters/ for your documents')
  expect(lines.filter((line) => line.startsWith('- '))).toHaveLength(11)
  expect(lines.some((line) => /^[-+@]{2,3} /.test(line))).toBe(false)
  expect(lines.some((line) => line.includes(box.workspace) && line !== `Workspace: ${box.workspace}`)).toBe(false)
})

test('init without --yes refuses on a non-TTY and writes nothing', async () => {
  fixtures()
  const before = snapshot(box.root)
  expect(await runInit({ ...base(), hosts: ['codex'], isTTY: false })).toBe(1)
  expect(snapshot(box.root)).toEqual(before)
})

test('init asks on a TTY and aborts on no', async () => {
  const before = snapshot(box.root)
  expect(await runInit({ ...base(), hosts: ['codex'], isTTY: true, confirm: async () => false })).toBe(1)
  expect(snapshot(box.root)).toEqual(before)
})

test('init --yes creates the home, migrates, and registers hosts; doctor then passes', async () => {
  fixtures()
  expect(await runInit({ ...base(), hosts: ['claude', 'codex', 'gemini'], yes: true })).toBe(0)
  expect(lines).toContain('created .claude/skills/jobduck-*/SKILL.md (7 skill pointers)')
  expect(lines).toContain('updated ~/.codex/config.toml')
  expect(lines).toContain('Done. Open your agent in this workspace once the setup wizard is finished.')
  expect(lines.some((line) => line.startsWith('Finish setup in your browser: jobduck dashboard --background --view welcome'))).toBe(true)
  expect(lines.some((line) => line.includes('set up Job Duck'))).toBe(false)
  for (const file of ['jobduck.db', 'profile.md', 'permissions.toml']) expect(existsSync(join(box.home, file))).toBe(true)
  for (const file of ['.mcp.json', 'AGENTS.md', 'GEMINI.md']) expect(existsSync(join(box.workspace, file))).toBe(true)
  const skills = join(box.home, 'skills')
  for (const name of SKILLS) {
    expect(statSync(join(skills, `${name}.md`)).mode & 0o777).toBe(0o600)
    expect(existsSync(join(box.workspace, '.claude', 'skills', `jobduck-${name}`, 'SKILL.md'))).toBe(true)
  }
  expect(readFileSync(join(skills, '.version'), 'utf8').trim()).toBe(PACKAGE_VERSION)

  lines = []
  expect(await runInit({ ...base(), hosts: ['claude', 'codex', 'gemini'], dryRun: true })).toBe(0)
  expect(lines).toContain('Nothing to do.')

  lines = []
  expect(runDoctor({ ...doctorBase(), json: true })).toBe(0)
  const report = JSON.parse(lines.join('\n'))
  expect(report.checks.find((c: { name: string }) => c.name === 'database').detail).toBe('migration version 3')
  expect(report.checks.find((c: { name: string }) => c.name === 'runtime').detail).toBe(`jobduck ${PACKAGE_VERSION} on bun ${Bun.version}`)
  expect(report.checks.find((c: { name: string }) => c.name === 'path').detail).toBe(`jobduck found at ${join(box.root, 'bin', 'jobduck')}`)
  expect(report.checks.some((c: { name: string }) => c.name === 'node')).toBe(false)
  expect(report.hosts.every((h: { registered: boolean }) => h.registered)).toBe(true)
  expect(report.checks.find((c: { name: string }) => c.name === 'skills').detail).toBe(`7 installed (version ${PACKAGE_VERSION})`)

  rmSync(join(box.home, 'skills', 'apply.md'))
  lines = []
  expect(runDoctor({ ...doctorBase() })).toBe(1)
  expect(lines.some((line) => line.startsWith('FAIL skills: missing apply'))).toBe(true)
})

test('doctor on a fresh home reports skills as not installed without failing', () => {
  expect(runDoctor({ ...doctorBase() })).toBe(0)
  expect(lines).toContain('ok   skills: 0 installed (run jobduck init to install)')
})

test('doctor fails when permissions.toml is invalid', async () => {
  expect(runDoctor({ ...doctorBase() })).toBe(0)
  writeFileSync(join(box.home, 'permissions.toml'), '[modules]\nteleport = true\n')
  lines = []
  expect(runDoctor({ ...doctorBase() })).toBe(1)
  expect(lines.some((line) => line.startsWith('FAIL permissions.toml'))).toBe(true)
})

test('doctor fails the path check when jobduck is not on PATH', () => {
  expect(runDoctor({ ...base() })).toBe(1)
  expect(lines).toContain('FAIL path: not on PATH; hosts start the MCP server with `jobduck mcp`')
  expect(lines.some((line) => line.startsWith('ok   runtime: jobduck '))).toBe(true)
})

function launcher() {
  const calls: Array<{ view: string; workspace: string }> = []
  const launch = async (options: { view: string; workspace: string }) => {
    calls.push(options)
    return 'http://127.0.0.1:4848/#welcome'
  }
  return { calls, launch }
}

test('init on a TTY opens the setup wizard in the background dashboard', async () => {
  const { calls, launch } = launcher()
  expect(await runInit({ ...base(), hosts: ['codex'], yes: true, isTTY: true, launchDashboard: launch })).toBe(0)
  expect(calls).toEqual([{ view: 'welcome', workspace: box.workspace }])
  expect(lines).toContain('Finish setup in your browser: http://127.0.0.1:4848/#welcome')
  expect(lines.some((line) => line.includes('set up Job Duck'))).toBe(false)
})

test('init does not launch the dashboard with --no-dashboard or on a non-TTY', async () => {
  const { calls, launch } = launcher()
  expect(await runInit({ ...base(), hosts: ['codex'], yes: true, isTTY: true, dashboard: false, launchDashboard: launch })).toBe(0)
  expect(await runInit({ ...base(), hosts: ['codex'], yes: true, isTTY: false, launchDashboard: launch })).toBe(0)
  expect(calls).toEqual([])
  expect(lines.filter((line) => line.startsWith('Finish setup in your browser: jobduck dashboard --background --view welcome')))
    .toHaveLength(2)
})

test('init falls back to printing the command when the dashboard cannot start', async () => {
  const launch = async () => { throw new Error('the dashboard did not start within 5s') }
  expect(await runInit({ ...base(), hosts: ['codex'], yes: true, isTTY: true, launchDashboard: launch })).toBe(0)
  expect(lines).toContain('Could not start the dashboard: the dashboard did not start within 5s')
  expect(lines.some((line) => line.startsWith('Finish setup in your browser: jobduck dashboard --background'))).toBe(true)
})

function stampSkills(version: string) {
  installSkills(box.home)
  writeFileSync(join(box.home, 'skills', '.version'), `${version}\n`)
}

test('doctor warns when the installed skills are from another version', () => {
  stampSkills('0.0.1')
  expect(runDoctor({ ...doctorBase() })).toBe(0)
  const warning = lines.find((line) => line.startsWith('warn skills: '))
  expect(warning).toBe(`warn skills: version 0.0.1 installed, jobduck is ${PACKAGE_VERSION}; run jobduck init to refresh them`)
  expect(lines.some((line) => line.startsWith('ok   skills'))).toBe(false)
})

test('the cli refreshes stale skills before a command', () => {
  stampSkills('0.0.1')
  writeFileSync(join(box.home, 'skills', 'find.md'), 'stale\n')
  const result = spawnSync('bun', [join(import.meta.dir, '..', 'src', 'cli.ts'), 'doctor', '--json'], {
    cwd: box.workspace,
    env: { ...process.env, JOBDUCK_HOME: box.home, HOME: box.userHome },
    encoding: 'utf8',
  })
  expect(result.stderr).toBe('')
  expect(readFileSync(join(box.home, 'skills', '.version'), 'utf8').trim()).toBe(PACKAGE_VERSION)
  expect(readFileSync(join(box.home, 'skills', 'find.md'), 'utf8')).not.toBe('stale\n')
  const report = JSON.parse(result.stdout)
  expect(report.checks.find((c: { name: string }) => c.name === 'skills').detail).toBe(`7 installed (version ${PACKAGE_VERSION})`)
}, 20_000)

test('the cli leaves a missing home alone', () => {
  const result = spawnSync('bun', [join(import.meta.dir, '..', 'src', 'cli.ts'), '--version'], {
    cwd: box.workspace,
    env: { ...process.env, JOBDUCK_HOME: box.home, HOME: box.userHome },
    encoding: 'utf8',
  })
  expect(result.stdout.trim()).toBe(PACKAGE_VERSION)
  expect(existsSync(box.home)).toBe(false)
}, 20_000)
