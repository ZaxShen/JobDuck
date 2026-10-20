import { spawn } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DASHBOARD_HOST, DASHBOARD_VIEWS, DEFAULT_PORT, type Dashboard, type DashboardView, openBrowser, pageUrl, startDashboard,
} from '../dashboard/server'
import { dashboardStatePath, jobduckHome } from '../paths'

export interface DashboardRecord {
  pid: number
  port: number
  url: string
  workspace: string
}

export type Spawner = (command: string, args: string[], env: NodeJS.ProcessEnv) => { pid?: number }
export type Stopper = (record: DashboardRecord) => void | Promise<void>

export interface BackgroundOptions {
  home?: string
  workspace?: string
  view?: DashboardView
  port?: number
  open?: boolean
  openBrowser?: (url: string) => void
  spawn?: Spawner
  stopDashboard?: Stopper
  timeoutMs?: number
  out?: (line: string) => void
}

export interface DashboardCommandOptions {
  port?: string | number
  open?: boolean
  printUrl?: boolean
  view?: string
  home?: string
  workspace?: string
  background?: boolean
  openBrowser?: (url: string) => void
  spawn?: Spawner
  stopDashboard?: Stopper
  stop?: Promise<void>
  out?: (line: string) => void
  err?: (line: string) => void
}

const PROBE_MS = 1000
const START_MS = 5000

function readRecord(home: string): DashboardRecord | null {
  const path = dashboardStatePath(home)
  if (!existsSync(path)) return null
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as Partial<DashboardRecord>
    const valid = Number.isInteger(record.pid) && Number.isInteger(record.port) && typeof record.workspace === 'string'
      && record.url === `http://${DASHBOARD_HOST}:${record.port}`
    return valid ? record as DashboardRecord : null
  } catch {
    return null
  }
}

async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/summary`, { signal: AbortSignal.timeout(PROBE_MS) })
    return res.ok
  } catch {
    return false
  }
}

export async function liveDashboard(home: string, pid?: number): Promise<DashboardRecord | null> {
  const record = readRecord(home)
  if (!record || (pid !== undefined && record.pid !== pid)) return null
  return (await answers(record.url)) ? record : null
}

function writeRecord(home: string, dashboard: Dashboard, workspace: string): void {
  const path = dashboardStatePath(home)
  const record: DashboardRecord = { pid: process.pid, port: dashboard.port, url: dashboard.url, workspace }
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

function removeRecord(home: string): void {
  if (readRecord(home)?.pid === process.pid) rmSync(dashboardStatePath(home), { force: true })
}

export function selfCommand(): string[] {
  const script = process.argv[1]
  return script && /\.(ts|js)$/.test(script) ? [process.execPath, script] : [process.execPath]
}

const spawnDetached: Spawner = (command, args, env) => {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', env })
  child.on('error', () => undefined)
  child.unref()
  return { pid: child.pid }
}

const terminate: Stopper = (record) => {
  process.kill(record.pid, 'SIGTERM')
}

async function replaceDashboard(record: DashboardRecord, stop: Stopper, timeoutMs: number): Promise<void> {
  await Promise.resolve().then(() => stop(record)).catch(() => undefined)
  const deadline = Date.now() + timeoutMs
  while (await answers(record.url)) {
    if (Date.now() >= deadline) {
      throw new Error(`the dashboard at ${record.url} serves ${record.workspace} and did not stop; stop it and retry`)
    }
    await Bun.sleep(100)
  }
}

export async function launchDashboard(options: BackgroundOptions = {}): Promise<string> {
  const home = options.home ?? jobduckHome()
  const workspace = resolve(options.workspace ?? process.cwd())
  const timeoutMs = options.timeoutMs ?? START_MS
  const browse = options.openBrowser ?? ((url: string) => openBrowser(url))
  const show = (record: DashboardRecord) => {
    const page = pageUrl(record.url, options.view)
    if (options.open !== false) browse(page)
    return page
  }

  const running = await liveDashboard(home)
  if (running?.workspace === workspace) return show(running)
  if (running) {
    options.out?.(`Restarting the dashboard for ${workspace} (it was serving ${running.workspace}).`)
    await replaceDashboard(running, options.stopDashboard ?? terminate, timeoutMs)
  }

  const [command, ...script] = selfCommand()
  const args = [...script, 'dashboard', '--no-open', '--workspace', workspace]
  if (options.port !== undefined) args.push('--port', String(options.port))
  const { pid } = (options.spawn ?? spawnDetached)(command!, args, { ...process.env, JOBDUCK_HOME: home })

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await Bun.sleep(100)
    const started = await liveDashboard(home, pid)
    if (started) return show(started)
  }
  throw new Error(`the dashboard did not start within ${timeoutMs / 1000}s; run jobduck dashboard to see why`)
}

function waitForSignal(): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      resolve()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}

const inUse = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE'

export async function runDashboard(options: DashboardCommandOptions = {}): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line))
  const err = options.err ?? ((line: string) => console.error(line))
  const explicitPort = options.port !== undefined
  const raw = String(options.port ?? DEFAULT_PORT)
  const port = Number(raw)
  if (!/^\d+$/.test(raw) || port > 65535) {
    err(`invalid --port: ${options.port}`)
    return 1
  }
  if (options.view !== undefined && !(DASHBOARD_VIEWS as readonly string[]).includes(options.view)) {
    err(`invalid --view: ${options.view} (expected ${DASHBOARD_VIEWS.join(', ')})`)
    return 1
  }
  const view = options.view as DashboardView | undefined
  const home = options.home ?? jobduckHome()
  const workspace = resolve(options.workspace ?? process.cwd())

  if (options.background) {
    try {
      const page = await launchDashboard({
        home, workspace, view, port: explicitPort ? port : undefined, open: options.open,
        openBrowser: options.openBrowser, spawn: options.spawn, stopDashboard: options.stopDashboard, out: err,
      })
      out(options.printUrl ? page : `Dashboard: ${page}`)
      return 0
    } catch (error) {
      err(error instanceof Error ? error.message : String(error))
      return 1
    }
  }

  const start = (listen: number) => startDashboard({ home, workspace, port: listen, open: options.open ?? true, view, out: err })
  let dashboard: Dashboard
  try {
    dashboard = await start(port)
  } catch (error) {
    if (explicitPort || !inUse(error)) throw error
    dashboard = await start(0)
  }
  writeRecord(home, dashboard, workspace)
  const page = pageUrl(dashboard.url, view)
  out(options.printUrl ? page : `Dashboard: ${page}`)
  if (!options.printUrl) out('Press Ctrl+C to stop.')
  try {
    await (options.stop ?? waitForSignal())
  } finally {
    removeRecord(home)
    await dashboard.close()
  }
  return 0
}
