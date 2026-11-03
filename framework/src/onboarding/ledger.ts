import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { parseOrExplain, writePrivateFile } from '../config/files'

export const IMPORTS_FILE = 'imports.json'
export const INBOX_DIR = 'inbox'
export const IMPORT_EXTENSIONS = ['.pdf', '.docx', '.doc', '.md', '.txt', '.zip', '.csv'] as const
export const ROOT_IMPORT_EXTENSIONS = ['.pdf', '.docx'] as const

const Entry = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string(),
  imported_at: z.string(),
})
const Ledger = z.object({ imports: z.array(Entry).default(() => []) })

export type LedgerEntry = z.infer<typeof Entry>

export interface ImportCandidate {
  path: string
  name: string
  sha256: string
}

export interface ImportedCandidate extends ImportCandidate {
  imported_at: string
}

export interface ImportScan {
  pending: ImportCandidate[]
  imported: ImportedCandidate[]
}

export const importsPath = (home: string) => join(home, IMPORTS_FILE)

export const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export const sha256File = (path: string) => sha256Of(readFileSync(path))

export function readLedger(home: string): LedgerEntry[] {
  const path = importsPath(home)
  if (!existsSync(path)) return []
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`${IMPORTS_FILE} is not valid JSON`)
  }
  return parseOrExplain(Ledger, raw, IMPORTS_FILE).imports
}

function filesIn(dir: string, extensions: readonly string[]): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.') && (extensions as readonly string[]).includes(extname(name).toLowerCase()))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false)
    .sort()
}

const workspacePath = (workspace: string, path: string) => relative(workspace, path).split(sep).join('/')

export function importCandidates(workspace: string): string[] {
  return [
    ...filesIn(join(workspace, INBOX_DIR), IMPORT_EXTENSIONS),
    ...filesIn(workspace, ROOT_IMPORT_EXTENSIONS),
  ]
}

export function scanImports(home: string, workspace: string): ImportScan {
  const ledger = new Map(readLedger(home).map((entry) => [entry.sha256, entry]))
  const pending: ImportCandidate[] = []
  const imported: ImportedCandidate[] = []
  const seen = new Set<string>()
  for (const path of importCandidates(workspace)) {
    const candidate = { path: workspacePath(workspace, path), name: basename(path), sha256: sha256File(path) }
    const entry = ledger.get(candidate.sha256)
    if (entry) imported.push({ ...candidate, imported_at: entry.imported_at })
    else if (!seen.has(candidate.sha256)) pending.push(candidate)
    seen.add(candidate.sha256)
  }
  return { pending, imported }
}

export interface MarkResult {
  marked: ImportCandidate[]
  already: ImportCandidate[]
}

export function resolveInWorkspace(workspace: string, file: string): string {
  const root = resolve(workspace)
  const path = resolve(root, file)
  const rel = relative(root, path)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${file} is not a file in the workspace ${root}`)
  }
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) throw new Error(`${file} does not exist in the workspace ${root}`)
  return path
}

export function markImported(home: string, workspace: string, files: string[], now = new Date()): MarkResult {
  const paths = files.map((file) => resolveInWorkspace(workspace, file))
  const entries = readLedger(home)
  const known = new Set(entries.map((entry) => entry.sha256))
  const result: MarkResult = { marked: [], already: [] }
  for (const path of paths) {
    const candidate = { path: workspacePath(resolve(workspace), path), name: basename(path), sha256: sha256File(path) }
    if (known.has(candidate.sha256)) {
      result.already.push(candidate)
      continue
    }
    known.add(candidate.sha256)
    entries.push({ sha256: candidate.sha256, name: candidate.name, imported_at: now.toISOString() })
    result.marked.push(candidate)
  }
  if (result.marked.length > 0) writePrivateFile(importsPath(home), `${JSON.stringify({ imports: entries }, null, 2)}\n`)
  return result
}
