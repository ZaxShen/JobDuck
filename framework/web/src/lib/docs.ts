import type { Draft } from '@/lib/forms'
import type { PermissionsView, ProfileView } from '@/lib/types'

export const PROFILE_DOC = {
  url: '/api/profile',
  saved: 'Profile saved.',
  fromView: (view: ProfileView): Draft => ({
    front_matter: view.front_matter,
    sections: Object.fromEntries(view.sections.map((section) => [section.title, section.content])),
  }),
  body: (draft: Draft, original: Draft, view: ProfileView) => {
    const before = original.sections as Record<string, string>
    const sections = Object.fromEntries(Object.entries(draft.sections as Record<string, string>)
      .filter(([title, content]) => content !== (before[title] ?? '')))
    return { front_matter: draft.front_matter, sections, revision: view.revision }
  },
}

export const SETTINGS_DOC = {
  url: '/api/permissions',
  saved: 'Settings saved.',
  fromView: (view: PermissionsView): Draft => view.permissions,
  body: (draft: Draft, _original: Draft, view: PermissionsView) => ({ permissions: draft, revision: view.revision }),
}

export function profileEmpty(view: ProfileView): boolean {
  const front = view.front_matter
  return !front.name && !front.email && view.sections.every((section) => !section.content.trim())
}
