import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { type JobduckServer, createServer, log } from '../mcp/server'
import { NoHomeError } from '../paths'

export async function runMcp(): Promise<number> {
  let created: JobduckServer
  try {
    created = createServer()
  } catch (error) {
    if (!(error instanceof NoHomeError)) throw error
    log(error.message)
    return 1
  }
  const { server, close } = created
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
