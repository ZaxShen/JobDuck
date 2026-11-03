import type { OnboardingStatus } from './types'

export type BannerPage = 'profile' | 'applications'
export type BannerKind = 'empty' | 'pending'

export interface Banner {
  kind: BannerKind
  title: string
  body: string
}

export const AGENTS = 'Claude Code, Codex, Gemini'

export const listOf = (items: string[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

export function bannerFor(status: OnboardingStatus | null, page: BannerPage): Banner | null {
  if (!status) return null
  if (page === 'applications' && !status.profile_empty) return null
  if (status.pending_imports.length > 0) {
    const names = listOf(status.pending_imports.map((file) => file.name))
    return {
      kind: 'pending',
      title: 'Your Resume Is Waiting For Your Agent',
      body: `Open any agent in ${status.workspace} and it imports ${names} automatically.`,
    }
  }
  if (!status.profile_empty) return null
  return {
    kind: 'empty',
    title: 'Your Profile Is Empty',
    body: `Every CV and application is written from your profile. Upload a resume and any agent you open in ${status.workspace} (${AGENTS}) fills it in for you.`,
  }
}

export const LINKEDIN_STEPS = [
  'On your own LinkedIn profile, choose More, then Save to PDF.',
  'Upload that PDF here with Upload A Resume, or put it in the inbox/ folder of your workspace.',
  'Open any agent in your workspace; it imports the file automatically.',
] as const

export const dismissKey = (kind: BannerKind) => `onboarding-banner-dismissed:${kind}`
