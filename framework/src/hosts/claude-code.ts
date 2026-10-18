import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { TEMPLATES } from '../assets'
import {
  type FileChange, type Host, type HostContext, applyChanges, hasJsonMcpServer, mergeMcpServersJson, onPath,
  planChange, readText, skillPointers, userHomeOf,
} from './index'

const AGENTS_START = '<!-- jobduck:start'
const AGENTS_END = '<!-- jobduck:end -->'
const LEGACY_AGENTS_SHA256 = new Set(['8a7cfdd54c987a9705a64eb83d8d2f814e62e0dbd53af19a9e7a2d89d5a4273a'])

export function mergeAgentsMd(before: string | null): string {
  const block = TEMPLATES['AGENTS.md']!
  if (before === null || before.trim() === '') return block
  if (LEGACY_AGENTS_SHA256.has(createHash('sha256').update(before).digest('hex'))) return block
  const start = before.indexOf(AGENTS_START)
  const end = start === -1 ? -1 : before.indexOf(AGENTS_END, start)
  if (end === -1) return `${before.replace(/\n*$/, '')}\n\n${block}`
  return `${before.slice(0, start)}${block.trimEnd()}${before.slice(end + AGENTS_END.length)}`
}

export function agentsPointer(ctx: HostContext): FileChange | null {
  const path = join(ctx.workspace, 'AGENTS.md')
  return planChange(path, mergeAgentsMd(readText(path)))
}

function claudeMdPointer(ctx: HostContext): FileChange | null {
  const path = join(ctx.workspace, 'CLAUDE.md')
  const before = readText(path)
  if (before !== null && before.split(/\r?\n/).some((line) => line.trim() === '@AGENTS.md')) return null
  if (before === null || before === '') return planChange(path, '@AGENTS.md\n')
  return planChange(path, `${before}${before.endsWith('\n') ? '' : '\n'}\n@AGENTS.md\n`)
}

const mcpJson = (ctx: HostContext) => join(ctx.workspace, '.mcp.json')

export const claudeCode: Host = {
  id: 'claude',
  label: 'Claude Code',
  configPath: mcpJson,
  detect: (ctx) =>
    existsSync(mcpJson(ctx)) || existsSync(join(userHomeOf(ctx), '.claude.json')) || onPath('claude', ctx.pathEnv),
  isRegistered: (ctx) => hasJsonMcpServer(mcpJson(ctx)),
  register: (ctx) =>
    applyChanges([
      planChange(mcpJson(ctx), mergeMcpServersJson(mcpJson(ctx))),
      agentsPointer(ctx),
      claudeMdPointer(ctx),
      ...skillPointers(join(ctx.workspace, '.claude', 'skills')),
    ], ctx.dryRun),
}
