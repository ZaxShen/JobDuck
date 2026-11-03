import { AGENTS, listOf } from './onboarding'

export interface SavedSteps {
  quiz: boolean
  targets: boolean
  modules: boolean
}

export interface DoneInput {
  uploaded: string | null
  saved: SavedSteps
  modulesOn: number
}

export interface NextStep {
  title: string
  body: string
}

export interface DoneSummary {
  title: string
  body: string
  next: NextStep
}

export const NOTHING_SAVED: SavedSteps = { quiz: false, targets: false, modules: false }

export function nextStep(uploaded: string | null): NextStep {
  if (uploaded !== null) {
    return {
      title: 'Open Your Agent In This Folder',
      body: `Any agent you use here (${AGENTS}) will read inbox/${uploaded} and fill in your profile automatically.`,
    }
  }
  return {
    title: 'Add Your LinkedIn Or A Resume',
    body: `On LinkedIn, choose More, then Save to PDF, and put the file in inbox/. Any agent you use here (${AGENTS}) will read it and fill in your profile automatically.`,
  }
}

export function doneSummary({ uploaded, saved, modulesOn }: DoneInput): DoneSummary {
  const next = nextStep(uploaded)
  const items = [
    uploaded !== null && 'your resume',
    saved.quiz && 'your Career DNA answers',
    saved.targets && "what you're looking for",
    saved.modules && 'what Job Duck should do',
  ].filter((item): item is string => Boolean(item))

  if (items.length === 0) {
    return {
      title: 'Nothing Saved Yet.',
      body: 'You skipped every step. You can fill in your profile any time.',
      next,
    }
  }

  const nothingOn = saved.modules && modulesOn === 0
    ? " Nothing is turned on, so Job Duck won't do anything yet. Turn things on in Settings."
    : ''
  return {
    title: "You're Set Up.",
    body: `Saved ${listOf(items)}.${nothingOn} Change anything later in Profile or Settings.`,
    next,
  }
}
