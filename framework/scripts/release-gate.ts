const RC = /^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$/
const STABLE = /^v[0-9]+\.[0-9]+\.[0-9]+$/

function fail(message: string): never {
  console.error(`release gate: ${message}`)
  process.exit(1)
}

function git(args: string[], stderr: 'inherit' | 'ignore' = 'inherit'): { ok: boolean; code: number; out: string } {
  const result = Bun.spawnSync(['git', ...args], { stdin: 'inherit', stdout: 'pipe', stderr })
  return { ok: result.exitCode === 0, code: result.exitCode ?? 1, out: result.stdout.toString().replace(/\n+$/, '') }
}

const tag = process.argv[2] || fail('usage: release-gate.ts <tag>')
const devRef = process.env.RELEASE_DEV_REF || 'origin/dev'
const mainRef = process.env.RELEASE_MAIN_REF || 'origin/main'

const toplevel = git(['rev-parse', '--show-toplevel'])
if (!toplevel.ok) process.exit(toplevel.code)
process.chdir(toplevel.out)

const revision = git(['rev-list', '-n', '1', tag], 'ignore')
if (!revision.ok) fail(`no tag ${tag}`)
const sha = revision.out

if (RC.test(tag)) {
  if (!git(['merge-base', '--is-ancestor', sha, devRef]).ok) fail(`${tag} is not on ${devRef}; tag release candidates on dev`)
  console.log('channel=rc')
} else if (STABLE.test(tag)) {
  if (!git(['merge-base', '--is-ancestor', sha, mainRef]).ok) fail(`${tag} is not on ${mainRef}; tag stable releases on main`)
  const rc = git(['tag', '-l', `${tag}-rc.*`, '--sort=-v:refname']).out.split('\n')[0] ?? ''
  if (!rc) fail(`no ${tag}-rc.N tag; publish ${tag}-rc.1 from dev and test it first`)
  const others = git(['diff', '--name-only', rc, sha, '--', '.', ':!framework/package.json']).out
  if (others) fail(`${tag} changes files since ${rc}: ${others.split('\n').join(' ')} - cut a new release candidate`)
  const edits = git(['diff', '-U0', rc, sha, '--', 'framework/package.json']).out.split('\n')
    .filter((line) => /^[-+]([^-+]|$)/.test(line))
    .filter((line) => !/^[-+]\s*"version": /.test(line))
  if (edits.length > 0) fail(`${tag} changes framework/package.json beyond the version since ${rc} - cut a new release candidate`)
  const stable = git(['tag', '-l', 'v*', '--sort=-v:refname']).out.split('\n').filter((name) => STABLE.test(name))
  const at = stable.indexOf(tag)
  const previous = at === -1 ? '' : stable[at + 1] ?? ''
  console.log('channel=stable')
  console.log(`rc=${rc}`)
  console.log(`previous=${previous}`)
} else {
  fail(`${tag} is neither vX.Y.Z nor vX.Y.Z-rc.N`)
}
