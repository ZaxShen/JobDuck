export interface ApplicationRow {
  id: number
  status: string
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
  posting_title: string
  posting_company: string
  posting_location: string | null
}

export interface ApplicationEvent {
  id: number
  from_status: string | null
  to_status: string
  note: string | null
  source: string
  created_at: string
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
