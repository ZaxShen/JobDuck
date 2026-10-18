import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer, log } from '../mcp/server'

export async function runMcp(): Promise<number> {
  const { server, close } = createServer()
  const transport = new StdioServerTransport()
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve()
  })
  transport.onerror = (error) => log(`transport error: ${error.message}`)

  let pending = 0
  let stdinEnded = false
  const closeWhenAnswered = () => {
    if (stdinEnded && pending === 0) void transport.close()
  }
  process.stdin.once('end', () => {
    stdinEnded = true
    closeWhenAnswered()
  })

  await server.connect(transport)
  const receive = transport.onmessage
  transport.onmessage = (message) => {
    if ('method' in message && 'id' in message) pending++
    receive?.(message)
  }
  const send = transport.send.bind(transport)
  transport.send = async (message) => {
    await send(message)
    if (!('method' in message) && 'id' in message) {
      pending--
      closeWhenAnswered()
    }
  }

  log('MCP server ready on stdio')
  await closed
  await close()
  return 0
}
