import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createChecks, isFile, show } from './lib/check'

const root = resolve(import.meta.dir, '..')
const api = process.env.JOBDUCK_DEV_API_PORT || '4859'
const web = process.env.JOBDUCK_DEV_WEB_PORT || '5174'
const sandbox = mkdtempSync(join(tmpdir(), 'jobduck-dev-smoke-'))
const log = join(sandbox, 'dev.log')
const home = join(sandbox, 'home')
const base = `http://127.0.0.1:${web}`
const STOP_GRACE_MS = 5000

const logFd = openSync(log, 'w')
const dev = spawn('bun', ['scripts/dev.ts'], {
  cwd: root,
  detached: process.platform !== 'win32',
  stdio: ['ignore', logFd, logFd],
  env: { ...process.env, JOBDUCK_HOME: home, JOBDUCK_DEV_API_PORT: api, JOBDUCK_DEV_WEB_PORT: web },
})
closeSync(logFd)

let running = true
const exited = new Promise<void>((done) => {
  dev.once('error', () => done())
  dev.once('exit', () => done())
}).then(() => {
  running = false
})

const signalGroup = (signal: NodeJS.Signals) => {
  try {
    process.kill(-dev.pid!, signal)
  } catch {}
}

async function stop(): Promise<void> {
  if (dev.pid !== undefined) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(dev.pid)], { stdio: 'ignore' })
    } else {
      signalGroup('SIGTERM')
      await Promise.race([exited, Bun.sleep(STOP_GRACE_MS)])
      signalGroup('SIGKILL')
    }
    await Promise.race([exited, Bun.sleep(STOP_GRACE_MS)])
  }
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 })
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  process.on(signal, () => {
    void stop().finally(() => process.exit(code))
  })
}

const devLog = () => readFileSync(log, 'utf8')

async function up(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(STOP_GRACE_MS) })
    await response.body?.cancel()
    return response.status < 400
  } catch {
    return false
  }
}

let last = ''
async function expect(want: number, url: string, init?: RequestInit): Promise<boolean> {
  const response = await fetch(url, init)
  last = await response.text()
  if (response.status === want) return true
  console.error(`     | expected ${want}, got ${response.status}: ${last}`)
  return false
}

function bodyHas(needle: string): boolean {
  if (last.includes(needle)) return true
  console.error(`     | missing ${needle} in: ${last}`)
  return false
}

try {
  const deadline = Date.now() + 60_000
  const serving = async () => (await up(`${base}/`)) && (await up(`${base}/api/summary`))
  let ready = await serving()
  while (!ready && running && Date.now() < deadline) {
    await Bun.sleep(500)
    ready = await serving()
  }
  if (!ready) {
    console.error(`dev-smoke: dev loop did not come up on ${base}`)
    show(devLog())
    process.exitCode = 1
  } else {
    const checks = createChecks()
    const { check } = checks

    await check('GET / through Vite serves the app', async () => (await expect(200, `${base}/`)) && bodyHas('id="root"'))
    await check('GET /api/applications through Vite returns seeded data', async () => (await expect(200, `${base}/api/applications`)) && bodyHas('Acme'))

    const id = last.match(/[{,]"id":([0-9]+)/)?.[1]
    const patch = async (want: number, origin: string) => {
      if (!id) {
        console.error('     | no application id in the listing')
        return false
      }
      return expect(want, `${base}/api/applications/${id}`, {
        method: 'PATCH',
        headers: { Origin: origin, 'X-JobDuck-Dashboard': '1', 'Content-Type': 'application/json' },
        body: '{"note":"dev-smoke note"}',
      })
    }
    await check('PATCH from the dev origin is saved', () => patch(200, base))
    await check('PATCH from a foreign origin is refused', () => patch(403, 'https://evil.example'))

    await check('GET /api/applications from a foreign origin gets no CORS header', async () => {
      const response = await fetch(`${base}/api/applications`, { headers: { Origin: 'http://localhost:9999' } })
      await response.body?.cancel()
      if (!response.headers.has('access-control-allow-origin')) return true
      const headers = [...response.headers].map(([name, value]) => `${name}: ${value}`).join('\n')
      console.error(`     | CORS header sent to a foreign origin: ${headers}`)
      return false
    })
    await check('the sandbox home has jobduck.db', () => isFile(join(home, 'jobduck.db')))

    if (checks.failures > 0) {
      console.error(`dev-smoke: ${checks.failures} check(s) failed`)
      show(devLog())
      process.exitCode = 1
    } else {
      console.log('dev-smoke: all checks passed')
    }
  }
} finally {
  await stop()
}
