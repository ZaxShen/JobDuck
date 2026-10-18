import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { type Sandbox, sandbox } from './helpers'

const root = join(import.meta.dir, '..')
const cli = join(root, 'dist', 'cli.js')
const built = existsSync(cli)

function realNodeWithSqlite(candidate: string): string | undefined {
  const probe = spawnSync(candidate, ['-e', "require('better-sqlite3')(':memory:').close(); process.stdout.write(process.execPath)"],
    { cwd: root, encoding: 'utf8' })
  return probe.status === 0 && probe.stdout ? probe.stdout : undefined
}

const nodeBinaries = [...new Set((process.env.PATH ?? '').split(delimiter).filter(Boolean)
  .map((dir) => join(dir, process.platform === 'win32' ? 'node.exe' : 'node')).filter(existsSync))]
const node = built ? nodeBinaries.map(realNodeWithSqlite).find(Boolean) : undefined

if (!built) console.warn(`dashboard-node.test.ts skipped: ${cli} is missing; run \`bun run build\` first`)
else if (!node) {
  console.warn(`dashboard-node.test.ts skipped: no node on PATH can load better-sqlite3 (tried ${nodeBinaries.join(', ') || 'none'}); `
    + 'rebuild it for your Node with `npm rebuild better-sqlite3`')
}

let box: Sandbox
let child: ChildProcess | undefined
beforeEach(() => { box = sandbox() })
afterEach(() => {
  child?.kill('SIGKILL')
  box.cleanup()
})

function firstLine(proc: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline >= 0) resolve(buffer.slice(0, newline).trim())
    })
    proc.on('exit', (code) => reject(new Error(`dashboard exited with ${code}: ${stderr}`)))
  })
}

test.skipIf(!node)('the built CLI serves the dashboard under Node', async () => {
  child = spawn(node!, [cli, 'dashboard', '--port', '0', '--no-open', '--print-url'], {
    env: { ...process.env, JOBDUCK_HOME: box.home, HOME: box.userHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const url = await firstLine(child)
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  const res = await fetch(`${url}/api/summary`)
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ counts: { saved: 0 }, needs_match: 0 })
  expect((await fetch(`${url}/`)).headers.get('content-security-policy')).toBe("default-src 'self'")

  const exited = new Promise<number | null>((resolve) => child!.on('exit', resolve))
  child.kill('SIGTERM')
  expect(await exited).toBe(0)
  child = undefined
}, 20_000)
