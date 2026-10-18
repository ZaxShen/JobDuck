import { createHash } from 'node:crypto'
import type { z } from 'zod'
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export class RevisionConflict extends Error {}

export const revisionOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)

export function readOr(path: string, fallback: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : fallback
}

export function checkRevision(file: string, text: string, revision: string | undefined): void {
  if (revision !== undefined && revision !== revisionOf(text)) {
    throw new RevisionConflict(`${file} changed since it was loaded; reload to see the latest version`)
  }
}

export function writePrivateFile(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, text, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, path)
}

export function parseOrExplain<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const issue = result.error.issues[0]!
  const keys = 'keys' in issue && Array.isArray(issue.keys) ? `: ${issue.keys.join(', ')}` : ''
  throw new Error(`${what} ${issue.path.join('.') || 'value'}: ${issue.message}${keys}`)
}
