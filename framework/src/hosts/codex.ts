import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'smol-toml'
import {
  type Host, type HostContext, MCP_SERVER, applyChanges, onPath, planChange, readText, skillPointers, userHomeOf,
} from './index'

const configToml = (ctx: HostContext) => join(userHomeOf(ctx), '.codex', 'config.toml')

const block = () => `[mcp_servers.jobduck]\ncommand = ${JSON.stringify(MCP_SERVER.command)}\nargs = [${MCP_SERVER.args.map((arg) => JSON.stringify(arg)).join(', ')}]\n`

type Table = Record<string, unknown>

const asTable = (value: unknown): Table | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Table) : undefined

function registeredServer(config: Table): Table | undefined {
  return asTable(asTable(config.mcp_servers)?.jobduck)
}

function isCurrent(server: Table | undefined): boolean {
  return server !== undefined && server.command === MCP_SERVER.command &&
    JSON.stringify(server.args) === JSON.stringify(MCP_SERVER.args)
}

function textualMerge(before: string): string {
  const lines = before.split('\n')
  const header = /^\s*\[\s*mcp_servers\s*\.\s*(?:jobduck|"jobduck")\s*\]\s*(#.*)?$/
  const start = lines.findIndex((line) => header.test(line))
  if (start === -1) {
    const trimmed = before.replace(/\n*$/, '')
    return trimmed === '' ? block() : `${trimmed}\n\n${block()}`
  }
  let end = start + 1
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++
  while (end > start + 1 && lines[end - 1]!.trim() === '') end--
  const tail = lines.slice(end).join('\n')
  return [...lines.slice(0, start), block().replace(/\n$/, ''), ...(tail === '' ? [''] : ['', tail.replace(/^\n+/, '')])]
    .join('\n')
}

function tryParse(text: string): Table | undefined {
  try {
    return parse(text) as Table
  } catch {
    return undefined
  }
}

export function mergeCodexConfig(before: string | null): string {
  const text = before ?? ''
  const config = parse(text) as Table
  if (isCurrent(registeredServer(config))) return text
  const merged = textualMerge(text)
  const reparsed = tryParse(merged)
  if (reparsed && isCurrent(registeredServer(reparsed))) return merged
  const servers = asTable(config.mcp_servers) ?? {}
  return `${stringify({ ...config, mcp_servers: { ...servers, jobduck: MCP_SERVER } })}\n`
}

export const codex: Host = {
  id: 'codex',
  label: 'Codex CLI',
  configPath: configToml,
  detect: (ctx) => existsSync(configToml(ctx)) || onPath('codex', ctx.pathEnv),
  isRegistered: (ctx) => {
    const config = tryParse(readText(configToml(ctx)) ?? '')
    return config !== undefined && registeredServer(config) !== undefined
  },
  register: (ctx) =>
    applyChanges([
      planChange(configToml(ctx), mergeCodexConfig(readText(configToml(ctx)))),
      ...skillPointers(join(ctx.workspace, '.agents', 'skills')),
    ], ctx.dryRun),
}
