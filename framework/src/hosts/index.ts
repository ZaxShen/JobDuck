import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { claudeCode } from './claude-code'
import { codex } from './codex'
import { unifiedDiff } from './diff'
import { gemini } from './gemini'
import { SKILLS } from '../assets'
import { skillNames } from '../paths'

export const HOST_IDS = ['claude', 'codex', 'gemini'] as const
export type HostId = (typeof HOST_IDS)[number]

export const MCP_SERVER = { command: 'jobduck', args: ['mcp'] }

export interface McpServerEntry {
  command: string
  args: string[]
  env?: { JOBDUCK_HOME: string }
}

export interface HostContext {
  workspace: string
  home: string
  userHome?: string
  pathEnv?: string
  dryRun: boolean
}

export interface FileChange {
  path: string
  before: string | null
  after: string
  diff: string
}

export interface Host {
  id: HostId
  label: string
  configPath(ctx: HostContext): string
  detect(ctx: HostContext): boolean
  isRegistered(ctx: HostContext): boolean
  register(ctx: HostContext): FileChange[]
}

export const userHomeOf = (ctx: Pick<HostContext, 'userHome'>) => ctx.userHome ?? homedir()

export const isWorkspaceLocal = (ctx: HostContext) => dirname(resolve(ctx.home)) === resolve(ctx.workspace)

const slashes = (path: string) => path.split(sep).join('/')

export function homeLabel(ctx: HostContext): string {
  const home = resolve(ctx.home)
  if (isWorkspaceLocal(ctx)) return slashes(relative(resolve(ctx.workspace), home))
  const user = resolve(userHomeOf(ctx))
  const prefix = user.endsWith(sep) ? user : `${user}${sep}`
  return home.startsWith(prefix) ? `~/${slashes(home.slice(prefix.length))}` : home
}

export function mcpServer(ctx: HostContext): McpServerEntry {
  return { ...MCP_SERVER, env: { JOBDUCK_HOME: resolve(ctx.home) } }
}

export function onPath(binary: string, pathEnv = process.env.PATH ?? ''): boolean {
  const names = process.platform === 'win32' ? [`${binary}.cmd`, `${binary}.exe`, binary] : [binary]
  return pathEnv.split(delimiter).filter(Boolean).some((dir) => names.some((name) => existsSync(join(dir, name))))
}

export function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

export function planChange(path: string, after: string): FileChange | null {
  const before = readText(path)
  if (before === after) return null
  return { path, before, after, diff: unifiedDiff(path, before, after) }
}

export function applyChanges(changes: Array<FileChange | null>, dryRun: boolean): FileChange[] {
  const planned = changes.filter((change): change is FileChange => change !== null)
  if (!dryRun) {
    for (const change of planned) {
      mkdirSync(dirname(change.path), { recursive: true })
      writeFileSync(change.path, change.after)
    }
  }
  return planned
}

export function skillFrontMatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const fields: Record<string, string> = {}
  for (const line of (match?.[1] ?? '').split(/\r?\n/)) {
    const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (field) fields[field[1]!] = field[2]!.replace(/^"(.*)"$/, '$1').trim()
  }
  return fields
}

export function skillPointers(dir: string, label: string): Array<FileChange | null> {
  return skillNames().map((name) => {
    const { description = '' } = skillFrontMatter(SKILLS[name]!)
    const pointer = `jobduck-${name}`
    return planChange(
      join(dir, pointer, 'SKILL.md'),
      `---\nname: ${pointer}\ndescription: ${JSON.stringify(description)}\n---\n\nRead and follow \`${label}/skills/${name}.md\`.\n`,
    )
  })
}

export function readJsonObject(path: string): Record<string, unknown> {
  const text = readText(path)
  if (text === null || text.trim() === '') return {}
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`)
  }
  return parsed as Record<string, unknown>
}

export function mergeMcpServersJson(path: string, server: McpServerEntry): string {
  const config = readJsonObject(path)
  const existing = config.mcpServers
  const servers = typeof existing === 'object' && existing !== null && !Array.isArray(existing)
    ? (existing as Record<string, unknown>)
    : {}
  return `${JSON.stringify({ ...config, mcpServers: { ...servers, jobduck: server } }, null, 2)}\n`
}

export function hasJsonMcpServer(path: string): boolean {
  try {
    const servers = readJsonObject(path).mcpServers
    return typeof servers === 'object' && servers !== null && 'jobduck' in servers
  } catch {
    return false
  }
}

export function allHosts(): Host[] {
  return [claudeCode, codex, gemini]
}

export function hostById(id: string): Host {
  const host = allHosts().find((candidate) => candidate.id === id)
  if (!host) throw new Error(`unknown host "${id}" (expected one of ${HOST_IDS.join(', ')})`)
  return host
}
