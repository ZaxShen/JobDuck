import { setPath } from './paths'

export type Draft = Record<string, unknown>
export type Choice = readonly [value: string, label: string]

export interface Column {
  name: string
  label: string
  placeholder: string
}

export interface Field {
  key: string
  label: string
  type?: 'text' | 'email' | 'tel' | 'url' | 'password' | 'checkbox' | 'switch' | 'select' | 'number' | 'tags' | 'checks' | 'record' | 'list' | 'locations' | 'seniority'
  placeholder?: string
  help?: string
  wide?: boolean
  autocomplete?: string
  options?: readonly Choice[]
  suggest?: readonly string[]
  min?: number
  step?: number
  columns?: readonly Column[]
  addLabel?: string
  anyLabel?: string
  when?: (draft: Draft) => boolean
  after?: (draft: Draft, value: unknown) => Draft
}

export interface Group {
  title: string
  help?: string
  fields: Field[]
  when?: (draft: Draft) => boolean
}

const fm = (key: string, label: string, extra: Partial<Field> = {}): Field => ({ key: `front_matter.${key}`, label, ...extra })

export const SENIORITY = ['intern', 'entry', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'executive'] as const
export const COMPANY_STAGES = ['seed', 'series_a', 'series_b', 'series_c', 'growth', 'public'] as const

export const PROFILE_GROUPS: Group[] = [
  {
    title: 'Contact',
    help: 'Used on applications and at the top of your CV.',
    fields: [
      fm('name', 'Full Name', { autocomplete: 'name', placeholder: 'As it should appear on applications' }),
      fm('email', 'Email', { type: 'email', autocomplete: 'email' }),
      fm('phone', 'Phone', { type: 'tel', autocomplete: 'tel' }),
      fm('location', 'Where You Live', { placeholder: 'City, region, country' }),
      fm('links.linkedin', 'LinkedIn', { type: 'url', placeholder: 'https://www.linkedin.com/in/…' }),
      fm('links.github', 'GitHub', { type: 'url', placeholder: 'https://github.com/…' }),
      fm('links.portfolio', 'Portfolio Or Website', { type: 'url', placeholder: 'https://…' }),
    ],
  },
  {
    title: 'Work Eligibility',
    fields: [
      fm('work_authorization', 'Work Authorization', { placeholder: 'In plain words, e.g. citizen, permanent resident, work visa' }),
      fm('sponsorship_required', 'I Need Visa Sponsorship', { type: 'checkbox' }),
      fm('relocation', 'Open To Relocating', { type: 'select', options: [['ask', 'Ask me each time'], ['yes', 'Yes'], ['no', 'No']] }),
      fm('start_date', 'Earliest Start', { placeholder: 'e.g. immediately, two weeks after an offer' }),
      fm('education_level', 'Highest Education', { placeholder: "e.g. Bachelor's degree" }),
      fm('years_experience', 'Years Of Experience', { type: 'number', step: 0.5 }),
    ],
  },
  {
    title: "What You're Looking For",
    help: 'Job Duck only suggests postings that match these. Press Enter after each one.',
    fields: [
      fm('target_titles', 'Target Titles', { type: 'tags', wide: true, placeholder: 'e.g. Software Engineer' }),
      fm('seniority', 'Seniority', { type: 'seniority' }),
      fm('work_modes', 'Work Modes', { type: 'checks', anyLabel: 'Any', options: [['remote', 'Remote'], ['hybrid', 'Hybrid'], ['onsite', 'On-Site']] }),
      fm('countries', 'Countries', { type: 'tags', placeholder: 'ISO codes, e.g. US' }),
      fm('locations', 'Cities Or Regions', { type: 'locations' }),
      fm('pay_floor', 'Minimum Annual Salary (Base)', { type: 'number', step: 1000, help: 'Postings that pay less are skipped. Leave 0 for no minimum.' }),
      fm('currency', 'Currency', { placeholder: 'e.g. USD' }),
      fm('company_stages', 'Company Stages', { type: 'tags', suggest: COMPANY_STAGES }),
      fm('deal_breakers', 'Deal-Breakers', { type: 'tags', wide: true, placeholder: 'e.g. on-call rotation' }),
      fm('skip_companies', 'Companies To Skip', { type: 'tags', wide: true }),
    ],
  },
]

export const CV_FILES: Group = {
  title: 'CV Files',
  help: 'Stock CVs the apply skill uploads. The first whose pattern matches the job title is used.',
  fields: [{
    key: 'front_matter.cv_files', label: 'Files', type: 'list', wide: true, addLabel: 'Add a CV file',
    columns: [
      { name: 'match', label: 'Job Title Pattern', placeholder: 'Job title pattern, e.g. engineer' },
      { name: 'path', label: 'File Path', placeholder: 'Absolute path to the PDF' },
    ],
  }],
}

export const MODULES = [
  ['cv', 'CV', 'Write and tailor CVs from your profile.'],
  ['find', 'Find', 'Search for postings that fit you.'],
  ['track', 'Track', 'Keep applications in the local database and this dashboard.'],
  ['apply', 'Apply', 'Fill in and submit applications in your browser. Turns on Find and Track.'],
  ['interview', 'Interview', 'Prepare for interviews on tracked applications.'],
] as const

export function withModule(modules: Record<string, boolean>, key: string, on: boolean): Record<string, boolean> {
  const next = { ...modules, [key]: on }
  if (key === 'apply' && on) Object.assign(next, { find: true, track: true })
  return next
}

const flag = (path: string) => (draft: Draft) => {
  let node: unknown = draft
  for (const key of path.split('.')) node = node == null ? undefined : (node as Draft)[key]
  return Boolean(node)
}
const applyOn = flag('modules.apply')
const applyValue = (draft: Draft, key: string) => (draft.apply as Draft | undefined)?.[key]

