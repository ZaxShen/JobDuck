import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createApplication, listApplications, setStatus, type ApplicationStatus } from '../src/db/applications'
import { openDb } from '../src/db/client'
import { migrate } from '../src/db/migrate'
import { upsertPosting } from '../src/db/postings'
import { dbPath } from '../src/paths'

const root = resolve(import.meta.dir, '..')
const web = join(root, 'web')
const home = resolve(process.env.JOBDUCK_HOME ?? join(root, '.dev', 'home'))
const workspace = join(root, '.dev', 'workspace')

function port(name: string, fallback: number): number {
  const raw = process.env[name] ?? String(fallback)
  const value = Number(raw)
  if (!/^\d+$/.test(raw) || value < 1 || value > 65535) {
    console.error(`dev: invalid ${name}: ${raw}`)
    process.exit(1)
  }
  return value
}

const apiPort = port('JOBDUCK_DEV_API_PORT', 4858)
const webPort = port('JOBDUCK_DEV_WEB_PORT', 5173)
const apiUrl = `http://127.0.0.1:${apiPort}`
const webUrl = `http://127.0.0.1:${webPort}`

const SEED: { company: string; title: string; slug: string; location: string; status: ApplicationStatus }[] = [
  { company: 'Acme', title: 'Software Engineer', slug: 'acme-software-engineer', location: 'Remote', status: 'saved' },
  { company: 'Example Corp', title: 'Backend Developer', slug: 'example-corp-backend-developer', location: 'Springfield', status: 'applied' },
  { company: 'Globex', title: 'Platform Engineer', slug: 'globex-platform-engineer', location: 'Cypress Creek', status: 'interviewing' },
]

function seed(): void {
  const db = openDb(dbPath(home))
  try {
    migrate(db)
    if (listApplications(db).length > 0) return
    for (const entry of SEED) {
      const posting = upsertPosting(db, {
        source: 'manual', url: `https://example.com/jobs/${entry.slug}`, title: entry.title, company: entry.company, location: entry.location,
      })
      const application = createApplication(db, { postingId: posting.id, source: 'user', note: 'Placeholder application seeded by bun run dev' })
      if (entry.status !== 'saved') setStatus(db, application.id, entry.status, { source: 'user' })
    }
  } finally {
    db.close()
  }
}

mkdirSync(home, { recursive: true, mode: 0o700 })
mkdirSync(workspace, { recursive: true })

if (!existsSync(join(web, 'node_modules'))) {
  const install = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: web, stdio: 'inherit' })
  if (install.status !== 0) process.exit(install.status ?? 1)
}

seed()

const children: ChildProcess[] = [
  spawn('bun', ['--watch', 'run', 'src/cli.ts', 'dashboard', '--port', String(apiPort), '--no-open', '--workspace', workspace], {
    cwd: root, stdio: 'inherit', env: { ...process.env, JOBDUCK_HOME: home },
  }),
  spawn('bun', ['run', 'dev'], {
    cwd: web, stdio: 'inherit', env: { ...process.env, JOBDUCK_API_TARGET: apiUrl, JOBDUCK_DEV_WEB_PORT: String(webPort) },
  }),
]

console.log(`dev: web ${webUrl}  api ${apiUrl}  home ${home}`)

const STOP_GRACE_MS = 3000
let stopping = false
const alive = () => children.filter((child) => child.exitCode === null && child.signalCode === null)
const stopAll = (signal: NodeJS.Signals) => {
  for (const child of alive()) child.kill(signal)
  setTimeout(() => {
    for (const child of alive()) child.kill('SIGKILL')
  }, STOP_GRACE_MS).unref()
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true
    stopAll(signal)
  })
}

const exits = children.map((child) => new Promise<number>((done) => {
  child.on('error', () => done(1))
  child.on('exit', (code) => done(code ?? 1))
}))

const first = await Promise.race(exits)
if (!stopping) stopAll('SIGTERM')
await Promise.all(exits)
process.exit(stopping ? 0 : first || 1)
