import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')

interface PackageJson {
  version?: string
  private?: boolean
  license?: string
  repository?: { directory?: string }
  bin?: unknown
  engines?: unknown
  publishConfig?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson

test('package.json is private, binary-only and has no native sqlite dependency', () => {
  expect(pkg.private).toBe(true)
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
  expect(pkg.license).toBe('MIT')
  expect(pkg.repository?.directory).toBe('framework')
  expect(pkg.bin).toBeUndefined()
  expect(pkg.engines).toBeUndefined()
  expect(pkg.publishConfig).toBeUndefined()
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
  expect(deps.filter((name) => name.includes('sqlite3'))).toEqual([])
})

test('LICENSE is the MIT license', () => {
  const license = join(root, 'LICENSE')
  expect(existsSync(license)).toBe(true)
  expect(readFileSync(license, 'utf8').startsWith('MIT License')).toBe(true)
})