export const SETTINGS_GROUPS: Group[] = [
  {
    title: 'Modules',
    help: 'Nothing runs until its module is on.',
    fields: MODULES.map(([key, label, help]) => ({
      key: `modules.${key}`, label, help, type: 'switch' as const,
      after: key === 'apply'
        ? (draft: Draft, on: unknown) => (on ? setPath(setPath(draft, 'modules.find', true), 'modules.track', true) : draft)
        : undefined,
    })),
  },
  {
    title: 'Applying',
    when: applyOn,
    fields: [
      { key: 'apply.autonomy', label: 'Before Submitting', type: 'select', options: [['confirm_each', 'Ask me before every submission'], ['confirm_batch', 'Ask me once per batch'], ['auto_after_approvals', 'Submit on its own after enough approvals']] },
      { key: 'apply.approvals_before_auto', label: 'Approvals Before Submitting On Its Own', type: 'number', min: 1, when: (d) => applyValue(d, 'autonomy') === 'auto_after_approvals' },
      { key: 'apply.max_per_run', label: 'Most Applications Per Run', type: 'number', min: 1 },
      { key: 'apply.uploads', label: 'Files It May Upload', type: 'checks', options: [['cv', 'CV'], ['cover_letter', 'Cover letter'], ['portfolio', 'Portfolio'], ['transcript', 'Transcript']] },
      { key: 'apply.cover_letter', label: 'Cover Letters', type: 'select', options: [['only_when_required', 'Only when required'], ['never', 'Never'], ['always', 'Always']] },
      { key: 'apply.tailor_cv', label: 'Tailor The CV', type: 'select', options: [['never', 'Never, use my stock CV'], ['when_bottleneck', 'Only when the stock CV hides a must-have'], ['always', 'Always']] },
      { key: 'apply.free_text', label: 'Free-Text Questions', type: 'select', options: [['draft_for_approval', 'Draft an answer for me to approve'], ['auto_from_profile', 'Answer from my profile'], ['never', 'Stop and ask me']] },
      { key: 'apply.eeo', label: 'Demographic Questions', type: 'select', options: [['decline', 'Decline to self-identify'], ['from_profile', 'Answer from my saved answers']] },
      { key: 'apply.ats_accounts', label: 'Job-Site Accounts', type: 'select', options: [['never', 'Stop when a site needs an account'], ['reuse', 'I sign in to accounts I already have'], ['create', 'Create one with my email; I set the password']] },
      { key: 'apply.marker', label: 'Add A Tracking Line To An Optional Free-Text Field', type: 'checkbox', help: 'Lets a later email be matched to the application.' },
      { key: 'apply.skip_companies', label: 'Companies Never To Apply To', type: 'tags', wide: true },
    ],
  },
  {
    title: 'Salary Questions',
    when: applyOn,
    fields: [
      { key: 'apply.salary_mode', label: 'How To Answer', type: 'select', options: [['leave_blank', 'Leave blank; ask me when required'], ['posting_range_upper', "Upper part of the posting's range"], ['fixed', 'Fixed numbers']] },
      { key: 'apply.salary_floor', label: 'Never Below', type: 'number', step: 1000, when: (d) => applyValue(d, 'salary_mode') === 'posting_range_upper' },
      { key: 'apply.salary_fixed_total', label: 'Total Compensation', type: 'number', step: 1000, when: (d) => applyValue(d, 'salary_mode') !== 'leave_blank' },
      { key: 'apply.salary_fixed_base', label: 'Base Salary', type: 'number', step: 1000, when: (d) => applyValue(d, 'salary_mode') === 'fixed' },
    ],
  },
  {
    title: 'Consents It May Give',
    help: 'Checked boxes are agreed to without asking. Unchecked means the agent stops and asks you each time.',
    when: applyOn,
    fields: [
      ['privacy_policy', 'Privacy Policy'], ['terms', 'Terms Of Use'], ['arbitration', 'Arbitration Agreements'],
      ['background_check', 'Background Checks'], ['e_signature', 'Electronic Signature'], ['marketing_opt_in', 'Marketing Emails'],
    ].map(([key, label]) => ({ key: `apply.consents.${key}`, label: label!, type: 'checkbox' as const })),
  },
  {
    title: 'Saved Answers',
    help: 'Answers to questions forms ask often, such as "How did you hear about us?".',
    when: applyOn,
    fields: [{
      key: 'apply.answers', label: 'Answers', type: 'record', wide: true, addLabel: 'Add an answer',
      columns: [{ name: 'key', label: 'Question', placeholder: 'Question' }, { name: 'value', label: 'Answer', placeholder: 'Answer' }],
    }],
  },
  {
    title: 'Email Sync',
    help: 'From the Apps Script web app you deploy for tracking. Ask your agent to "set up tracking" for the steps.',
    when: flag('modules.track'),
    fields: [
      { key: 'track.sync_url', label: 'Web App URL', type: 'url', wide: true, placeholder: 'https://script.google.com/macros/s/…/exec' },
      { key: 'track.sync_token', label: 'Token', type: 'password', autocomplete: 'new-password' },
    ],
  },
  {
    title: 'CVs',
    when: flag('modules.cv'),
    fields: [{ key: 'cv.page_limit', label: 'Page Limit', type: 'number', min: 1 }],
  },
]

export const visibleFields = (group: Group, draft: Draft) => group.fields.filter((field) => !field.when || field.when(draft))

export function withField(draft: Draft, field: Field, value: unknown): Draft {
  const next = setPath(draft, field.key, value)
  return field.after ? field.after(next, value) : next
}

export const fieldId = (formName: string, field: Field) => `${formName}-${field.key.replace(/[^A-Za-z0-9]+/g, '-')}`
