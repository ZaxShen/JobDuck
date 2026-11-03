import { COMPANY_STAGES } from './forms'
import { MAX_UPLOAD_BYTES } from './inbox'

export const WIZARD_STEPS = ['Welcome', 'Career DNA', 'Targets', 'Modules', 'Done'] as const
export const RESUME_TYPES = ['.pdf', '.docx', '.md', '.txt'] as const
export const WORK_MODES = ['remote', 'hybrid', 'onsite'] as const
export const ANY_MODE = 'any'

export interface Quiz {
  builder: number
  team: string
  mode: string
  risk: number
  motivation: number
}

export const DEFAULT_QUIZ: Quiz = { builder: 50, team: 'small', mode: 'remote', risk: 50, motivation: 50 }

interface SliderQuestion {
  key: 'builder' | 'risk' | 'motivation'
  title: string
  subtitle: string
  left: string
  right: string
}

interface ToggleQuestion {
  key: 'team' | 'mode'
  title: string
  subtitle: string
  options: readonly (readonly [string, string])[]
}

export type Question = SliderQuestion | ToggleQuestion

export const QUIZ: readonly Question[] = [
  { key: 'builder', title: 'Build New Or Improve?', subtitle: 'Do You Like Starting Things From Scratch, Or Making Existing Things Better?', left: 'Start From Scratch', right: 'Improve What Exists' },
  { key: 'risk', title: 'Startup Or Established Company?', subtitle: 'What Kind Of Environment Fits You?', left: 'Startup', right: 'Established Company' },
  { key: 'team', title: 'Team Size', subtitle: 'Where Do You Do Your Best Work?', options: [['small', 'Small Teams'], ['large', 'Large Orgs']] },
  { key: 'mode', title: 'Work Mode', subtitle: 'How Do You Prefer To Work?', options: [['remote', 'Remote'], ['hybrid', 'Hybrid'], ['onsite', 'On-Site'], [ANY_MODE, 'Any']] },
  { key: 'motivation', title: 'What Drives You?', subtitle: 'What Matters Most In Your Next Move?', left: 'Learning And Growth', right: 'Pay' },
]

export const isToggle = (question: Question): question is ToggleQuestion => 'options' in question

export const workModesOf = (mode: string): string[] => (mode === ANY_MODE ? [...WORK_MODES] : [mode])

export function modeOf(workModes: readonly string[]): string | undefined {
  if (WORK_MODES.every((mode) => workModes.includes(mode))) return ANY_MODE
  const first = workModes[0]
  return first !== undefined && (WORK_MODES as readonly string[]).includes(first) ? first : undefined
}

export const extension = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

export const companyStages = (risk: number): string[] =>
  risk < 34 ? COMPANY_STAGES.slice(0, 4) : risk > 66 ? COMPANY_STAGES.slice(4) : []

export function careerDna(quiz: Quiz): string {
  return QUIZ.map((question) => {
    const title = question.title.replace(/\?$/, '')
    if (isToggle(question)) {
      const value = quiz[question.key]
      return `- ${title}: ${question.options.find(([option]) => option === value)?.[1] ?? value}`
    }
    const value = quiz[question.key]
    const lean = value < 34 ? `leans ${question.left}` : value > 66 ? `leans ${question.right}` : 'balanced'
    return `- ${title}: ${value}/100, ${lean} (0 = ${question.left}, 100 = ${question.right})`
  }).join('\n')
}

export function inboxProblem(file: File): string | undefined {
  if (!(RESUME_TYPES as readonly string[]).includes(extension(file.name))) return `Use one of ${RESUME_TYPES.join(', ')}.`
  if (file.size > MAX_UPLOAD_BYTES) return 'That file is over 15 MB. Put it in inbox/ yourself instead.'
  return undefined
}
