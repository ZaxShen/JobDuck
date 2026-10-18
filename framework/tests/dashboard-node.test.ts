import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type Sandbox, sandbox } from './helpers'

const root = join(import.meta.dir, '..')
const binary = join(root, 'dist', process.platform === 'win32' ? 'jobduck.exe' : 'jobduck')

const launchers = [
  { label: 'bun src/cli.ts', command: 'bun', args: [join(root, 'src', 'cli.ts')] },
  ...(existsSync(binary) ? [{ label: 'dist/jobduck', command: binary, args: [] }] : []),
]

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

for (const launcher of launchers) {
  test(`${launcher.label} serves the dashboard in a child process`, async () => {
    child = spawn(launcher.command, [...launcher.args, 'dashboard', '--port', '0', '--no-open', '--print-url'], {
      cwd: box.workspace,
      env: { ...process.env, JOBDUCK_HOME: box.home, HOME: box.userHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const url = await firstLine(child)
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const res = await fetch(`${url}/api/summary`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ counts: { saved: 0 }, needs_match: 0 })
    const page = await fetch(`${url}/`)
    expect(page.headers.get('content-security-policy')).toBe("default-src 'self'")
    expect(await page.text()).toContain('<html')

    const exited = new Promise<number | null>((resolve) => child!.on('exit', resolve))
    child.kill('SIGTERM')
    expect(await exited).toBe(0)
    child = undefined
  }, 20_000)
}
