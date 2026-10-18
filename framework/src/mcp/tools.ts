import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { loadPermissions, MODULES } from '../config/permissions'
import { loadProfile } from '../config/profile'
import {
  APPLICATION_STATUSES, createApplication, EVENT_SOURCES, findApplicationsByCompanyTitle,
  getLiveApplicationForPosting, listApplicationsWithPostings, setStatus, summarizeApplication,
} from '../db/applications'
import { type Db, one } from '../db/client'
import { findPostingByUrl, type Posting, upsertPosting } from '../db/postings'
import { type FetchLike, searchJobs } from '../freehire/client'
import { toPostingInput } from '../freehire/map'
import { permissionsPath, profilePath } from '../paths'

export interface ToolDeps {
  db: Db
  home: string
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
}

export const TOOL_NAMES = [
  'get_profile', 'get_permissions', 'search_jobs', 'find_application',
  'record_application', 'update_status', 'list_applications',
] as const

export const TRACK_DISABLED = 'track module is disabled in permissions.toml; run the setup skill'

export const EXTRACTED_KEYS = [
  'title_clean', 'company', 'canonical_role', 'team_org', 'experience_level', 'min_experience_years',
  'education_requirement', 'job_type', 'work_mode', 'locations', 'pay_period', 'pay_min', 'pay_max', 'currency',
  'pay_quote', 'bonus_eligible', 'bonus_pct_min', 'bonus_pct_max', 'bonus_amount_min', 'bonus_amount_max',
  'equity_eligible', 'equity_amount_min', 'equity_amount_max', 'equity_period', 'equity_vesting_years',
  'equity_pct_min', 'equity_pct_max', 'stated_total_comp_min', 'stated_total_comp_max', 'comp_quote',
] as const

const LOCATION_KEYS = ['raw', 'country', 'state', 'city', 'work_mode'] as const

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]))
}

export function filterExtracted(extracted: unknown): Record<string, unknown> {
  if (!isPlainObject(extracted)) throw new Error('extracted must be an object')
  const kept = pick(extracted, EXTRACTED_KEYS)
  if (Array.isArray(kept.locations)) {
    kept.locations = kept.locations.filter(isPlainObject).map((location) => pick(location, LOCATION_KEYS))
  }
  return kept
}

function ok(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
}

function fail(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
}

async function run(fn: () => Record<string, unknown> | Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    return ok(await fn())
  } catch (error) {
    return fail(error)
  }
}

const getPosting = (db: Db, id: number) => one<Posting>(db.prepare('SELECT * FROM postings WHERE id = ?'), id)

export const TEXT_CAP = 12_000
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T.*)?$/
export const ISO_DATE_MESSAGE = 'since must be an ISO date: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ'

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntity(entity: string, body: string): string {
  if (body.startsWith('#')) {
    const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
  }
  return ENTITIES[body.toLowerCase()] ?? entity
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity)
    .replace(/\s+/g, ' ')
    .trim()
}

function postingView(posting: Posting | undefined, withText: boolean): Record<string, unknown> | undefined {
  if (!posting) return undefined
  const { description, raw: _raw, ...compact } = posting
  if (!withText) return compact
  const text = htmlToText(description ?? '')
  return { ...compact, text: text.slice(0, TEXT_CAP), truncated: text.length > TEXT_CAP }
}

