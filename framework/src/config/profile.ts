import { readFileSync } from 'node:fs'
import { parse } from 'smol-toml'
import { z } from 'zod'
import { profilePath } from '../paths'

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

export function parseProfile(text: string): Profile {
  const match = FRONT_MATTER.exec(text)
  if (!match) return { frontMatter: ProfileFrontMatter.parse({}), body: text }
  return { frontMatter: ProfileFrontMatter.parse(parse(match[1] ?? '')), body: match[2] ?? '' }
}

export function loadProfile(path = profilePath()): Profile {
  return parseProfile(readFileSync(path, 'utf8'))
}
