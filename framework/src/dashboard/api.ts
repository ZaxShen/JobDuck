import { z } from 'zod'
import {
  APPLICATION_STATUSES, type ApplicationFields, EDITABLE_FIELDS, TERMINAL_STATUSES, getApplication,
  getApplicationWithPosting, listApplicationsWithPostings, listEvents, setStatus, softDeleteApplication,
  updateApplicationFields,
} from '../db/applications'
import type { Db } from '../db/client'
import { OUTCOME_STATUSES, type Outcome, dismissOutcome, getOutcome, listOutcomes, matchOutcome } from '../db/outcomes'

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export interface ApiRequest {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
}

export interface ApiResponse {
  status: number
  body: unknown
}

const text = (max: number) => z.string().max(max).nullable().optional()
  .transform((value) => (typeof value === 'string' && value.trim() === '' ? null : value))

const patchSchema = z.object({
  status: z.enum(APPLICATION_STATUSES).optional(),
  note: text(20_000),
  title_override: text(500),
  company_override: text(500),
  location_override: text(500),
}).strict()

const matchSchema = z.object({ application_id: z.number().int().positive() }).strict()

const listQuerySchema = z.object({
  status: z.enum(APPLICATION_STATUSES).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
})

const outcomesQuerySchema = z.object({ status: z.enum(OUTCOME_STATUSES).optional() })

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new ApiError(400, issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid request')
  }
  return result.data
}

const queryObject = (query: URLSearchParams) =>
  Object.fromEntries([...query.entries()].filter(([, value]) => value !== ''))

function requireApplication(db: Db, id: number) {
  const row = getApplicationWithPosting(db, id)
  if (!row) throw new ApiError(404, `application ${id} not found`)
  return row
}

function summary(db: Db) {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM applications WHERE deleted_at IS NULL GROUP BY status')
    .all() as { status: string; n: number }[]
  const counts = Object.fromEntries(APPLICATION_STATUSES.map((status) => [status, 0])) as Record<string, number>
  for (const row of rows) counts[row.status] = Number(row.n)
  const needs = db.prepare("SELECT COUNT(*) AS n FROM outcomes WHERE status = 'needs_match'").get() as { n: number }
  return { counts, needs_match: Number(needs.n) }
}

function parseCandidates(value: string | null): unknown[] {
  if (value === null) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const withCandidates = (outcome: Outcome) => ({ ...outcome, candidates: parseCandidates(outcome.candidates) })

function patchApplication(db: Db, id: number, body: unknown) {
  const input = parse(patchSchema, body ?? {})
  const current = getApplication(db, id)
  if (!current) throw new ApiError(404, `application ${id} not found`)
  const changing = input.status !== undefined && input.status !== current.status
  const fields: ApplicationFields = {}
  for (const key of EDITABLE_FIELDS) {
    if (key === 'note' && changing) continue
    if (input[key] !== undefined) fields[key] = input[key]
  }
  if (Object.keys(fields).length > 0) updateApplicationFields(db, id, fields)
  if (changing && input.status !== undefined) {
    setStatus(db, id, input.status, { source: 'dashboard', note: input.note ?? undefined })
  }
  return requireApplication(db, id)
}

type Handler = (db: Db, req: ApiRequest, id: number) => unknown

const routes: { method: string; pattern: RegExp; handler: Handler }[] = [
  { method: 'GET', pattern: /^\/api\/summary$/, handler: (db) => summary(db) },
  {
    method: 'GET', pattern: /^\/api\/statuses$/,
    handler: () => ({ statuses: APPLICATION_STATUSES, terminal: TERMINAL_STATUSES }),
  },
  {
    method: 'GET', pattern: /^\/api\/applications$/,
    handler: (db, req) => listApplicationsWithPostings(db, { limit: 500, ...parse(listQuerySchema, queryObject(req.query)) }),
  },
  {
    method: 'GET', pattern: /^\/api\/applications\/(\d+)$/,
    handler: (db, _req, id) => ({ application: requireApplication(db, id), events: listEvents(db, id) }),
  },
  { method: 'PATCH', pattern: /^\/api\/applications\/(\d+)$/, handler: (db, req, id) => patchApplication(db, id, req.body) },
  {
    method: 'DELETE', pattern: /^\/api\/applications\/(\d+)$/,
    handler: (db, _req, id) => {
      if (!softDeleteApplication(db, id)) throw new ApiError(404, `application ${id} not found`)
      return { ok: true }
    },
  },
  {
    method: 'GET', pattern: /^\/api\/outcomes$/,
    handler: (db, req) => listOutcomes(db, parse(outcomesQuerySchema, queryObject(req.query))).map(withCandidates),
  },
  {
    method: 'POST', pattern: /^\/api\/outcomes\/(\d+)\/match$/,
    handler: (db, req, id) => {
      const { application_id } = parse(matchSchema, req.body ?? {})
      if (!getOutcome(db, id)) throw new ApiError(404, `outcome ${id} not found`)
      if (!getApplication(db, application_id)) throw new ApiError(404, `application ${application_id} not found`)
      return matchOutcome(db, id, application_id, { source: 'dashboard' })
    },
  },
  {
    method: 'POST', pattern: /^\/api\/outcomes\/(\d+)\/dismiss$/,
    handler: (db, _req, id) => {
      if (!getOutcome(db, id)) throw new ApiError(404, `outcome ${id} not found`)
      return dismissOutcome(db, id)
    },
  },
]

export function handleApi(db: Db, req: ApiRequest): ApiResponse {
  const matching = routes.filter((route) => route.pattern.test(req.path))
  if (matching.length === 0) return { status: 404, body: { error: 'not found' } }
  const route = matching.find((candidate) => candidate.method === req.method)
  if (!route) return { status: 405, body: { error: 'method not allowed' } }
  const id = Number(route.pattern.exec(req.path)?.[1] ?? 0)
  try {
    return { status: 200, body: route.handler(db, req, id) }
  } catch (error) {
    if (error instanceof ApiError) return { status: error.status, body: { error: error.message } }
    throw error
  }
}
