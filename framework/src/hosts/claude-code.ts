import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { TEMPLATES } from '../assets'
import {
  type FileChange, type Host, type HostContext, applyChanges, hasJsonMcpServer, mergeMcpServersJson, onPath,
  planChange, readText, skillPointers, userHomeOf,
} from './index'

export function agentsPointer(ctx: HostContext): FileChange | null {
  const path = join(ctx.workspace, 'AGENTS.md')
  if (existsSync(path)) return null
  return planChange(path, TEMPLATES['AGENTS.md']!)
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
