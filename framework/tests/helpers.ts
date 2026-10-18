import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Db, openDb } from '../src/db/client'
import { migrate } from '../src/db/migrate'
import { dbPath } from '../src/paths'

export interface Sandbox {
  root: string
  home: string
  workspace: string
  userHome: string
  cleanup(): void
}

export function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'jobduck-test-'))
  const home = join(root, 'jobduck-home')
  const workspace = join(root, 'workspace')
  const userHome = join(root, 'user-home')
  mkdirSync(workspace)
  mkdirSync(userHome)
  process.env.JOBDUCK_HOME = home
  return { root, home, workspace, userHome, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

export function migratedDb(home: string): Db {
  mkdirSync(home, { recursive: true })
  const db = openDb(dbPath(home))
  migrate(db)
  return db
}

export function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      if (statSync(path).isDirectory()) {
        files[`${path}/`] = ''
        walk(path)
      } else {
        files[path] = readFileSync(path, 'utf8')
      }
    }
  }
  walk(dir)
  return files
}
