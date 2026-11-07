import { spawn } from 'node:child_process'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DASHBOARD, DASHBOARD_FILES } from '../assets'
import { openDb } from '../db/client'
import { migrate } from '../db/migrate'
import { dbPath, ensureHome, jobduckHome } from '../paths'
import { AGENT_PATH, AUGMENT_PATH, type Agent, type AgentEvent, type AgentOptions, createAgent, parseAugmentBody } from './agent'
import { ApiError, INBOX_MAX_BODY_BYTES, INBOX_PATH, handleApi } from './api'

export const DASHBOARD_HOST = '127.0.0.1'
export const DASHBOARD_HEADER = 'x-jobduck-dashboard'
export const MAX_BODY_BYTES = 1024 * 1024
export const DEFAULT_PORT = 4848

export interface DashboardOptions {
  home?: string
  workspace?: string
  port?: number
  open?: boolean
  view?: DashboardView
  out?: (line: string) => void
  agent?: AgentOptions
}

export const DASHBOARD_VIEWS = ['applications', 'profile', 'facts', 'settings', 'welcome'] as const
export type DashboardView = (typeof DASHBOARD_VIEWS)[number]

export const pageUrl = (origin: string, view?: DashboardView) => (view ? `${origin}/#${view}` : origin)

export interface Dashboard {
  url: string
  host: string
  port: number
  close(): Promise<void>
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
}

const contentType = (file: string) => CONTENT_TYPES[file.slice(file.lastIndexOf('.'))]!

const ASSETS: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: contentType('index.html') },
  ...Object.fromEntries([...Object.keys(DASHBOARD), ...Object.keys(DASHBOARD_FILES)]
    .map((name) => [`/${name}`, { file: name, type: contentType(name) }])),
}

const assetBody = async (file: string): Promise<string | Buffer> => {
  const binary = DASHBOARD_FILES[file]
  return binary ? Buffer.from(await Bun.file(binary).arrayBuffer()) : DASHBOARD[file]!
}

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type })
  res.end(body)
}

const sendJson = (res: ServerResponse, status: number, body: unknown) =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body))

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new ApiError(413, `request body exceeds ${limit} bytes`))
        req.removeAllListeners('data')
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseJson(raw: string): unknown {
  if (raw.trim() === '') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw new ApiError(400, 'request body is not valid JSON')
  }
}

const TERMINAL_EVENTS = new Set<AgentEvent['type']>(['done', 'error'])

async function streamAugment(req: IncomingMessage, res: ServerResponse, agent: Agent): Promise<void> {
  // Bun 1.3 unhooks client-abort detection when a fully read request auto-destroys, so keep it open until the turn ends.
  (req as unknown as { _readableState: { autoDestroy: boolean } })._readableState.autoDestroy = false
  const turn = parseAugmentBody(parseJson(await readBody(req, MAX_BODY_BYTES)))
  if (agent.busy) return sendJson(res, 409, { error: 'an agent turn is already running' })
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' })
  res.flushHeaders()
  const controller = new AbortController()
  const abort = () => {
    if (!res.writableEnded) controller.abort()
  }
  res.on('close', abort)
  req.socket.on('close', abort)
  try {
    await agent.run(turn, (event) => {
      if (res.writableEnded || controller.signal.aborted) return
      res.write(`data: ${JSON.stringify(event)}\n\n`)
      if (TERMINAL_EVENTS.has(event.type)) res.end()
    }, controller.signal)
  } finally {
    req.socket.off('close', abort)
    if (!res.writableEnded) res.end()
    req.destroy()
  }
}

function handleAgent(req: IncomingMessage, res: ServerResponse, method: string, path: string, agent: Agent): Promise<void> | void {
  if (path === AGENT_PATH) return method === 'GET' ? sendJson(res, 200, agent.status()) : sendJson(res, 405, { error: 'method not allowed' })
  return method === 'POST' ? streamAugment(req, res, agent) : sendJson(res, 405, { error: 'method not allowed' })
}

export function openBrowser(url: string, onError: () => void = () => undefined): void {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  const child = spawn(command, args as string[], { detached: true, stdio: 'ignore' })
  child.on('error', onError)
  child.unref()
}

export async function startDashboard(options: DashboardOptions = {}): Promise<Dashboard> {
  const home = options.home ?? jobduckHome(options.workspace)
  const out = options.out ?? ((line: string) => console.log(line))
  const assets = Object.fromEntries(await Promise.all(Object.entries(ASSETS)
    .map(async ([path, asset]) => [path, { type: asset.type, body: await assetBody(asset.file) }] as const)))

  ensureHome(home)
  const db = openDb(dbPath(home))
  migrate(db)
  const agent = createAgent({ home, workspace: options.workspace ?? process.cwd(), options: options.agent })

  let origin = ''
  let allowedHosts = new Set<string>()
  let allowedOrigins = new Set<string>()

  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET'
      if (!allowedHosts.has((req.headers.host ?? '').toLowerCase())) {
        sendJson(res, 403, { error: 'forbidden host' })
        return
      }
      const url = new URL(req.url ?? '/', origin)
      if (!url.pathname.startsWith('/api/')) {
        const asset = assets[url.pathname]
        if (!asset) return sendJson(res, 404, { error: 'not found' })
        if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
        return send(res, 200, asset.type, method === 'HEAD' ? '' : asset.body)
      }
      if (MUTATIONS.has(method)) {
        if (req.headers[DASHBOARD_HEADER] !== '1') return sendJson(res, 403, { error: 'missing X-JobDuck-Dashboard header' })
        const requestOrigin = req.headers.origin
        if (requestOrigin !== undefined && !allowedOrigins.has(requestOrigin)) return sendJson(res, 403, { error: 'cross-origin request refused' })
      }
      if (url.pathname === AGENT_PATH || url.pathname === AUGMENT_PATH) return await handleAgent(req, res, method, url.pathname, agent)
      const limit = url.pathname === INBOX_PATH ? INBOX_MAX_BODY_BYTES : MAX_BODY_BYTES
      const body = MUTATIONS.has(method) ? parseJson(await readBody(req, limit)) : undefined
      const result = handleApi({ db, home, workspace: options.workspace }, { method, path: url.pathname, query: url.searchParams, body })
      sendJson(res, result.status, result.body)
    } catch (error) {
      if (error instanceof ApiError) return sendJson(res, error.status, { error: error.message })
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? DEFAULT_PORT, DASHBOARD_HOST, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    db.close()
    throw error
  }

  const address = server.address() as AddressInfo
  origin = `http://${DASHBOARD_HOST}:${address.port}`
  allowedHosts = new Set([`${DASHBOARD_HOST}:${address.port}`, `localhost:${address.port}`])
  allowedOrigins = new Set([...allowedHosts].map(host => `http://${host}`))
  const page = pageUrl(origin, options.view)
  if (options.open ?? true) openBrowser(page, () => out(`Could not open a browser; visit ${page}`))

  let closed = false
  return {
    url: origin,
    host: address.address,
    port: address.port,
    close: () => new Promise<void>((resolve) => {
      if (closed) return resolve()
      closed = true
      agent.stop()
      server.close(() => {
        db.close()
        resolve()
      })
      server.closeAllConnections?.()
    }),
  }
}
