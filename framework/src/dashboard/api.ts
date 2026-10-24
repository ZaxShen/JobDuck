import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { z } from 'zod'
import { RevisionConflict } from '../config/files'
import { readStoredPermissions, writePermissions } from '../config/permissions'
import { TEMPLATE_SECTIONS, isPlaceholder, readStoredProfile, splitSections, updateProfile } from '../config/profile'
import {
  APPLICATION_STATUSES, type ApplicationFields, PAY_FIELDS, type PayField, TERMINAL_STATUSES, getApplication,
  getApplicationWithPosting, listApplicationsWithPostings, listEvents, setStatus, softDeleteApplication,
  updateApplicationFields,
} from '../db/applications'
import type { Db } from '../db/client'
import {
  ContactsSchema, INTERVIEW_STAGES, OFFER_STAGES, STAGE_KINDS, STAGE_OUTCOMES, STAGE_TYPES, addStage, deleteStage,
  getStage, listStages, updateStage,
} from '../db/interviews'
import { OUTCOME_STATUSES, type Outcome, dismissOutcome, getOutcome, listOutcomes, matchOutcome } from '../db/outcomes'
import { permissionsPath, profilePath } from '../paths'

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export interface ApiContext {
  db: Db
  home: string
  workspace?: string
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

const code = (pattern: RegExp, message: string) => text(3).refine((value) => value == null || pattern.test(value), message)
const pay = z.number().int('must be a whole number').nonnegative('must be 0 or more').nullable().optional()

const patchSchema = z.object({
  status: z.enum(APPLICATION_STATUSES).optional(),
  note: text(20_000),
  title_override: text(500),
  company_override: text(500),
  location_override: text(500),
  state_override: text(200),
  city_override: text(200),
  currency: code(/^[A-Za-z]{3}$/, 'must be a 3-letter currency code')
    .transform((value) => (typeof value === 'string' ? value.toUpperCase() : value)),
  country_override: code(/^[A-Z]{2}$/, 'must be 2 uppercase letters (ISO country code)'),
  ...Object.fromEntries(PAY_FIELDS.map((key) => [key, pay])) as Record<PayField, typeof pay>,
}).strict()

const stageFields = {
  scheduled_at: z.string().max(40).nullable().optional()
    .transform((value) => (typeof value === 'string' && value.trim() === '' ? null : value)),
  outcome: z.enum(STAGE_OUTCOMES).nullable().optional(),
  note: text(20_000),
  contacts: ContactsSchema.optional(),
}

const addStageSchema = z.object({
  kind: z.enum(STAGE_KINDS),
  stage_type: z.enum(STAGE_TYPES),
  ...stageFields,
}).strict()

const stagePatchSchema = z.object({ stage_type: z.enum(STAGE_TYPES).optional(), ...stageFields }).strict()

const matchSchema = z.object({ application_id: z.number().int().positive() }).strict()

const listQuerySchema = z.object({
  status: z.enum(APPLICATION_STATUSES).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
})

const outcomesQuerySchema = z.object({ status: z.enum(OUTCOME_STATUSES).optional() })

const profileSchema = z.object({
  front_matter: z.record(z.string(), z.unknown()),
  sections: z.record(z.string().max(200), z.string().max(200_000)).default(() => ({})),
  revision: z.string().max(64).optional(),
}).strict()

const permissionsSchema = z.object({ permissions: z.unknown(), revision: z.string().max(64).optional() }).strict()

export const INBOX_PATH = '/api/inbox'
export const INBOX_EXTENSIONS = ['.pdf', '.docx', '.doc', '.md', '.txt', '.zip', '.csv'] as const
export const INBOX_MAX_FILE_BYTES = 15 * 1024 * 1024
export const INBOX_MAX_NAME_BYTES = 255
const INBOX_JSON_OVERHEAD_BYTES = 4096
export const INBOX_MAX_BODY_BYTES = Math.ceil(INBOX_MAX_FILE_BYTES / 3) * 4 + INBOX_JSON_OVERHEAD_BYTES

const inboxSchema = z.object({
  name: z.string().max(255),
  data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'must be base64').min(1, 'file is empty'),
}).strict()

