import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { type Sandbox, sandbox } from './helpers'
import { TOOL_NAMES } from '../src/mcp/tools'

const root = join(import.meta.dir, '..')
const binary = join(root, 'dist', process.platform === 'win32' ? 'jobduck.exe' : 'jobduck')
const built = existsSync(binary)
if (!built) process.stderr.write(`mcp-stdio.test.ts: ${binary} is missing, testing the source only; run \`bun run build\` to cover it\n`)

const launchers = [
  { label: 'bun src/cli.ts mcp', command: 'bun', args: [join(root, 'src', 'cli.ts'), 'mcp'] },
  ...(built ? [{ label: 'dist/jobduck mcp', command: binary, args: ['mcp'] }] : []),
]

let box: Sandbox
beforeEach(() => { box = sandbox() })
afterEach(() => box.cleanup())

const env = () => ({ ...getDefaultEnvironment(), JOBDUCK_HOME: box.home, HOME: box.userHome })

for (const launcher of launchers) {
  test(`${launcher.label} answers initialize and tools/list over stdio`, async () => {
    const transport = new StdioClientTransport({
      command: launcher.command, args: launcher.args, env: env(), cwd: box.workspace, stderr: 'pipe',
    })
    const errors: Error[] = []
    const client = new Client({ name: 'jobduck-stdio-test', version: '0.0.0' })
    client.onerror = (error) => { errors.push(error) }
    await client.connect(transport)
    try {
      expect(client.getServerVersion()?.name).toBe('jobduck')
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort())
    } finally {
      await client.close()
    }
    expect(errors).toEqual([])
    expect(existsSync(join(box.home, 'jobduck.db'))).toBe(true)
  }, 20_000)

  test(`${launcher.label}: stdout carries only JSON-RPC and the process exits 0 when stdin closes`, () => {
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]
    const result = spawnSync(launcher.command, launcher.args, {
      env: env(), cwd: box.workspace, input: requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
      encoding: 'utf8', timeout: 15_000,
    })
    expect(result.status).toBe(0)
    const lines = result.stdout.split('\n').filter((line) => line !== '')
    expect(lines).toHaveLength(2)
    const messages = lines.map((line) => JSON.parse(line) as { jsonrpc: string; id: number; result: Record<string, any> })
    expect(messages.every((message) => message.jsonrpc === '2.0')).toBe(true)
    expect(messages.map((message) => message.id)).toEqual([1, 2])
    expect(messages[1]?.result.tools).toHaveLength(TOOL_NAMES.length)
    expect(result.stderr).toContain('MCP server ready on stdio')
  }, 20_000)
}
