import { AGENTS, listOf } from './onboarding'
import type { View } from './routing'

export interface GuideSkill {
  skill: string
  title: string
  purpose: string
  prompts: string[]
}

export interface GuidePart {
  title: string
  body: string
}

export const GUIDE_TITLE = 'Getting Started'

export const AGENT_HOSTS = AGENTS.split(',').map((host) => host.trim())

export const DASHBOARD_PART: GuidePart = {
  title: 'What The Dashboard Does',
  body: 'Applications, Jobs, Profile and Settings show your data and let you edit it.',
}

export const AGENT_PART: GuidePart = {
  title: 'What Your Agent Does',
  body: `Finding jobs, writing CVs and applying run in your agent. Open ${listOf(AGENT_HOSTS)} in your Job Duck workspace folder and ask in plain words, for example:`,
}

export const GUIDE_SKILLS: GuideSkill[] = [
  { skill: 'setup', title: 'Setup', purpose: 'Set up Job Duck or change your settings.', prompts: ['Change my job search settings', 'Import my resume'] },
  { skill: 'find', title: 'Find Jobs', purpose: 'Search for postings that fit you and score them.', prompts: ['Find jobs', 'Anything new this week?'] },
  { skill: 'augment', title: 'Augment Profile', purpose: 'Turn your experience into reviewable profile facts.', prompts: ['Augment my profile'] },
  { skill: 'cv', title: 'CV', purpose: 'Write or tailor a CV from your profile facts only.', prompts: ['Tailor my CV for <role>', 'Write my CV'] },
  { skill: 'apply', title: 'Apply', purpose: 'Fill and submit applications after your approval.', prompts: ['Apply to my shortlist', 'Apply to this posting <url>'] },
  { skill: 'track', title: 'Track', purpose: 'Show your pipeline and update application statuses.', prompts: ['Show my pipeline', 'Mark <company> as rejected'] },
  { skill: 'interview', title: 'Interview', purpose: 'Prepare for an interview and record how it went.', prompts: ['Prep me for my interview at <company>', 'Mock interview'] },
  { skill: 'interview-mail', title: 'Interview Mail', purpose: 'Find interview mail and draft replies for your OK.', prompts: ['Check my interview mail', 'Any interview invites?'] },
  { skill: 'follow-up', title: 'Follow-Up', purpose: 'Draft thank-you notes and follow-ups for you to send.', prompts: ['Any follow-ups due?', 'Draft a thank-you note'] },
  { skill: 'sort-mail', title: 'Sort Mail', purpose: 'Label and archive clear confirmations and rejections.', prompts: ['Sort my job mail', 'File my rejections'] },
]

export const GUIDE_SEEN_KEY = 'jobduck.gettingStarted.seen'

export interface GuideStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function guideSeen(storage: GuideStorage): boolean {
  try {
    return storage.getItem(GUIDE_SEEN_KEY) === '1'
  } catch {
    return false
  }
}

export function markGuideSeen(storage: GuideStorage): void {
  try {
    storage.setItem(GUIDE_SEEN_KEY, '1')
  } catch {
    return
  }
}

export const shouldAutoShowGuide = ({ view, needsWelcome, seen }: { view: View; needsWelcome: boolean; seen: boolean }): boolean =>
  view !== 'welcome' && !needsWelcome && !seen
