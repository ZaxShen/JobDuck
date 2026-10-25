import type { ProfileView } from './types'

export const VIEWS = ['applications', 'profile', 'settings', 'welcome'] as const
export type View = (typeof VIEWS)[number]

export interface Route {
  view: View
  section: string | null
}

export const DEFAULT_VIEW: View = 'applications'

const ALIASES = new Map([['facts', 'profile/facts']])

export function routeFromHash(hash: string): Route {
  const raw = hash.replace(/^#/, '')
  const [name = '', ...rest] = (ALIASES.get(raw) ?? raw).split('/')
  if (!(VIEWS as readonly string[]).includes(name)) return { view: DEFAULT_VIEW, section: null }
  const view = name as View
  return { view, section: view === 'profile' && rest.join('/') ? rest.join('/') : null }
}

export const viewFromHash = (hash: string): View => routeFromHash(hash).view

export const hashFor = ({ view, section }: Route): string => (section ? `#${view}/${section}` : `#${view}`)

export function profileSection(section: string | null, slugs: readonly string[]): string {
  return section && slugs.includes(section) ? section : (slugs[0] ?? '')
}

export function needsWelcome(view: ProfileView): boolean {
  const titles = view.front_matter.target_titles
  return !view.front_matter.name && (!Array.isArray(titles) || titles.length === 0)
}

export function landingRoute(hash: string, profile: ProfileView | undefined): Route {
  const requested = routeFromHash(hash)
  if (requested.view === 'welcome' || !profile || !needsWelcome(profile)) return requested
  return { view: 'welcome', section: null }
}
