import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer, log } from '../mcp/server'

export async function runMcp(): Promise<number> {
  const { server, close } = createServer()
  const transport = new StdioServerTransport()
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve()
  })
  transport.onerror = (error) => log(`transport error: ${error.message}`)
  process.stdin.once('end', () => {
    void transport.close()
  })
  await server.connect(transport)
  log('MCP server ready on stdio')
  await closed
  await close()
  return 0
}
