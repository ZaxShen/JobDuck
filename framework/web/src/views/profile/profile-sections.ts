import { PROFILE_GROUPS, type Group } from '@/lib/forms'

export type SectionBody =
  | { kind: 'fields'; group: Group }
  | { kind: 'markdown'; name: string }
  | { kind: 'add' }
  | { kind: 'facts' }
  | { kind: 'documents' }

export interface SectionItem {
  slug: string
  label: string
  body: SectionBody
}

export interface SectionGroup {
  label: string
  items: SectionItem[]
}

const PERSONAL_SLUGS: Record<string, string> = {
  Contact: 'contact',
  'Work eligibility': 'eligibility',
  "What you're looking for": 'targets',
}

export const FACTS_SLUG = 'facts'
const ADD_SLUG = 'add-section'
const DOCUMENTS_SLUG = 'cv-files'

const slugify = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

function uniqueSlug(text: string, taken: Set<string>): string {
  const base = slugify(text) || 'section'
  let slug = base
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
  taken.add(slug)
  return slug
}

export function profileSections(markdownNames: readonly string[]): SectionGroup[] {
  const personal = PROFILE_GROUPS.map((group) => ({
    slug: PERSONAL_SLUGS[group.title] ?? slugify(group.title),
    label: group.title,
    body: { kind: 'fields', group } as const,
  }))
  const taken = new Set([...personal.map((item) => item.slug), ADD_SLUG, FACTS_SLUG, DOCUMENTS_SLUG])
  const markdown = markdownNames.map((name) => ({
    slug: uniqueSlug(name, taken),
    label: name,
    body: { kind: 'markdown', name } as const,
  }))
  return [
    { label: 'Personal', items: personal },
    { label: 'Background', items: [...markdown, { slug: ADD_SLUG, label: 'Add section', body: { kind: 'add' } }] },
    { label: 'Experience', items: [{ slug: FACTS_SLUG, label: 'Experience facts', body: { kind: 'facts' } }] },
    { label: 'Documents', items: [{ slug: DOCUMENTS_SLUG, label: 'CV files', body: { kind: 'documents' } }] },
  ]
}