function inboxName(raw: string): string {
  const name = basename(raw.replace(/\\/g, '/')).trim()
  if (name === '' || name.startsWith('.') || /[\x00-\x1f]/.test(name)) throw new ApiError(400, `invalid file name: ${raw}`)
  if (Buffer.byteLength(name) > INBOX_MAX_NAME_BYTES) throw new ApiError(400, `file name is longer than ${INBOX_MAX_NAME_BYTES} bytes`)
  const extension = extname(name).toLowerCase()
  if (!(INBOX_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new ApiError(400, `unsupported file type ${extension || '(none)'}; use ${INBOX_EXTENSIONS.join(', ')}`)
  }
  return name
}

function saveToInbox(workspace: string | undefined, body: unknown) {
  const inbox = workspace === undefined ? undefined : join(workspace, 'inbox')
  if (inbox === undefined || !existsSync(inbox)) throw new ApiError(409, 'this workspace has no inbox/ folder')
  const input = parse(inboxSchema, body ?? {})
  const name = inboxName(input.name)
  const bytes = Buffer.from(input.data, 'base64')
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : `${stem}-${n}${extension}`
    const path = join(inbox, candidate)
    try {
      writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    chmodSync(path, 0o600)
    return { path, name: candidate }
  }
}

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
  const fields = Object.fromEntries(Object.entries(input)
    .filter(([key, value]) => key !== 'status' && !(key === 'note' && changing) && value !== undefined)) as ApplicationFields
  if (Object.keys(fields).length > 0) saving(() => updateApplicationFields(db, id, fields))
  if (changing && input.status !== undefined) {
    setStatus(db, id, input.status, { source: 'dashboard', note: input.note ?? undefined })
  }
  return requireApplication(db, id)
}

function requireStage(db: Db, id: number) {
  try {
    return getStage(db, id)
  } catch (error) {
    if (error instanceof Error && 'code' in error) throw error
    throw new ApiError(404, `stage ${id} not found`)
  }
}

function postStage(db: Db, id: number, body: unknown) {
  const input = parse(addStageSchema, body ?? {})
  requireApplication(db, id)
  return saving(() => addStage(db, id, {
    kind: input.kind, stageType: input.stage_type, scheduledAt: input.scheduled_at, outcome: input.outcome,
    note: input.note, contacts: input.contacts, source: 'dashboard',
  }))
}

function patchStage(db: Db, id: number, body: unknown) {
  const input = parse(stagePatchSchema, body ?? {})
  requireStage(db, id)
  return saving(() => updateStage(db, id, {
    stageType: input.stage_type, scheduledAt: input.scheduled_at, outcome: input.outcome, note: input.note,
    contacts: input.contacts,
  }))
}

function profileView(home: string) {
  const stored = readStoredProfile(profilePath(home))
  const { sections } = splitSections(stored.body)
  const standard = new Set(TEMPLATE_SECTIONS.map((section) => section.title.toLowerCase()))
  const find = (title: string) => sections.find((section) => section.title.toLowerCase() === title.toLowerCase())
  return {
    front_matter: stored.frontMatter,
    sections: [
      ...TEMPLATE_SECTIONS.map((template) => {
        const found = find(template.title)
        const content = found && !isPlaceholder(found) ? found.content : ''
        return { title: found?.title ?? template.title, content, hint: template.content, standard: true }
      }),
      ...sections.filter((section) => !standard.has(section.title.toLowerCase()))
        .map((section) => ({ ...section, hint: '', standard: false })),
    ],
    revision: stored.revision,
    path: profilePath(home),
  }
}

function permissionsView(home: string) {
  return { ...readStoredPermissions(permissionsPath(home)), path: permissionsPath(home) }
}

function saving<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof RevisionConflict) throw new ApiError(409, error.message)
    if (error instanceof Error && !(error instanceof ApiError) && !('code' in error)) throw new ApiError(400, error.message)
    throw error
  }
}

type Handler = (ctx: ApiContext, req: ApiRequest, id: number) => unknown

