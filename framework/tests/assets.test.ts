import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DASHBOARD, DASHBOARD_FILES, MIGRATIONS, SKILLS, TEMPLATES } from '../src/assets'

const root = join(import.meta.dir, '..')
const filesIn = (dir: string) => readdirSync(join(root, dir)).sort()
const read = (dir: string, name: string) => readFileSync(join(root, dir, name), 'utf8')

test('every skill on disk is embedded byte-identical', () => {
  const names = filesIn('skills').filter((file) => file.endsWith('.md'))
  expect(Object.keys(SKILLS).sort()).toEqual(names.map((file) => file.slice(0, -3)))
  for (const file of names) expect(SKILLS[file.slice(0, -3)]).toBe(read('skills', file))
})

test('every template on disk is embedded byte-identical', () => {
  const names = filesIn('templates')
  expect(Object.keys(TEMPLATES).sort()).toEqual(names)
  for (const file of names) expect(TEMPLATES[file]).toBe(read('templates', file))
})

test('every migration on disk is embedded byte-identical and in order', () => {
  const names = filesIn('src/db/migrations')
  expect(MIGRATIONS.map((m) => m.name)).toEqual(names)
  for (const migration of MIGRATIONS) expect(migration.sql).toBe(read('src/db/migrations', migration.name))
})

test('every dashboard file on disk is embedded byte-identical', () => {
  const names = filesIn('src/dashboard/public')
  const isBinary = (file: string) => /\.(woff2|ico|png)$/.test(file)
  const text = names.filter((file) => !isBinary(file))
  const binary = names.filter(isBinary)
  expect(Object.keys(DASHBOARD).sort()).toEqual(text)
  for (const file of text) expect(DASHBOARD[file]).toBe(read('src/dashboard/public', file))
  expect(Object.keys(DASHBOARD_FILES).sort()).toEqual(binary)
  for (const file of binary) {
    expect(readFileSync(DASHBOARD_FILES[file]!).equals(readFileSync(join(root, 'src/dashboard/public', file)))).toBe(true)
  }
})
