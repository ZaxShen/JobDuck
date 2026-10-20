import { COMPANY_STAGES } from '@/lib/forms'

export const WIZARD_STEPS = ['Welcome', 'Career DNA', 'Targets', 'Modules', 'Done'] as const
export const INBOX_TYPES = ['.pdf', '.docx', '.md', '.txt'] as const
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024
export const WORK_MODES = ['remote', 'hybrid', 'onsite'] as const

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
  { key: 'builder', title: 'Build new or improve?', subtitle: 'Do you like starting things from scratch, or making existing things better?', left: 'Start from scratch', right: 'Improve what exists' },
  { key: 'team', title: 'Team size', subtitle: 'Where do you do your best work?', options: [['small', 'Small teams'], ['large', 'Large orgs']] },
  { key: 'mode', title: 'Work mode', subtitle: 'How do you prefer to work?', options: [['remote', 'Remote'], ['hybrid', 'Hybrid'], ['onsite', 'On-site']] },
  { key: 'risk', title: 'Startup or established company?', subtitle: 'What kind of environment fits you?', left: 'Startup', right: 'Established company' },
  { key: 'motivation', title: 'What drives you?', subtitle: 'What matters most in your next move?', left: 'Learning and growth', right: 'Pay' },
]

export const isToggle = (question: Question): question is ToggleQuestion => 'options' in question

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
  if (!(INBOX_TYPES as readonly string[]).includes(extension(file.name))) return `Use one of ${INBOX_TYPES.join(', ')}.`
  if (file.size > MAX_UPLOAD_BYTES) return 'That file is over 15 MB. Put it in inbox/ yourself instead.'
  return undefined
}

export function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'))
    reader.readAsDataURL(file)
  })
}
