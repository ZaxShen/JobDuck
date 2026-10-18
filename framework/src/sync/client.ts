import { z } from 'zod'

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

const Ref = z.union([z.string(), z.number()]).nullish()

export const SyncOutcome = z.looseObject({
  messageId: z.string().min(1),
  receivedAt: z.string().min(1),
  senderDomain: z.string().nullish(),
  subject: z.string().nullish(),
  company: z.string().nullish(),
  title: z.string().nullish(),
  jobUrl: z.string().nullish(),
  jobRef: z.string().nullish(),
  applicationId: Ref,
  jobId: Ref,
  queuedAt: z.string().nullish(),
})
export type SyncOutcome = z.infer<typeof SyncOutcome>

const Failure = z.object({ ok: z.literal(false), error: z.string() })
const Pending = z.looseObject({ ok: z.literal(true), scriptVersion: z.string(), outcomes: z.array(SyncOutcome) })
const Acked = z.looseObject({ ok: z.literal(true), acked: z.number() })
const Status = z.looseObject({ ok: z.literal(true), scriptVersion: z.string(), mode: z.string().optional(), pending: z.number().optional() })

export type PendingResponse = z.infer<typeof Pending>
export type StatusResponse = z.infer<typeof Status>

export const ACK_BATCH = 100
const EXCERPT = 200

export class SyncAuthError extends Error {
  constructor() {
    super('sync_token rejected; run generateSyncToken in the Apps Script and update permissions.toml')
    this.name = 'SyncAuthError'
  }
}

export interface SyncClientOptions {
  url: string
  token: string
  fetch?: FetchLike
}

export interface SyncClient {
  pending(): Promise<PendingResponse>
  ack(messageIds: string[]): Promise<number>
  status(): Promise<StatusResponse>
}

export function createSyncClient(options: SyncClientOptions): SyncClient {
  const doFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init))

  async function call<T extends z.ZodType>(action: string, schema: T, extra: Record<string, unknown> = {}): Promise<z.infer<T>> {
    let response: Response
    try {
      response = await doFetch(options.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ token: options.token, action, ...extra }),
        redirect: 'follow',
      })
    } catch (error) {
      throw new Error(`sync ${action} request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await response.text()
    const excerpt = text.slice(0, EXCERPT)
    if (!response.ok) throw new Error(`sync ${action} failed: HTTP ${response.status}: ${excerpt}`)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`sync ${action} failed: HTTP ${response.status} returned non-JSON: ${excerpt}`)
    }
    const failure = Failure.safeParse(body)
    if (failure.success) {
      if (failure.data.error === 'unauthorized') throw new SyncAuthError()
      throw new Error(`sync ${action} failed: ${failure.data.error.slice(0, EXCERPT)}`)
    }
    const parsed = schema.safeParse(body)
    if (!parsed.success) throw new Error(`sync ${action} failed: unexpected response: ${excerpt}`)
    return parsed.data
  }

  return {
    pending: () => call('pending', Pending),
    status: () => call('status', Status),
    async ack(messageIds) {
      let acked = 0
      for (let i = 0; i < messageIds.length; i += ACK_BATCH) {
        const result = await call('ack', Acked, { messageIds: messageIds.slice(i, i + ACK_BATCH) })
        acked += result.acked
      }
      return acked
    },
  }
}
