import type { ProfileView } from './types'

export const VIEWS = ['applications', 'profile', 'facts', 'settings', 'welcome'] as const
export type View = (typeof VIEWS)[number]

export const DEFAULT_VIEW: View = 'applications'

export function viewFromHash(hash: string): View {
  const name = hash.replace(/^#/, '')
  return (VIEWS as readonly string[]).includes(name) ? (name as View) : DEFAULT_VIEW
}

export function needsWelcome(view: ProfileView): boolean {
  const titles = view.front_matter.target_titles
  return !view.front_matter.name && (!Array.isArray(titles) || titles.length === 0)
}

export function landingView(hash: string, profile: ProfileView | undefined): View {
  const requested = viewFromHash(hash)
  if (requested === 'welcome' || !profile) return requested
  return needsWelcome(profile) ? 'welcome' : requested
}
