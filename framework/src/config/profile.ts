import { readFileSync } from 'node:fs'
import { parse, stringify } from 'smol-toml'
import { z } from 'zod'
import { TEMPLATES } from '../assets'
import { profilePath } from '../paths'
import { checkRevision, parseOrExplain, readOr, revisionOf, writePrivateFile } from './files'

const strings = () => z.array(z.string()).default(() => [])

const Links = z.object({
  linkedin: z.string().default(''),
  github: z.string().default(''),
  portfolio: z.string().default(''),
})

const CvFile = z.object({ match: z.string(), path: z.string() })

export const ProfileFrontMatter = z.object({
  name: z.string().default(''),
  email: z.string().default(''),
  phone: z.string().default(''),
  location: z.string().default(''),
  links: Links.default(() => Links.parse({})),
  work_authorization: z.string().default(''),
  sponsorship_required: z.boolean().default(false),
  relocation: z.enum(['yes', 'no', 'ask']).default('ask'),
  target_titles: strings(),
  seniority: strings(),
  work_modes: strings(),
  countries: strings(),
  locations: strings(),
  pay_floor: z.number().nonnegative().default(0),
  currency: z.string().default(''),
  start_date: z.string().default(''),
  education_level: z.string().default(''),
  years_experience: z.number().nonnegative().default(0),
  company_stages: strings(),
  deal_breakers: strings(),
  skip_companies: strings(),
  cv_files: z.array(CvFile).default(() => []),
})

export type ProfileFrontMatter = z.infer<typeof ProfileFrontMatter>

export interface Profile {
  frontMatter: ProfileFrontMatter
  body: string
}

const FRONT_MATTER = /^\+\+\+\r?\n([\s\S]*?)\r?\n\+\+\+\r?\n?([\s\S]*)$/

function splitFrontMatter(text: string): { raw: Record<string, unknown>; body: string } {
  const match = FRONT_MATTER.exec(text)
  if (!match) return { raw: {}, body: text }
  return { raw: parse(match[1] ?? '') as Record<string, unknown>, body: match[2] ?? '' }
}

export function parseProfile(text: string): Profile {
  const { raw, body } = splitFrontMatter(text)
  return { frontMatter: ProfileFrontMatter.parse(raw), body }
}

export function loadProfile(path = profilePath()): Profile {
  return parseProfile(readFileSync(path, 'utf8'))
}

export interface Section {
  title: string
  content: string
}

export interface ProfileBody {
  preamble: string
  sections: Section[]
}

const HEADING = /^# (.+?)\s*$/
const FENCE = /^\s*(```|~~~)/
const tidy = (lines: string[]) => lines.join('\n').replace(/^\s*\n/, '').trimEnd()

export function splitSections(body: string): ProfileBody {
  const preamble: string[] = []
  const sections: { title: string; lines: string[] }[] = []
  let fenced = false
  for (const line of body.split(/\r?\n/)) {
    if (FENCE.test(line)) fenced = !fenced
    const heading = fenced ? null : HEADING.exec(line)
    if (heading) sections.push({ title: heading[1]!, lines: [] })
    else (sections.at(-1)?.lines ?? preamble).push(line)
  }
  return { preamble: tidy(preamble), sections: sections.map(({ title, lines }) => ({ title, content: tidy(lines) })) }
}

export function joinSections({ preamble, sections }: ProfileBody): string {
  const parts = preamble === '' ? [] : [preamble]
  for (const { title, content } of sections) parts.push(content === '' ? `# ${title}` : `# ${title}\n\n${content}`)
  return `${parts.join('\n\n')}\n`
}

export function replaceSections(body: string, updates: Record<string, string>): string {
  const parsed = splitSections(body)
  for (const [title, content] of Object.entries(updates)) {
    const name = title.replace(/^#+\s*/, '').trim()
    if (name === '') throw new Error('section titles must not be empty')
    const existing = parsed.sections.find((section) => section.title.toLowerCase() === name.toLowerCase())
    const text = content.trim()
    if (existing) existing.content = text
    else parsed.sections.push({ title: name, content: text })
  }
  return joinSections(parsed)
}

export const TEMPLATE_SECTIONS: Section[] = splitSections(parseProfile(TEMPLATES['profile.md']!).body).sections

export function isPlaceholder(section: Section): boolean {
  const template = TEMPLATE_SECTIONS.find((candidate) => candidate.title === section.title)
  return template !== undefined && template.content === section.content
}

const optionalShape = (shape: z.ZodRawShape) => Object.fromEntries(Object.entries(shape).map(([key, field]) =>
  [key, (field instanceof z.ZodDefault ? field.unwrap() as z.ZodType : field as z.ZodType).optional()]))

export const ProfileFrontMatterUpdate = z.object({
  ...optionalShape(ProfileFrontMatter.shape),
  links: z.object(optionalShape(Links.shape)).strict().optional(),
}).strict()

export interface ProfileUpdate {
  frontMatter?: Record<string, unknown>
  sections?: Record<string, string>
  revision?: string
}

export interface StoredProfile extends Profile {
  revision: string
}

export function serializeProfile(frontMatter: Record<string, unknown>, body: string): string {
  return `+++\n${stringify(frontMatter).trimEnd()}\n+++\n\n${body.replace(/^\s+/, '').trimEnd()}\n`
}

export function readStoredProfile(path = profilePath()): StoredProfile {
  const text = readOr(path, TEMPLATES['profile.md']!)
  return { ...parseProfile(text), revision: revisionOf(text) }
}

export function updateProfile(update: ProfileUpdate, path = profilePath()): StoredProfile {
  const text = readOr(path, TEMPLATES['profile.md']!)
  checkRevision('profile.md', text, update.revision)
  const { raw, body } = splitFrontMatter(text)
  const current = ProfileFrontMatter.parse(raw)
  const changes = parseOrExplain(ProfileFrontMatterUpdate, update.frontMatter ?? {}, 'profile field')
  const links = { ...current.links, ...(changes.links as Partial<ProfileFrontMatter['links']> | undefined) }
  const frontMatter = parseOrExplain(ProfileFrontMatter, { ...current, ...changes, links }, 'profile field')
  const nextBody = update.sections ? replaceSections(body, update.sections) : body
  const next = serializeProfile({ ...raw, ...frontMatter }, nextBody)
  writePrivateFile(path, next)
  return { ...parseProfile(next), revision: revisionOf(next) }
}
