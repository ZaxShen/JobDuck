import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { agentsPointer } from './claude-code'
import {
  type FileChange, type Host, type HostContext, applyChanges, hasJsonMcpServer, isWorkspaceLocal, mcpServer,
  mergeMcpServersJson, onPath, planChange, userHomeOf,
} from './index'

const globalSettingsJson = (ctx: HostContext) => join(userHomeOf(ctx), '.gemini', 'settings.json')
const settingsJson = (ctx: HostContext) =>
  isWorkspaceLocal(ctx) ? join(ctx.workspace, '.gemini', 'settings.json') : globalSettingsJson(ctx)

function geminiMdPointer(ctx: HostContext): FileChange | null {
  const path = join(ctx.workspace, 'GEMINI.md')
  return existsSync(path) ? null : planChange(path, 'See AGENTS.md\n')
}

export const gemini: Host = {
  id: 'gemini',
  label: 'Gemini CLI',
  configPath: settingsJson,
  detect: (ctx) =>
    existsSync(globalSettingsJson(ctx)) || existsSync(settingsJson(ctx)) || onPath('gemini', ctx.pathEnv),
  isRegistered: (ctx) => hasJsonMcpServer(settingsJson(ctx)),
  register: (ctx) =>
    applyChanges([
      planChange(settingsJson(ctx), mergeMcpServersJson(settingsJson(ctx), mcpServer(ctx))),
      agentsPointer(ctx),
      geminiMdPointer(ctx),
    ], ctx.dryRun),
}
