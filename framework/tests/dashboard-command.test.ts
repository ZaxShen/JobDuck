import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { type Sandbox, migratedDb, sandbox } from './helpers'
import { type DashboardRecord, launchDashboard, liveDashboard, runDashboard } from '../src/commands/dashboard'
import { DEFAULT_PORT, startDashboard } from '../src/dashboard/server'
import { dashboardStatePath, ensureHome } from '../src/paths'

let box: Sandbox
let lines: string[]
const out = (line: string) => { lines.push(line) }
const quiet = () => undefined

beforeEach(() => {
  box = sandbox()
  lines = []
})
afterEach(() => box.cleanup())

function stopper() {
  let stop = () => undefined as void
  const stopped = new Promise<void>((resolve) => { stop = resolve })
  return { stop, stopped }
}

async function waitForRecord(home: string): Promise<DashboardRecord> {
  for (let i = 0; i < 100; i++) {
    const record = await liveDashboard(home)
    if (record) return record
    await Bun.sleep(20)
  }
  throw new Error('dashboard.json never appeared')
}

test('a foreground dashboard records itself in dashboard.json and removes it on close', async () => {
  const { stop, stopped } = stopper()
  const running = runDashboard({ home: box.home, workspace: box.workspace, port: 0, open: false, stop: stopped, out, err: quiet })
  const record = await waitForRecord(box.home)
  expect(record).toMatchObject({ pid: process.pid, workspace: box.workspace })
  expect(record.port).toBeGreaterThan(0)
  expect(record.url).toBe(`http://127.0.0.1:${record.port}`)
  expect(statSync(dashboardStatePath(box.home)).mode & 0o777).toBe(0o600)
  expect(lines).toContain(`Dashboard: ${record.url}`)
  stop()
  expect(await running).toBe(0)
  expect(existsSync(dashboardStatePath(box.home))).toBe(false)
})

test('--background reuses a live recorded dashboard without spawning', async () => {
  const dash = await startDashboard({ home: box.home, port: 0, open: false, out: quiet })
  try {
    const record: DashboardRecord = { pid: 1, port: dash.port, url: dash.url, workspace: box.workspace }
    writeFileSync(dashboardStatePath(box.home), JSON.stringify(record))
    const opened: string[] = []
    let spawned = 0
    const code = await runDashboard({
      home: box.home, workspace: box.workspace, background: true, view: 'welcome',
      openBrowser: (url) => { opened.push(url) }, spawn: () => { spawned++; return {} }, out, err: quiet,
    })
    expect(code).toBe(0)
    expect(spawned).toBe(0)
    expect(opened).toEqual([`${dash.url}/#welcome`])
    expect(lines).toEqual([`Dashboard: ${dash.url}/#welcome`])
  } finally {
    await dash.close()
  }
})

test('--background --no-open reuses the dashboard without opening a browser', async () => {
  const dash = await startDashboard({ home: box.home, port: 0, open: false, out: quiet })
  try {
    writeFileSync(dashboardStatePath(box.home), JSON.stringify({ pid: 1, port: dash.port, url: dash.url, workspace: box.workspace }))
    const opened: string[] = []
    const code = await runDashboard({
      home: box.home, workspace: box.workspace, background: true, open: false, view: 'welcome',
      openBrowser: (url) => { opened.push(url) }, spawn: () => ({}), out, err: quiet,
    })
    expect(code).toBe(0)
    expect(opened).toEqual([])
    expect(lines).toEqual([`Dashboard: ${dash.url}/#welcome`])
  } finally {
    await dash.close()
  }
})

test('--background restarts a live dashboard that serves another workspace', async () => {
  const other = join(box.root, 'other-workspace')
  const old = await startDashboard({ home: box.home, workspace: other, port: 0, open: false, out: quiet })
  const stale: DashboardRecord = { pid: 1, port: old.port, url: old.url, workspace: other }
  writeFileSync(dashboardStatePath(box.home), JSON.stringify(stale))
  const { stop, stopped } = stopper()
  const stoppedRecords: DashboardRecord[] = []
  const errors: string[] = []
  let child: Promise<number> | undefined
  const code = await runDashboard({
    home: box.home, workspace: box.workspace, background: true, openBrowser: quiet,
    stopDashboard: async (record) => { stoppedRecords.push(record); await old.close() },
    spawn: (_command, args) => {
      expect(args.slice(-2)).toEqual(['--workspace', box.workspace])
      child = runDashboard({ home: box.home, workspace: box.workspace, port: 0, open: false, stop: stopped, out: quiet, err: quiet })
      return { pid: process.pid }
    },
    out, err: (line) => { errors.push(line) },
  })
  try {
    expect(code).toBe(0)
    expect(stoppedRecords).toEqual([stale])
    expect(errors).toEqual([`Restarting the dashboard for ${box.workspace} (it was serving ${other}).`])
    expect(child).toBeDefined()
    expect((await liveDashboard(box.home))?.workspace).toBe(box.workspace)
  } finally {
    stop()
    await child
  }
}, 10_000)