const routes: { method: string; pattern: RegExp; handler: Handler }[] = [
  { method: 'GET', pattern: /^\/api\/profile$/, handler: ({ home }) => profileView(home) },
  {
    method: 'PUT', pattern: /^\/api\/profile$/,
    handler: ({ home }, req) => {
      const input = parse(profileSchema, req.body ?? {})
      saving(() => updateProfile(
        { frontMatter: input.front_matter, sections: input.sections, revision: input.revision }, profilePath(home),
      ))
      return profileView(home)
    },
  },
  { method: 'GET', pattern: /^\/api\/permissions$/, handler: ({ home }) => permissionsView(home) },
  {
    method: 'PUT', pattern: /^\/api\/permissions$/,
    handler: ({ home }, req) => {
      const input = parse(permissionsSchema, req.body ?? {})
      saving(() => writePermissions(input.permissions, input.revision, permissionsPath(home)))
      return permissionsView(home)
    },
  },
  { method: 'POST', pattern: new RegExp(`^${INBOX_PATH}$`), handler: ({ workspace }, req) => saveToInbox(workspace, req.body) },
  { method: 'GET', pattern: /^\/api\/summary$/, handler: ({ db }) => summary(db) },
  {
    method: 'GET', pattern: /^\/api\/statuses$/,
    handler: () => ({ statuses: APPLICATION_STATUSES, terminal: TERMINAL_STATUSES }),
  },
  {
    method: 'GET', pattern: /^\/api\/stage-types$/,
    handler: () => ({ interviewing: INTERVIEW_STAGES, offered: OFFER_STAGES, outcomes: STAGE_OUTCOMES }),
  },
  {
    method: 'GET', pattern: /^\/api\/applications$/,
    handler: ({ db }, req) => listApplicationsWithPostings(db, { limit: 500, ...parse(listQuerySchema, queryObject(req.query)) }),
  },
  {
    method: 'GET', pattern: /^\/api\/applications\/(\d+)$/,
    handler: ({ db }, _req, id) => ({
      application: requireApplication(db, id), events: listEvents(db, id), stages: listStages(db, id),
    }),
  },
  { method: 'POST', pattern: /^\/api\/applications\/(\d+)\/stages$/, handler: ({ db }, req, id) => postStage(db, id, req.body) },
  { method: 'PATCH', pattern: /^\/api\/stages\/(\d+)$/, handler: ({ db }, req, id) => patchStage(db, id, req.body) },
  {
    method: 'DELETE', pattern: /^\/api\/stages\/(\d+)$/,
    handler: ({ db }, _req, id) => {
      requireStage(db, id)
      return deleteStage(db, id)
    },
  },
  { method: 'PATCH', pattern: /^\/api\/applications\/(\d+)$/, handler: ({ db }, req, id) => patchApplication(db, id, req.body) },
  {
    method: 'DELETE', pattern: /^\/api\/applications\/(\d+)$/,
    handler: ({ db }, _req, id) => {
      if (!softDeleteApplication(db, id)) throw new ApiError(404, `application ${id} not found`)
      return { ok: true }
    },
  },
  {
    method: 'GET', pattern: /^\/api\/outcomes$/,
    handler: ({ db }, req) => listOutcomes(db, parse(outcomesQuerySchema, queryObject(req.query))).map(withCandidates),
  },
  {
    method: 'POST', pattern: /^\/api\/outcomes\/(\d+)\/match$/,
    handler: ({ db }, req, id) => {
      const { application_id } = parse(matchSchema, req.body ?? {})
      if (!getOutcome(db, id)) throw new ApiError(404, `outcome ${id} not found`)
      if (!getApplication(db, application_id)) throw new ApiError(404, `application ${application_id} not found`)
      return matchOutcome(db, id, application_id, { source: 'dashboard' })
    },
  },
  {
    method: 'POST', pattern: /^\/api\/outcomes\/(\d+)\/dismiss$/,
    handler: ({ db }, _req, id) => {
      if (!getOutcome(db, id)) throw new ApiError(404, `outcome ${id} not found`)
      return dismissOutcome(db, id)
    },
  },
]

export function handleApi(ctx: ApiContext, req: ApiRequest): ApiResponse {
  const matching = routes.filter((route) => route.pattern.test(req.path))
  if (matching.length === 0) return { status: 404, body: { error: 'not found' } }
  const route = matching.find((candidate) => candidate.method === req.method)
  if (!route) return { status: 405, body: { error: 'method not allowed' } }
  const id = Number(route.pattern.exec(req.path)?.[1] ?? 0)
  try {
    return { status: 200, body: route.handler(ctx, req, id) }
  } catch (error) {
    if (error instanceof ApiError) return { status: error.status, body: { error: error.message } }
    throw error
  }
}
