import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { agentsPointer } from './claude-code'
import {
  type FileChange, type Host, type HostContext, applyChanges, hasJsonMcpServer, mergeMcpServersJson, onPath,
  planChange, userHomeOf,
} from './index'

const settingsJson = (ctx: HostContext) => join(userHomeOf(ctx), '.gemini', 'settings.json')

function geminiMdPointer(ctx: HostContext): FileChange | null {
  const path = join(ctx.workspace, 'GEMINI.md')
  return existsSync(path) ? null : planChange(path, 'See AGENTS.md\n')
}

export const gemini: Host = {
  id: 'gemini',
  label: 'Gemini CLI',
  configPath: settingsJson,
  detect: (ctx) => existsSync(settingsJson(ctx)) || onPath('gemini', ctx.pathEnv),
  isRegistered: (ctx) => hasJsonMcpServer(settingsJson(ctx)),
  register: (ctx) =>
    applyChanges([
      planChange(settingsJson(ctx), mergeMcpServersJson(settingsJson(ctx))),
      agentsPointer(ctx),
      geminiMdPointer(ctx),
    ], ctx.dryRun),
}