test('a dashboard for another workspace that will not stop fails the launch instead of spawning a second one', async () => {
  const other = join(box.root, 'other-workspace')
  const old = await startDashboard({ home: box.home, workspace: other, port: 0, open: false, out: quiet })
  try {
    writeFileSync(dashboardStatePath(box.home), JSON.stringify({ pid: 1, port: old.port, url: old.url, workspace: other }))
    let spawned = 0
    await expect(launchDashboard({
      home: box.home, workspace: box.workspace, openBrowser: quiet, timeoutMs: 300,
      stopDashboard: () => undefined, spawn: () => { spawned++; return {} },
    })).rejects.toThrow(`serves ${other} and did not stop`)
    expect(spawned).toBe(0)
  } finally {
    await old.close()
  }
})

test('--background starts a detached dashboard when none is live and waits for it', async () => {
  ensureHome(box.home)
  writeFileSync(dashboardStatePath(box.home), JSON.stringify({ pid: 1, port: 9, url: 'http://127.0.0.1:9', workspace: box.workspace }))
  const { stop, stopped } = stopper()
  const spawns: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = []
  let child: Promise<number> | undefined
  const opened: string[] = []
  const code = await runDashboard({
    home: box.home, workspace: box.workspace, background: true, view: 'profile',
    openBrowser: (url) => { opened.push(url) },
    spawn: (command, args, env) => {
      spawns.push({ command, args, env })
      child = runDashboard({ home: box.home, workspace: box.workspace, port: 0, open: false, stop: stopped, out: quiet, err: quiet })
      return { pid: process.pid }
    },
    out, err: quiet,
  })
  try {
    expect(code).toBe(0)
    expect(spawns).toHaveLength(1)
    expect(spawns[0]!.command).toBe(process.execPath)
    expect(spawns[0]!.args.slice(-4)).toEqual(['dashboard', '--no-open', '--workspace', box.workspace])
    expect(spawns[0]!.env.JOBDUCK_HOME).toBe(box.home)
    const record = JSON.parse(readFileSync(dashboardStatePath(box.home), 'utf8')) as DashboardRecord
    expect(opened).toEqual([`${record.url}/#profile`])
    expect(lines).toEqual([`Dashboard: ${record.url}/#profile`])
  } finally {
    stop()
    await child
  }
}, 10_000)

test('--background fails when the spawned dashboard never answers', async () => {
  const errors: string[] = []
  const code = await runDashboard({
    home: box.home, background: true, spawn: () => ({ pid: 123 }), openBrowser: quiet, out, err: (line) => { errors.push(line) },
  })
  expect(code).toBe(1)
  expect(errors[0]).toContain('did not start within 5s')
}, 10_000)

test('the default port falls back to a free one when 4848 is taken by something else', async () => {
  const squatter = createServer()
  const bound = await new Promise<boolean>((resolve) => {
    squatter.once('error', () => resolve(false))
    squatter.listen(DEFAULT_PORT, '127.0.0.1', () => resolve(true))
  })
  try {
    const { stop, stopped } = stopper()
    const running = runDashboard({ home: box.home, workspace: box.workspace, open: false, stop: stopped, out, err: quiet })
    const record = await waitForRecord(box.home)
    expect(record.port).not.toBe(DEFAULT_PORT)
    stop()
    expect(await running).toBe(0)
    if (bound) {
      await expect(runDashboard({ home: box.home, port: DEFAULT_PORT, open: false, out, err: quiet })).rejects.toThrow()
    }
  } finally {
    await new Promise<void>((resolve) => (bound ? squatter.close(() => resolve()) : resolve()))
  }
})

test('a dashboard started from a subfolder of a workspace home serves and records the folder that holds .jobduck/', async () => {
  delete process.env.JOBDUCK_HOME
  const home = join(box.workspace, '.jobduck')
  migratedDb(home).close()
  const cv = join(box.workspace, 'cv')
  mkdirSync(cv)

  const { stop, stopped } = stopper()
  const running = runDashboard({ workspace: cv, port: 0, open: false, stop: stopped, out, err: quiet })
  try {
    const record = await waitForRecord(home)
    expect(record.workspace).toBe(box.workspace)
    let spawned = 0
    const page = await launchDashboard({ workspace: cv, open: false, spawn: () => { spawned++; return {} } })
    expect(page).toBe(record.url)
    expect(spawned).toBe(0)
  } finally {
    stop()
    expect(await running).toBe(0)
  }

  const spawns: string[][] = []
  await expect(launchDashboard({
    workspace: cv, open: false, timeoutMs: 300, spawn: (_command, args) => { spawns.push(args); return { pid: 123 } },
  })).rejects.toThrow('did not start')
  expect(spawns[0]!.slice(-2)).toEqual(['--workspace', box.workspace])
}, 10_000)
