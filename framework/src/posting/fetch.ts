import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { type FetchLike, USER_AGENT } from '../freehire/client'

export const MAX_REDIRECTS = 5
export const FETCH_TIMEOUT_MS = 15_000
export const MAX_BODY_BYTES = 2 * 1024 * 1024
export const PAGE_ACCEPT = 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8'
export const JSON_ACCEPT = 'application/json'

export type LookupLike = (hostname: string) => Promise<{ address: string; family: number }[]>

export interface SafeFetchDeps {
  fetch?: FetchLike
  lookup?: LookupLike
  timeoutMs?: number
  maxBytes?: number
  userAgent?: string
}

export interface SafeResponse {
  url: string
  status: number
  contentType: string
  body: string
}

export type RefusalReason =
  | 'invalid_url' | 'scheme' | 'credentials' | 'port' | 'private_address' | 'dns' | 'redirect_limit'
  | 'redirect_without_location' | 'content_type' | 'too_large' | 'timeout' | 'network'

export class FetchRefused extends Error {
  constructor(readonly reason: RefusalReason, message: string) {
    super(message)
    this.name = 'FetchRefused'
  }
}

const defaultLookup: LookupLike = (hostname) => dnsLookup(hostname, { all: true, verbatim: true })

function ipv4Octets(address: string): number[] | undefined {
  const parts = address.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return undefined
  return parts.map(Number)
}

export function isPublicIpv4(address: string): boolean {
  const octets = ipv4Octets(address)
  if (!octets) return false
  const [a, b, c] = octets as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

function ipv6Hextets(address: string): number[] | undefined {
  let text = address.toLowerCase().replace(/%.*$/, '')
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (v4) {
    const octets = ipv4Octets(v4[1]!)
    if (!octets) return undefined
    text = `${text.slice(0, v4.index)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail]
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined
  return groups.map((group) => Number.parseInt(group, 16))
}

export function isPublicIpv6(address: string): boolean {
  const h = ipv6Hextets(address)
  if (!h) return false
  const [first, second] = h as [number, number]
  if ((first & 0xe000) !== 0x2000) return false
  if (first === 0x2001 && (second === 0x0db8 || second === 0)) return false
  if (first === 0x2002) return isPublicIpv4(`${second >> 8}.${second & 0xff}.${h[2]! >> 8}.${h[2]! & 0xff}`)
  return true
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPublicIpv4(address)
  if (family === 6) return isPublicIpv6(address)
  return false
}

async function checkUrl(raw: string, lookup: LookupLike): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new FetchRefused('invalid_url', `not a URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchRefused('scheme', `refused scheme ${url.protocol}`)
  if (url.username !== '' || url.password !== '') throw new FetchRefused('credentials', 'refused URL with credentials')
  if (url.port !== '') throw new FetchRefused('port', `refused non-default port ${url.port}`)
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) throw new FetchRefused('private_address', `refused host ${host}`)
  if (isIP(host) !== 0) {
    if (!isPublicAddress(host)) throw new FetchRefused('private_address', `refused address ${host}`)
    return url
  }
  let addresses: { address: string }[]
  try {
    addresses = await lookup(host)
  } catch (error) {
    throw new FetchRefused('dns', `could not resolve ${host}: ${(error as Error).message}`)
  }
  if (addresses.length === 0) throw new FetchRefused('dns', `no addresses for ${host}`)
  const blocked = addresses.find((entry) => !isPublicAddress(entry.address))
  if (blocked) throw new FetchRefused('private_address', `${host} resolves to non-public ${blocked.address}`)
  return url
}

const ALLOWED_TYPES = /^(?:text\/html|application\/xhtml\+xml|application\/(?:[\w.-]+\+)?json|text\/plain|text\/json)$/i

async function readBody(response: Response, maxBytes: number, contentType: string): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new FetchRefused('too_large', `body of ${declared} bytes exceeds ${maxBytes}`)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body?.getReader()
  while (reader) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new FetchRefused('too_large', `body exceeds ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  const charset = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1]
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder((charset ?? 'utf-8') as ConstructorParameters<typeof TextDecoder>[0])
  } catch {
    decoder = new TextDecoder('utf-8')
  }
  return decoder.decode(Buffer.concat(chunks))
}

async function fetchChain(start: string, deps: SafeFetchDeps, accept: string, signal: AbortSignal): Promise<SafeResponse> {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const lookup = deps.lookup ?? defaultLookup
  const headers = { 'User-Agent': deps.userAgent ?? USER_AGENT, Accept: accept }
  let current = start
  for (let redirects = 0; ; redirects++) {
    const url = await checkUrl(current, lookup)
    let response: Response
    try {
      response = await fetchImpl(url.href, { method: 'GET', headers, redirect: 'manual', signal })
    } catch (error) {
      if (error instanceof FetchRefused) throw error
      throw new FetchRefused(signal.aborted ? 'timeout' : 'network', `fetch failed for ${url.href}: ${(error as Error).message}`)
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) throw new FetchRefused('redirect_without_location', `HTTP ${response.status} without Location`)
      if (redirects >= MAX_REDIRECTS) throw new FetchRefused('redirect_limit', `more than ${MAX_REDIRECTS} redirects`)
      current = new URL(location, url).href
      continue
    }
    const contentType = response.headers.get('content-type') ?? ''
    const mediaType = contentType.split(';')[0]!.trim()
    if (!ALLOWED_TYPES.test(mediaType)) {
      await response.body?.cancel()
      if (!response.ok) return { url: url.href, status: response.status, contentType, body: '' }
      throw new FetchRefused('content_type', `refused content type ${mediaType || '(none)'}`)
    }
    const body = await readBody(response, deps.maxBytes ?? MAX_BODY_BYTES, contentType)
    return { url: url.href, status: response.status, contentType: mediaType.toLowerCase(), body }
  }
}

export async function safeFetch(url: string, deps: SafeFetchDeps = {}, accept = PAGE_ACCEPT): Promise<SafeResponse> {
  const controller = new AbortController()
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new FetchRefused('timeout', `no response within ${timeoutMs} ms`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([fetchChain(url, deps, accept, controller.signal), deadline])
  } finally {
    clearTimeout(timer)
  }
}
