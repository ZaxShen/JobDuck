import { type Posting, type PostingInput, postingFields, postingSources, upsertPosting } from '../db/postings'
import type { Db } from '../db/client'
import { type FetchLike, FreehireJob, getJob } from '../freehire/client'
import { toPostingInput } from '../freehire/map'
import type { AgentProposal } from '../posting/evidence'
import type { LookupLike } from '../posting/fetch'
import type { PostingFields } from '../posting/fields'
import { type Resolution, resolvePosting } from '../posting/resolve'

export const SEARCH_EXCERPT_CHARS = 1_100

export interface ResolutionDeps {
  fetch?: FetchLike
  lookup?: LookupLike
  sleep?: (ms: number) => Promise<void>
}

export interface AgentEvidence {
  html?: string
  text?: string
  fields?: AgentProposal[]
}

export interface ResolveRequest extends AgentEvidence {
  url: string
  posting?: Posting
  seed?: PostingFields
  detail: boolean
}

export interface ResolvedPosting {
  resolution: Resolution
  input: Omit<PostingInput, 'source' | 'url' | 'title' | 'company'>
}

export function storedFreehire(posting: Posting | undefined): FreehireJob | undefined {
  if (!posting?.raw) return undefined
  try {
    const parsed = FreehireJob.safeParse(JSON.parse(posting.raw))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function publicSlug(job: FreehireJob | undefined): string | undefined {
  const slug = (job as Record<string, unknown> | undefined)?.public_slug
  return typeof slug === 'string' && slug.trim() !== '' ? slug : undefined
}

async function fetchDetail(job: FreehireJob | undefined, deps: ResolutionDeps): Promise<FreehireJob | undefined> {
  const slug = publicSlug(job)
  if (!slug) return undefined
  try {
    return (await getJob(slug, { fetch: deps.fetch, sleep: deps.sleep })) ?? undefined
  } catch {
    return undefined
  }
}

export async function resolveForPosting(request: ResolveRequest, deps: ResolutionDeps): Promise<ResolvedPosting> {
  const stored = storedFreehire(request.posting)
  const detail = request.detail ? await fetchDetail(stored, deps) : undefined
  const known = {
    fields: { ...request.seed, ...(request.posting ? postingFields(request.posting) : {}) },
    sources: request.posting ? postingSources(request.posting) : {},
  }
  const resolution = await resolvePosting({
    url: request.url, freehire: detail ?? stored, known, html: request.html, text: request.text, agent: request.fields,
  }, { fetch: deps.fetch, lookup: deps.lookup })
  return {
    resolution,
    input: {
      ...resolution.fields,
      sources: resolution.sources,
      pay_stated: resolution.pay_stated,
      resolved_at: new Date().toISOString(),
      raw: detail ? JSON.stringify({ ...stored, ...detail }) : undefined,
    },
  }
}

export function resolutionView(resolution: Resolution, posting: Posting): Record<string, unknown> {
  const { missing, next, quality, pay_stated: payStated, fetched, rejected } = resolution
  return { missing, next, quality, pay_stated: payStated, sources: postingSources(posting), fetched, rejected }
}

const holdsSearchExcerpt = (posting: Posting) =>
  posting.resolved_at === null && (posting.description?.length ?? 0) <= SEARCH_EXCERPT_CHARS

export async function withFullDescription(db: Db, posting: Posting, deps: ResolutionDeps): Promise<Posting> {
  const stored = storedFreehire(posting)
  if (!publicSlug(stored) || !holdsSearchExcerpt(posting)) return posting
  const detail = await fetchDetail(stored, deps)
  if (!detail) return posting
  return upsertPosting(db, {
    ...toPostingInput(detail), url: posting.url, raw: JSON.stringify({ ...stored, ...detail }), resolved_at: new Date().toISOString(),
  })
}
