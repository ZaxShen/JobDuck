import { readFileSync } from 'node:fs'
import { parse, stringify } from 'smol-toml'
import { z } from 'zod'
import { TEMPLATES } from '../assets'
import { permissionsPath } from '../paths'
import { checkRevision, parseOrExplain, readOr, revisionOf, writePrivateFile } from './files'

export const MODULES = ['cv', 'find', 'track', 'apply', 'interview'] as const
export type ModuleName = (typeof MODULES)[number]

const Modules = z.object(
  Object.fromEntries(MODULES.map((name) => [name, z.boolean().default(false)])) as Record<ModuleName, z.ZodDefault<z.ZodBoolean>>,
).strict()

export const AUTONOMY_MODES = ['confirm_each', 'confirm_batch', 'auto_after_approvals'] as const
export const CONSENT_KEYS = ['privacy_policy', 'terms', 'arbitration', 'background_check', 'e_signature', 'marketing_opt_in'] as const
export const UPLOAD_KINDS = ['cv', 'cover_letter', 'portfolio', 'transcript'] as const

const Consents = z.object(
  Object.fromEntries(CONSENT_KEYS.map((key) => [key, z.boolean().default(false)])) as Record<
    (typeof CONSENT_KEYS)[number], z.ZodDefault<z.ZodBoolean>
  >,
).strict()

const Amount = z.number().int().nonnegative().default(0)

export const ApplyManifest = z.object({
  autonomy: z.enum(AUTONOMY_MODES).default('confirm_each'),
  approvals_before_auto: z.number().int().positive().default(10),
  consents: Consents.default(() => Consents.parse({})),
  eeo: z.enum(['decline', 'from_profile']).default('decline'),
  ats_accounts: z.enum(['never', 'reuse', 'create']).default('never'),
  salary_mode: z.enum(['posting_range_upper', 'fixed', 'leave_blank']).default('leave_blank'),
  salary_floor: Amount,
  salary_fixed_total: Amount,
  salary_fixed_base: Amount,
  uploads: z.array(z.enum(UPLOAD_KINDS)).default(() => ['cv' as const]),
  cover_letter: z.enum(['only_when_required', 'never', 'always']).default('only_when_required'),
  tailor_cv: z.enum(['never', 'when_bottleneck', 'always']).default('never'),
  free_text: z.enum(['never', 'draft_for_approval', 'auto_from_profile']).default('draft_for_approval'),
  skip_companies: z.array(z.string()).default(() => []),
  max_per_run: z.number().int().positive().default(10),
  marker: z.boolean().default(true),
  answers: z.record(z.string(), z.string()).default(() => ({})),
}).strict()

export const TrackSettings = z.looseObject({
  sync_url: z.string().default(''),
  sync_token: z.string().default(''),
})

export const CvSettings = z.looseObject({
  page_limit: z.number().int().positive().default(2),
})

export const Permissions = z.object({
  modules: Modules.default(() => Modules.parse({})),
  apply: ApplyManifest.default(() => ApplyManifest.parse({})),
  track: TrackSettings.default(() => TrackSettings.parse({})),
  cv: CvSettings.default(() => CvSettings.parse({})),
})

export type Permissions = z.infer<typeof Permissions>

export function parsePermissions(text: string): Permissions {
  return Permissions.parse(parse(text))
}

export function loadPermissions(path = permissionsPath()): Permissions {
  return parsePermissions(readFileSync(path, 'utf8'))
}

export function isModuleEnabled(name: ModuleName, path = permissionsPath()): boolean {
  return loadPermissions(path).modules[name]
}

const HEADER = [
  '# Job Duck permissions. Edit them in the dashboard (jobduck dashboard, then Settings) or by hand.',
  '# Nothing runs until its module is switched on. CAPTCHAs and verification codes always stop for you.',
]

const COMMENTS: Record<string, string> = {
  'apply.autonomy': 'confirm_each | confirm_batch | auto_after_approvals',
  'apply.approvals_before_auto': 'approved submissions before auto_after_approvals takes over',
  'apply.eeo': 'decline | from_profile',
  'apply.ats_accounts': 'never | reuse | create',
  'apply.salary_mode': 'posting_range_upper | fixed | leave_blank',
  'apply.uploads': 'cv, cover_letter, portfolio, transcript',
  'apply.cover_letter': 'only_when_required | never | always',
  'apply.tailor_cv': 'never | when_bottleneck | always',
  'apply.free_text': 'never | draft_for_approval | auto_from_profile',
  'apply.marker': 'paste the JobDuck-Application-Id marker into an editable field',
}

export function serializePermissions(permissions: Record<string, unknown>): string {
  let table = ''
  const lines: string[] = [...HEADER]
  for (const line of stringify(permissions).trimEnd().split('\n')) {
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header) {
      table = header[1]!
      if (lines.at(-1) !== '') lines.push('')
    }
    const key = /^([A-Za-z0-9_]+) = /.exec(line)?.[1]
    const comment = key === undefined ? undefined : COMMENTS[`${table}.${key}`]
    lines.push(comment === undefined ? line : `${line}  # ${comment}`)
  }
  return `${lines.join('\n')}\n`
}

export interface StoredPermissions {
  permissions: Permissions
  revision: string
}

export function readStoredPermissions(path = permissionsPath()): StoredPermissions {
  const text = readOr(path, TEMPLATES['permissions.toml']!)
  return { permissions: parsePermissions(text), revision: revisionOf(text) }
}

export function writePermissions(input: unknown, revision?: string, path = permissionsPath()): StoredPermissions {
  const text = readOr(path, TEMPLATES['permissions.toml']!)
  checkRevision('permissions.toml', text, revision)
  const permissions = parseOrExplain(Permissions, input, 'permission')
  const next = serializePermissions({ ...(parse(text) as Record<string, unknown>), ...permissions })
  writePrivateFile(path, next)
  return { permissions: parsePermissions(next), revision: revisionOf(next) }
}
