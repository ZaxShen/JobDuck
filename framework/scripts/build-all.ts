import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const dist = join(root, 'dist')
const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'windows-x64']

mkdirSync(dist, { recursive: true })

const assets = TARGETS.map((target) => {
  const name = `jobduck-${target}${target.startsWith('windows-') ? '.exe' : ''}`
  const build = Bun.spawnSync(['bun', 'build', '--compile', `--target=bun-${target}`, 'src/cli.ts', '--outfile', `dist/${name}`], {
    cwd: root, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
  })
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)
  return name
})

const sums = assets.map((name) => `${createHash('sha256').update(readFileSync(join(dist, name))).digest('hex')}  ${name}\n`).join('')
writeFileSync(join(dist, 'SHA256SUMS'), sums)
process.stdout.write(sums)
