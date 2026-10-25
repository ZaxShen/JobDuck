import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/

export function devVersion(pkgVersion: string, n: number, pr?: number): string {
  const match = VERSION.exec(pkgVersion)
  if (!match) throw new Error(`package.json version ${pkgVersion} is not X.Y.Z or X.Y.Z-<pre>`)
  if (!Number.isInteger(n) || n < 0) throw new Error(`commit count ${n} is not a non-negative integer`)
  if (pr !== undefined && (!Number.isInteger(pr) || pr < 1)) throw new Error(`PR ${pr} is not a positive integer`)
  const [, major, minor, patch, pre] = match
  const core = pre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${Number(patch) + 1}`
  return `${core}-dev.${n}${pr === undefined ? '' : `.gh${pr}`}`
}

function git(args: string[], cwd?: string): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString().trim()}`)
  return result.stdout.toString().trim()
}

export function lastStableTag(cwd?: string): string | undefined {
  const parts = (tag: string) => STABLE_TAG.exec(tag)!.slice(1).map(Number)
  return git(['tag', '-l', 'v*'], cwd).split('\n')
    .filter((tag) => STABLE_TAG.test(tag))
    .sort((a, b) => {
      const [x, y] = [parts(a), parts(b)]
      return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!
    })
    .at(-1)
}

export function commitsSinceStable(ref = 'HEAD', cwd?: string): number {
  const last = lastStableTag(cwd)
  return Number(git(['rev-list', '--first-parent', '--count', last ? `${last}..${ref}` : ref], cwd))
}

function fail(message: string): never {
  console.error(`dev-version: ${message}`)
  process.exit(1)
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { pr: { type: 'string' }, ref: { type: 'string', default: 'HEAD' } } })
    if (values.pr !== undefined && !/^[1-9]\d*$/.test(values.pr)) fail(`--pr ${values.pr} is not a positive integer`)
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as { version: string }
    const n = commitsSinceStable(values.ref)
    console.log(devVersion(pkg.version, n, values.pr === undefined ? undefined : Number(values.pr)))
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}
