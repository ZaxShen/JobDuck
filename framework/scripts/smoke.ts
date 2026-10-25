import { accessSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import type { Subprocess } from 'bun'
import { createChecks, isFile, lines, show } from './lib/check'

type Env = Record<string, string | undefined>

const root = resolve(import.meta.dir, '..')
const exe = process.platform === 'win32' ? '.exe' : ''
const binary = resolve(root, process.argv[2] ?? `dist/jobduck${exe}`)

function isExecutable(path: string): boolean {
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

if (!isExecutable(binary)) {
  console.error(`smoke: ${binary} is missing; run bun run build`)
  process.exit(1)
}

const sandbox = mkdtempSync(join(tmpdir(), 'jobduck-smoke-'))
const home = join(sandbox, 'home')
const jobduckHome = join(sandbox, 'jobduck-home')
const workspace = join(sandbox, 'workspace')
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
const env: Env = {
  ...process.env, HOME: home, USERPROFILE: home, JOBDUCK_HOME: jobduckHome,
  [pathKey]: `${dirname(binary)}${delimiter}${process.env[pathKey] ?? ''}`,
}

let dashboard: Subprocess | undefined
const cleanup = () => {
  dashboard?.kill()
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 })
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  process.on(signal, () => {
    cleanup()
    process.exit(code)
  })
}

class Aborted extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

const MCP_REQUESTS = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
].map((line) => `${line}\n`).join('')
const URL_LINE = /^http:\/\/127\.0\.0\.1:[0-9]+/

const read = (path: string): string => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
const entries = (dir: string): string[] => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
const skillPointers = (dir: string) => entries(dir).filter((name) => name.startsWith('jobduck-') && isFile(join(dir, name, 'SKILL.md'))).length
const contains = (needle: string, text: string) => text.includes(needle) || show(text)
const matches = (pattern: RegExp, text: string) => lines(text).some((line) => pattern.test(line))
const count = (pattern: RegExp, text: string, want: number) => lines(text).filter((line) => pattern.test(line)).length === want || show(text)

function run(log: string, args: string[], options: { env?: Env; cwd?: string } = {}): number {
  const fd = openSync(log, 'w')
  try {
    const result = Bun.spawnSync([binary, ...args], { cwd: options.cwd ?? root, env: options.env ?? env, stdin: 'inherit', stdout: fd, stderr: fd })
    return result.exitCode ?? 1
  } finally {
    closeSync(fd)
  }
}

function mustRun(log: string, args: string[], options: { env?: Env; cwd?: string } = {}): string {
  const code = run(log, args, options)
  if (code !== 0) {
    console.error(`--- ${[binary, ...args].join(' ')} exited ${code}`)
    process.stderr.write(read(log))
    throw new Aborted(1)
  }
  return read(log)
}

async function firstUrlLine(stream: ReadableStream<Uint8Array>, ms: number): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let timer: Timer | undefined
  const timeout = new Promise<undefined>((done) => {
    timer = setTimeout(done, ms)
  })
  let buffered = ''
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), timeout])
      if (!chunk || chunk.done) return ''
      buffered += decoder.decode(chunk.value, { stream: true })
      const line = lines(buffered.slice(0, buffered.lastIndexOf('\n') + 1)).find((entry) => URL_LINE.test(entry))
      if (line) return line.replace(/\r$/, '')
    }
  } finally {
    clearTimeout(timer)
    void (async () => {
      while (!(await reader.read()).done);
    })().catch(() => {})
  }
}

async function body(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.text()
}

const checks = createChecks()
const { check } = checks

