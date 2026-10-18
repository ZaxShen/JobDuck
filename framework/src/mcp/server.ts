import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type Db, openDb } from '../db/client'
import { migrate } from '../db/migrate'
import { type FetchLike, PACKAGE_VERSION } from '../freehire/client'
import { dbPath, ensureHome, jobduckHome } from '../paths'
import { registerTools } from './tools'

export interface CreateServerOptions {
  home?: string
  fetch?: FetchLike
  db?: Db
  sleep?: (ms: number) => Promise<void>
}

export interface JobduckServer {
  server: McpServer
  close(): Promise<void>
}

export const log = (message: string) => {
  process.stderr.write(`[jobduck] ${message}\n`)
}

export function createServer(options: CreateServerOptions = {}): JobduckServer {
  const home = options.home ?? jobduckHome()
  ensureHome(home)
  const ownsDb = options.db === undefined
  const db = options.db ?? openDb(dbPath(home))
  migrate(db)
  const server = new McpServer({ name: 'jobduck', version: PACKAGE_VERSION })
  registerTools(server, { db, home, fetch: options.fetch, sleep: options.sleep })
  let closed = false
  return {
    server,
    close: async () => {
      if (closed) return
      closed = true
      await server.close()
      if (ownsDb) db.close()
    },
  }
}