const Status = z.enum(APPLICATION_STATUSES)
const Source = z.enum(EVENT_SOURCES)

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { db, home } = deps
  const permissions = () => loadPermissions(permissionsPath(home))
  const requireTrack = () => {
    if (!permissions().modules.track) throw new Error(TRACK_DISABLED)
  }

  server.registerTool('get_profile', {
    description: 'Read the user profile (~/.jobduck/profile.md): TOML front matter and free-form body.',
    annotations: { readOnlyHint: true },
  }, () => run(() => ({ ...loadProfile(profilePath(home)) })))

  server.registerTool('get_permissions', {
    description: 'Read permissions.toml: every module switch and manifest, or one module with its settings table.',
    inputSchema: { module: z.enum(MODULES).optional() },
    annotations: { readOnlyHint: true },
  }, ({ module }) => run(() => {
    const parsed = permissions()
    if (module === undefined) return parsed
    const settings = (parsed as Record<string, unknown>)[module]
    return { module, enabled: parsed.modules[module], settings: isPlainObject(settings) ? settings : {} }
  }))

  server.registerTool('search_jobs', {
    description: 'Search freehire.me job postings, save them locally, and report which are already known or applied to.',
    inputSchema: {
      q: z.string().optional(),
      countries: z.array(z.string()).default(['US']),
      posted_within_days: z.number().int().positive().default(7),
      company_slug: z.string().optional(),
      skills: z.array(z.string()).optional(),
      is_tech: z.string().optional().describe("freehire is_tech class, e.g. 'tech'"),
      seniority: z.string().optional(),
      employment_type: z.string().optional(),
      sort: z.enum(['posted_at', 'created_at']).default('posted_at'),
      max_results: z.number().int().positive().max(500).default(50),
    },
  }, (args) => run(async () => {
    const result = await searchJobs(args, { fetch: deps.fetch, sleep: deps.sleep })
    const jobs = result.jobs.map((job) => {
      const input = toPostingInput(job)
      const known = findPostingByUrl(db, input.url) !== undefined
      const posting = upsertPosting(db, input)
      const application = getLiveApplicationForPosting(db, posting.id)
      return {
        posting_id: posting.id,
        title: posting.title,
        company: posting.company,
        location: posting.location,
        work_mode: posting.work_mode,
        pay_min: posting.pay_min,
        pay_max: posting.pay_max,
        currency: posting.currency,
        posted_at: posting.posted_at,
        url: posting.url,
        source_ats: job.source ?? null,
        seniority: job.enrichment?.seniority ?? null,
        employment_type: job.enrichment?.employment_type ?? null,
        skills: job.skills ?? [],
        reality_class: job.reality?.class ?? null,
        known,
        application_id: application?.id ?? null,
        application_status: application?.status ?? null,
      }
    })
    return { total: result.total, returned: jobs.length, jobs }
  }))

  server.registerTool('find_application', {
    description: 'Find a live application by posting URL, or by exact (case-insensitive) company and/or title. '
      + 'Returns { found, application?, posting? }. By default posting is compact: every posting column '
      + '(work_mode, pay_min, pay_max, currency, pay_period, job_type, location, ...) except description and raw. '
      + 'With with_text: true, posting also carries text (the description as plain text: HTML stripped, entities '
      + `decoded, whitespace collapsed, at most ${TEXT_CAP} chars) and truncated (true when text was cut).`,
    inputSchema: {
      url: z.string().optional(),
      company: z.string().optional(),
      title: z.string().optional(),
      with_text: z.boolean().default(false).describe('include the posting description as plain text'),
    },
    annotations: { readOnlyHint: true },
  }, ({ url, company, title, with_text: withText }) => run(() => {
    if (url !== undefined) {
      const found = findPostingByUrl(db, url)
      const posting = postingView(found, withText)
      const application = found ? getLiveApplicationForPosting(db, found.id) : undefined
      return application ? { found: true, application, posting } : { found: false, ...(posting ? { posting } : {}) }
    }
    if (company === undefined && title === undefined) throw new Error('find_application needs url, company or title')
    const application = findApplicationsByCompanyTitle(db, { company, title })[0]
    if (!application) return { found: false }
    return { found: true, application, posting: postingView(getPosting(db, application.posting_id), withText) }
  }))

  server.registerTool('record_application', {
    description: 'Record an application for a posting URL (requires the track module). Returns the JobDuck-Application-Id marker.',
    inputSchema: {
      url: z.string(),
      title: z.string(),
      company: z.string(),
      location: z.string().optional(),
      status: Status.default('applied'),
      applied_at: z.string().optional(),
      note: z.string().optional(),
      extracted: z.unknown().optional(),
      source: Source.default('agent'),
    },
  }, (args) => run(() => {
    requireTrack()
    const extracted = args.extracted === undefined ? undefined : filterExtracted(args.extracted)
    const existing = findPostingByUrl(db, args.url)
    const duplicate = existing ? getLiveApplicationForPosting(db, existing.id) : undefined
    if (duplicate) return { duplicate: true, application: duplicate }
    const posting = upsertPosting(db, {
      source: 'agent', url: args.url, title: args.title, company: args.company, location: args.location,
    })
    const application = createApplication(db, {
      postingId: posting.id, status: args.status, source: args.source,
      appliedAt: args.applied_at, note: args.note, extracted,
    })
    return { application, posting, marker: `JobDuck-Application-Id: ${application.id}` }
  }))

  server.registerTool('update_status', {
    description: 'Change an application status and log the event (requires the track module). '
      + 'A note is stored on the event and appended to the application note (newline-separated).',
    inputSchema: { id: z.number().int().positive(), status: Status, note: z.string().optional(), source: Source.default('agent') },
  }, ({ id, status, note, source }) => run(() => {
    requireTrack()
    return { application: setStatus(db, id, status, { note, source }) }
  }))

  server.registerTool('list_applications', {
    description: 'List live applications with their posting title, company, location and URL, most recently updated first.',
    inputSchema: {
      status: z.union([Status, z.array(Status)]).optional(),
      since: z.string().regex(ISO_DATE, ISO_DATE_MESSAGE).optional()
        .describe('ISO date (YYYY-MM-DD) or timestamp; only applications updated at or after it'),
      limit: z.number().int().positive().max(200).default(50),
    },
    annotations: { readOnlyHint: true },
  }, ({ status, since, limit }) => run(() => ({
    applications: listApplicationsWithPostings(db, { status, since, limit }).map(summarizeApplication),
  })))
}