try {
  mkdirSync(join(home, '.codex'), { recursive: true })
  mkdirSync(join(home, '.gemini'), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(home, '.claude.json'), '{}\n')
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "o4-mini"\n')
  writeFileSync(join(home, '.gemini', 'settings.json'), '{"theme":"Default"}\n')

  const versionRun = Bun.spawnSync([binary, '--version'], { cwd: root, env, stdin: 'inherit', stdout: 'pipe', stderr: 'inherit' })
  if (versionRun.exitCode !== 0) throw new Aborted(versionRun.exitCode ?? 1)
  const version = versionRun.stdout.toString().replace(/\n+$/, '')
  await check('--version prints a version', () => /^[0-9]+\.[0-9]+\.[0-9]+/.test(version))
  const help = Bun.spawnSync([binary, '--help'], { cwd: root, env, stdin: 'inherit', stdout: 'pipe', stderr: 'inherit' }).stdout.toString()
  await check('--help lists every command', () => ['init', 'doctor', 'mcp'].every((name) => help.includes(name)))

  const dry = mustRun(join(sandbox, 'dry.log'), ['init', '--dry-run', '--workspace', workspace])
  await check('init --dry-run exits 0', () => true)
  await check('dry run detects all hosts', () => contains('Hosts: Claude Code, Codex CLI, Gemini CLI', dry))
  await check('dry run groups skill pointers', () => contains('create .claude/skills/jobduck-*/SKILL.md (7 skill pointers)', dry))
  await check('dry run shows codex config under ~', () => contains('update ~/.codex/config.toml', dry))
  await check('dry run prints no unified diff', () => !matches(/^[-+@]{2,3} /, dry) || show(dry))
  await check('dry run stays short', () => (dry.match(/\n/g) ?? []).length <= 20)
  await check('dry run writes nothing', () => !existsSync(jobduckHome) && !existsSync(join(workspace, '.mcp.json')))

  const diff = mustRun(join(sandbox, 'diff.log'), ['init', '--dry-run', '--diff', '--workspace', workspace])
  await check('init --diff prints unified diffs', () => contains('+++ ', diff))

  const apply = mustRun(join(sandbox, 'apply.log'), ['init', '--yes', '--workspace', workspace])
  await check('init --yes exits 0', () => true)
  await check('init reports completion', () => contains('Done. Open your agent in this workspace', apply))
  await check('init points at profile intake', () => contains('jobduck dashboard --view profile', apply))
  await check('init creates document folders', () => ['inbox', 'cv', 'cover-letters'].every((name) => isDir(join(workspace, name))))
  await check('AGENTS.md carries the managed block', () => contains('<!-- jobduck:end -->', read(join(workspace, 'AGENTS.md'))))
  await check('home has profile, permissions and db', () => ['profile.md', 'permissions.toml', 'jobduck.db'].every((name) => isFile(join(jobduckHome, name))))
  await check('seven skills installed', () => {
    const skills = join(jobduckHome, 'skills')
    return entries(skills).filter((name) => name.endsWith('.md') && !name.startsWith('.')).length === 7 && isFile(join(skills, '.version'))
  })
  await check('claude: .mcp.json registers jobduck', () => contains('"jobduck"', read(join(workspace, '.mcp.json'))))
  await check('claude: AGENTS.md and CLAUDE.md pointer', () => isFile(join(workspace, 'AGENTS.md')) && read(join(workspace, 'CLAUDE.md')).includes('@AGENTS.md'))
  await check('claude: seven skill pointers', () => skillPointers(join(workspace, '.claude', 'skills')) === 7)
  const codexConfig = join(home, '.codex', 'config.toml')
  await check('codex: config.toml registers jobduck', () => contains('[mcp_servers.jobduck]', read(codexConfig)))
  await check('codex: existing config preserved', () => contains('model = "o4-mini"', read(codexConfig)))
  await check('codex: seven skill pointers', () => skillPointers(join(workspace, '.agents', 'skills')) === 7)
  const geminiSettings = join(home, '.gemini', 'settings.json')
  await check('gemini: settings.json registers jobduck', () => contains('"jobduck"', read(geminiSettings)))
  await check('gemini: existing settings preserved', () => contains('"theme"', read(geminiSettings)))
  await check('gemini: GEMINI.md pointer', () => contains('See AGENTS.md', read(join(workspace, 'GEMINI.md'))))

  const again = mustRun(join(sandbox, 'again.log'), ['init', '--yes', '--workspace', workspace])
  await check('second init is a no-op', () => contains('Nothing to do.', again))

  const doctor = mustRun(join(sandbox, 'doctor.log'), ['doctor', '--workspace', workspace])
  await check('doctor exits 0', () => true)
  await check('doctor has no FAIL line', () => !matches(/^FAIL/, doctor) || show(doctor))
  await check('doctor sees three registered hosts', () => count(/host .*: registered/, doctor, 3))
  const doctorJson = mustRun(join(sandbox, 'doctor.json'), ['doctor', '--json', '--workspace', workspace])
  await check('doctor --json reports ok', () => contains('"ok": true', doctorJson))

  const mcp = Bun.spawn([binary, 'mcp'], { cwd: root, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  mcp.stdin.write(MCP_REQUESTS)
  mcp.stdin.end()
  const [mcpOut, mcpErr, mcpCode] = await Promise.all([new Response(mcp.stdout).text(), new Response(mcp.stderr).text(), mcp.exited])
  if (mcpCode !== 0) {
    console.error(`--- jobduck mcp exited ${mcpCode}`)
    process.stderr.write(mcpErr)
    checks.fail()
  }
  await check('mcp answers with exactly two JSON-RPC lines', () => lines(mcpOut).filter((line) => line !== '').length === 2)
  await check('mcp initialize names the server', () => contains('"name":"jobduck"', mcpOut))
  await check('mcp tools/list includes search_jobs', () => contains('"search_jobs"', mcpOut))
  await check('mcp tools/list includes update_profile', () => contains('"update_profile"', mcpOut))
  await check('mcp stdout is JSON only', () => lines(mcpOut).every((line) => line === '' || line.startsWith('{')))

  dashboard = Bun.spawn([binary, 'dashboard', '--port', '0', '--print-url', '--no-open'], { cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  try {
    const url = await firstUrlLine(dashboard.stdout as ReadableStream<Uint8Array>, 10_000)
    await check('dashboard prints a loopback URL', () => url !== '')
    if (url) {
      await check('dashboard serves the page', async () => (await fetch(`${url}/`)).status === 200)
      await check('dashboard page loads app.js and style.css', async () => {
        const page = await body(`${url}/`)
        return page.includes('src="/app.js"') && page.includes('href="/style.css"')
      })
      await check('dashboard serves its embedded font', async () => {
        const font = (await body(`${url}/style.css`)).match(/\/geist-latin-wght-normal\.woff2/)?.[0]
        if (!font) return false
        const response = await fetch(`${url}${font}`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        return response.ok && /^font\/woff2/i.test(response.headers.get('content-type') ?? '') && new TextDecoder().decode(bytes.slice(0, 4)) === 'wOF2'
      })
      await check('dashboard API answers', async () => (await body(`${url}/api/summary`)).includes('{'))
      await check('dashboard serves the profile', async () => (await body(`${url}/api/profile`)).includes('"revision"'))
      await check('dashboard serves the permissions', async () => (await body(`${url}/api/permissions`)).includes('"modules"'))
      await check('dashboard refuses a PUT without its header', async () => {
        const response = await fetch(`${url}/api/profile`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        await response.body?.cancel()
        return response.status === 403
      })
    }
  } finally {
    dashboard.kill()
    await dashboard.exited
    dashboard = undefined
  }

  const localWorkspace = join(sandbox, 'local-workspace')
  const localEnv: Env = { ...env }
  delete localEnv.JOBDUCK_HOME
  mkdirSync(localWorkspace, { recursive: true })
  const local = mustRun(join(sandbox, 'local.log'), ['init', '--yes', '--no-dashboard', '--workspace', localWorkspace], { env: localEnv })
  await check('local: init keeps the home in the workspace', () => isFile(join(localWorkspace, '.jobduck', 'jobduck.db')) && isFile(join(localWorkspace, '.jobduck', '.gitignore')))
  await check('local: codex registers in the workspace', () => contains('JOBDUCK_HOME', read(join(localWorkspace, '.codex', 'config.toml'))))
  await check('local: gemini registers in the workspace', () => contains('JOBDUCK_HOME', read(join(localWorkspace, '.gemini', 'settings.json'))))
  await check('local: claude entry carries the home', () => contains('JOBDUCK_HOME', read(join(localWorkspace, '.mcp.json'))))
  await check('local: init names the codex trust step', () => contains('trusted projects', local))
  await check('local: global configs untouched', () => ![codexConfig, geminiSettings].some((path) => read(path).includes('local-workspace')))
  const deep = join(localWorkspace, 'cv', 'deep')
  mkdirSync(deep, { recursive: true })
  const localDoctor = join(sandbox, 'local-doctor.json')
  run(localDoctor, ['doctor', '--json'], { env: localEnv, cwd: deep })
  const localDoctorJson = read(localDoctor)
  await check('local: doctor finds the home from a subfolder', () => matches(/"home": ".*local-workspace.{1,2}\.jobduck"/, localDoctorJson) || show(localDoctorJson))

  const homeless = join(sandbox, 'homeless')
  mkdirSync(homeless, { recursive: true })
  const homelessDoctor = join(sandbox, 'homeless-doctor.log')
  const homelessDoctorCode = run(homelessDoctor, ['doctor'], { env: localEnv, cwd: homeless })
  const homelessDoctorLog = read(homelessDoctor)
  await check('no home: doctor exits non-zero', () => homelessDoctorCode !== 0 || show(homelessDoctorLog))
  await check('no home: doctor reports a failing home check', () => matches(/^FAIL home: No Job Duck home in /, homelessDoctorLog) || show(homelessDoctorLog))
  await check('no home: doctor still lists the hosts', () => count(/^ {5}host /, homelessDoctorLog, 3))
  const homelessMcp = Bun.spawnSync([binary, 'mcp'], { cwd: homeless, env: localEnv, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const homelessMcpErr = homelessMcp.stderr.toString()
  await check('no home: mcp exits 1', () => homelessMcp.exitCode === 1 || show(homelessMcpErr))
  await check('no home: mcp prints the error on stderr', () => contains('No Job Duck home in ', homelessMcpErr))
  await check('no home: mcp writes nothing to stdout', () => homelessMcp.stdout.toString() === '' || show(homelessMcp.stdout.toString()))
  await check('no home: nothing created', () => entries(homeless).length === 0 || show(entries(homeless).join('\n')))

  if (checks.failures > 0) {
    console.error(`smoke: ${checks.failures} check(s) failed`)
    process.exitCode = 1
  } else {
    console.log(`smoke: all checks passed (${version})`)
  }
} catch (error) {
  if (!(error instanceof Aborted)) throw error
  process.exitCode = error.code
} finally {
  cleanup()
}
