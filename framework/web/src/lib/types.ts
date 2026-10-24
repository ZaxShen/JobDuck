export interface ApplicationRow {
  id: number
  status: string
  pending_reason: string | null
  title: string
  company: string
  location: string | null
  url: string
  work_mode: string | null
  note: string | null
  applied_at: string | null
  updated_at: string
  title_override: string | null
  company_override: string | null
  location_override: string | null
  salary_min: number | null
  salary_max: number | null
  salary_offered: number | null
  rsu: number | null
  options: number | null
  bonus: number | null
  sign_on: number | null
  relocation_fee: number | null
  currency: string | null
  country_override: string | null
  state_override: string | null
  city_override: string | null
  posting_title: string
  posting_company: string
  posting_location: string | null
  posting_country: string | null
  posting_state: string | null
  posting_city: string | null
  posting_pay_min: number | null
  posting_pay_max: number | null
  posting_pay_period: string | null
  posting_currency: string | null
  posting_pay_stated: number | null
}

export interface ApplicationEvent {
  id: number
  from_status: string | null
  to_status: string
  note: string | null
  source: string
  stage_type: string | null
  scheduled_at: string | null
  outcome: string | null
  created_at: string
}

export interface Contact {
  name: string
  title?: string
  email?: string
  phone?: string
  linkedin?: string
}

export type StageKind = 'interviewing' | 'offered'

export interface Stage extends ApplicationEvent {
  to_status: StageKind
  stage_type: string
  contacts: Contact[]
}

export interface StageTypes {
  interviewing: string[]
  offered: string[]
  outcomes: string[]
}

export interface Outcome {
  id: number
  company: string | null
  title: string | null
  job_ref: string | null
  received_at: string
}

export interface Summary {
  counts: Record<string, number>
  needs_match: number
}

export interface Statuses {
  statuses: string[]
  terminal: string[]
}

export type FrontMatter = Record<string, unknown>

export interface ProfileSection {
  title: string
  content: string
  hint: string
  standard: boolean
}

export interface ProfileView {
  front_matter: FrontMatter
  sections: ProfileSection[]
  revision: string
  path: string
}

export type Permissions = Record<string, Record<string, unknown>> & {
  modules: Record<string, boolean>
}

export interface PermissionsView {
  permissions: Permissions
  revision: string
  path: string
}

export interface InboxUpload {
  path: string
  name: string
}

export type FactStatus = 'proposed' | 'accepted' | 'archived'

export interface ProfileFact {
  id: number
  slug: string | null
  company: string | null
  role: string | null
  project: string
  category: string
  action: string
  outcome: string | null
  metrics: string | null
  skills: string[]
  tools: string[]
  basis: 'stated' | 'inferred'
  confidence: 'low' | 'medium' | 'high' | null
  rationale: string | null
  status: FactStatus
  sort_order: number
  created_at: string
  updated_at: string
}
