export interface SavedSteps {
  quiz: boolean
  targets: boolean
  modules: boolean
}

export interface DoneInput {
  uploaded: boolean
  saved: SavedSteps
  modulesOn: number
}

export interface DoneSummary {
  title: string
  body: string
  nextStep: string
}

export const NOTHING_SAVED: SavedSteps = { quiz: false, targets: false, modules: false }

const listOf = (items: string[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

export function doneSummary({ uploaded, saved, modulesOn }: DoneInput): DoneSummary {
  const nextStep = uploaded ? 'import my resume' : 'import my LinkedIn'
  const items = [
    uploaded && 'your resume',
    saved.quiz && 'your Career DNA answers',
    saved.targets && "what you're looking for",
    saved.modules && 'what Job Duck should do',
  ].filter((item): item is string => Boolean(item))

  if (items.length === 0) {
    return {
      title: 'Nothing saved yet.',
      body: 'You skipped every step. You can fill in your profile any time.',
      nextStep,
    }
  }

  const nothingOn = saved.modules && modulesOn === 0
    ? " Nothing is turned on, so Job Duck won't do anything yet. Turn things on in Settings."
    : ''
  return {
    title: "You're set up.",
    body: `Saved ${listOf(items)}.${nothingOn} Change anything later in Profile or Settings.`,
    nextStep,
  }
}
