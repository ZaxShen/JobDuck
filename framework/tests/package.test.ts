import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')

interface PackageJson {
  license?: string
  repository?: { directory?: string }
  files?: string[]
  bin?: Record<string, string>
  engines?: { node?: string }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson

test('package.json carries the publish metadata', () => {
  expect(pkg.license).toBe('MIT')
  expect(pkg.repository?.directory).toBe('framework')
  expect(pkg.files).toContain('LICENSE')
  expect(pkg.files).toContain('README.md')
  expect(pkg.bin?.jobduck).toBe('dist/cli.js')
  expect(pkg.engines?.node).toBe('>=20')
})

test('LICENSE is the MIT license', () => {
  const license = join(root, 'LICENSE')
  expect(existsSync(license)).toBe(true)
  expect(readFileSync(license, 'utf8').startsWith('MIT License')).toBe(true)
})
