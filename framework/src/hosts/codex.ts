import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'smol-toml'
import {
  type Host, type HostContext, type McpServerEntry, MCP_SERVER, applyChanges, homeLabel, isWorkspaceLocal, mcpServer, onPath,
  planChange, readText, skillPointers, userHomeOf,
} from './index'
import { agentsPointer } from './claude-code'

const globalConfigToml = (ctx: HostContext) => join(userHomeOf(ctx), '.codex', 'config.toml')
const codexConfigPath = (ctx: HostContext) =>
  isWorkspaceLocal(ctx) ? join(ctx.workspace, '.codex', 'config.toml') : globalConfigToml(ctx)

function block(entry: McpServerEntry): string {
  const lines = [
    '[mcp_servers.jobduck]',
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${entry.args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
  ]
  if (entry.env) lines.push(`env = { JOBDUCK_HOME = ${JSON.stringify(entry.env.JOBDUCK_HOME)} }`)
  return `${lines.join('\n')}\n`
}

type Table = Record<string, unknown>

const asTable = (value: unknown): Table | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Table) : undefined

function registeredServer(config: Table): Table | undefined {
  return asTable(asTable(config.mcp_servers)?.jobduck)
}

function isCurrent(server: Table | undefined, entry: McpServerEntry): boolean {
  return server !== undefined && server.command === entry.command &&
    JSON.stringify(server.args) === JSON.stringify(entry.args) &&
    asTable(server.env)?.JOBDUCK_HOME === entry.env?.JOBDUCK_HOME
}

function textualMerge(before: string, entry: McpServerEntry): string {
  const lines = before.split('\n')
  const header = /^\s*\[\s*mcp_servers\s*\.\s*(?:jobduck|"jobduck")\s*\]\s*(#.*)?$/
  const start = lines.findIndex((line) => header.test(line))
  if (start === -1) {
    const trimmed = before.replace(/\n*$/, '')
    return trimmed === '' ? block(entry) : `${trimmed}\n\n${block(entry)}`
  }
  let end = start + 1
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++
  while (end > start + 1 && lines[end - 1]!.trim() === '') end--
  const tail = lines.slice(end).join('\n')
  return [...lines.slice(0, start), block(entry).replace(/\n$/, ''), ...(tail === '' ? [''] : ['', tail.replace(/^\n+/, '')])]
    .join('\n')
}

function tryParse(text: string): Table | undefined {
  try {
    return parse(text) as Table
  } catch {
    return undefined
  }
}

export function mergeCodexConfig(before: string | null, entry: McpServerEntry = MCP_SERVER): string {
  const text = before ?? ''
  const config = parse(text) as Table
  if (isCurrent(registeredServer(config), entry)) return text
  const merged = textualMerge(text, entry)
  const reparsed = tryParse(merged)
  if (reparsed && isCurrent(registeredServer(reparsed), entry)) return merged
  const servers = asTable(config.mcp_servers) ?? {}
  return `${stringify({ ...config, mcp_servers: { ...servers, jobduck: entry } })}\n`
}

export const codex: Host = {
  id: 'codex',
  label: 'Codex CLI',
  configPath: codexConfigPath,
  detect: (ctx) => existsSync(globalConfigToml(ctx)) || existsSync(codexConfigPath(ctx)) || onPath('codex', ctx.pathEnv),
  isRegistered: (ctx) => {
    const config = tryParse(readText(codexConfigPath(ctx)) ?? '')
    return config !== undefined && registeredServer(config) !== undefined
  },
  register: (ctx) =>
    applyChanges([
      planChange(codexConfigPath(ctx), mergeCodexConfig(readText(codexConfigPath(ctx)), mcpServer(ctx))),
      agentsPointer(ctx),
      ...skillPointers(join(ctx.workspace, '.agents', 'skills'), homeLabel(ctx)),
    ], ctx.dryRun),
}
