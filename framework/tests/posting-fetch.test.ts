import { describe, expect, test } from 'bun:test'
import { type FetchLike, USER_AGENT } from '../src/freehire/client'
import {
  FetchRefused, isPublicAddress, type LookupLike, MAX_BODY_BYTES, MAX_REDIRECTS, safeFetch,
} from '../src/posting/fetch'

const PUBLIC = '93.184.215.14'

const lookupTable = (table: Record<string, string[]>): LookupLike => async (hostname) => {
  const addresses = table[hostname]
  if (!addresses) throw new Error(`unexpected lookup ${hostname}`)
  return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
}

interface Call { url: string; init: RequestInit | undefined }

function routes(map: Record<string, () => Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const route = map[url]
    if (!route) throw new Error(`unexpected URL ${url}`)
    return route()
  }
  return { fetch, calls }
}

const html = (body: string, status = 200) => () => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } })

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof FetchRefused) return error.reason
    throw error
  }
  throw new Error('expected a refusal')
}

describe('safeFetch', () => {
  test('fetches a public page with the Job Duck user agent and manual redirects', async () => {
    const { fetch, calls } = routes({ 'https://careers.example.com/jobs/1': html('<p>Acme</p>') })
    const response = await safeFetch('https://careers.example.com/jobs/1', {
      fetch, lookup: lookupTable({ 'careers.example.com': [PUBLIC] }),
    })
    expect(response).toEqual({ url: 'https://careers.example.com/jobs/1', status: 200, contentType: 'text/html', body: '<p>Acme</p>' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.init?.redirect).toBe('manual')
    expect((calls[0]?.init?.headers as Record<string, string>)['User-Agent']).toBe(USER_AGENT)
  })

  test('refuses private, loopback, link-local and IPv6 loopback literals without fetching', async () => {
    const { fetch, calls } = routes({})
    const deps = { fetch, lookup: lookupTable({}) }
    for (const url of ['http://127.0.0.1/', 'http://10.1.2.3/jobs', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://2130706433/']) {
      expect(await refusal(safeFetch(url, deps))).toBe('private_address')
    }
    expect(calls).toHaveLength(0)
  })

  test('refuses a hostname that resolves to a private address', async () => {
    const { fetch, calls } = routes({})
    const lookup = lookupTable({ 'intranet.example.com': ['192.168.1.5'], 'mixed.example.com': [PUBLIC, 'fd00::1'] })
    expect(await refusal(safeFetch('https://intranet.example.com/', { fetch, lookup }))).toBe('private_address')
    expect(await refusal(safeFetch('https://mixed.example.com/', { fetch, lookup }))).toBe('private_address')
    expect(await refusal(safeFetch('https://localhost/', { fetch, lookup }))).toBe('private_address')
    expect(calls).toHaveLength(0)
  })

  test('refuses a redirect to a private address after re-checking it', async () => {
    const { fetch, calls } = routes({ 'https://jobs.example.com/a': redirect('http://10.0.0.7/admin') })
    const lookup = lookupTable({ 'jobs.example.com': [PUBLIC] })
    expect(await refusal(safeFetch('https://jobs.example.com/a', { fetch, lookup }))).toBe('private_address')
    expect(calls.map((call) => call.url)).toEqual(['https://jobs.example.com/a'])
  })

  test('refuses other schemes, credentials and non-default ports', async () => {
    const { fetch, calls } = routes({})
    const deps = { fetch, lookup: lookupTable({ 'example.com': [PUBLIC] }) }
    expect(await refusal(safeFetch('file:///etc/passwd', deps))).toBe('scheme')
    expect(await refusal(safeFetch('ftp://example.com/', deps))).toBe('scheme')
    expect(await refusal(safeFetch('http://user:pw@example.com/', deps))).toBe('credentials')
    expect(await refusal(safeFetch('https://example.com:8443/', deps))).toBe('port')
    expect(calls).toHaveLength(0)
  })

  test('follows up to five redirects and refuses the sixth', async () => {
    const hop = (n: number) => `https://jobs.example.com/${n}`
    const chain: Record<string, () => Response> = {}
    for (let n = 0; n < MAX_REDIRECTS; n++) chain[hop(n)] = redirect(`/${n + 1}`)
    chain[hop(MAX_REDIRECTS)] = html('<p>done</p>')
    const lookup = lookupTable({ 'jobs.example.com': [PUBLIC] })
    const ok = routes(chain)
    expect((await safeFetch(hop(0), { fetch: ok.fetch, lookup })).url).toBe(hop(MAX_REDIRECTS))
    expect(ok.calls).toHaveLength(MAX_REDIRECTS + 1)

    chain[hop(MAX_REDIRECTS)] = redirect(`/${MAX_REDIRECTS + 1}`)
    const tooMany = routes(chain)
    expect(await refusal(safeFetch(hop(0), { fetch: tooMany.fetch, lookup }))).toBe('redirect_limit')
    expect(tooMany.calls).toHaveLength(MAX_REDIRECTS + 1)
  })

  test('enforces the 2 MB body cap whether or not Content-Length is sent', async () => {
    const lookup = lookupTable({ 'jobs.example.com': [PUBLIC] })
    const big = 'a'.repeat(MAX_BODY_BYTES + 1)
    const streamed = routes({
      'https://jobs.example.com/big': () => new Response(new Blob([big]).stream(), { headers: { 'content-type': 'text/html' } }),
    })
    expect(await refusal(safeFetch('https://jobs.example.com/big', { fetch: streamed.fetch, lookup }))).toBe('too_large')
    const declared = routes({
      'https://jobs.example.com/big': () => new Response('x', { headers: { 'content-type': 'text/html', 'content-length': String(MAX_BODY_BYTES + 1) } }),
    })
    expect(await refusal(safeFetch('https://jobs.example.com/big', { fetch: declared.fetch, lookup }))).toBe('too_large')
    const exact = routes({ 'https://jobs.example.com/big': html('a'.repeat(MAX_BODY_BYTES)) })
    expect((await safeFetch('https://jobs.example.com/big', { fetch: exact.fetch, lookup })).body).toHaveLength(MAX_BODY_BYTES)
  })

  test('accepts html, json and text only, and returns blocked statuses', async () => {
    const lookup = lookupTable({ 'jobs.example.com': [PUBLIC] })
    const { fetch } = routes({
      'https://jobs.example.com/pdf': () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }),
      'https://jobs.example.com/api': () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
      'https://jobs.example.com/denied': html('Forbidden', 403),
    })
    expect(await refusal(safeFetch('https://jobs.example.com/pdf', { fetch, lookup }))).toBe('content_type')
    expect((await safeFetch('https://jobs.example.com/api', { fetch, lookup })).contentType).toBe('application/json')
    expect((await safeFetch('https://jobs.example.com/denied', { fetch, lookup })).status).toBe(403)
  })

  test('times out', async () => {
    const lookup = lookupTable({ 'jobs.example.com': [PUBLIC] })
    const fetch: FetchLike = () => new Promise(() => {})
    expect(await refusal(safeFetch('https://jobs.example.com/slow', { fetch, lookup, timeoutMs: 20 }))).toBe('timeout')
  })
})

test('isPublicAddress', () => {
  const blocked = [
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.5', '169.254.169.254', '100.64.0.1',
    '100.127.255.255', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:8.8.8.8',
    'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:c0a8:0101::1', 'not-an-ip',
  ]
  for (const address of blocked) expect([address, isPublicAddress(address)]).toEqual([address, false])
  for (const address of [PUBLIC, '8.8.8.8', '100.128.0.1', '172.32.0.1', '2606:4700::1111']) {
    expect([address, isPublicAddress(address)]).toEqual([address, true])
  }
})
