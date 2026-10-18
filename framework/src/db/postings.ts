import { type Db, nowIso, one } from './client'
import { urlKey } from './url-key'

export const POSTING_SOURCES = ['freehire', 'manual', 'agent'] as const
export type PostingSource = (typeof POSTING_SOURCES)[number]

export interface Posting {
  id: number
  source: PostingSource
  source_id: string | null
  url: string
  url_key: string
  title: string
  company: string
  location: string | null
  country: string | null
  state: string | null
  city: string | null
  work_mode: string | null
  job_type: string | null
  posted_at: string | null
  pay_min: number | null
  pay_max: number | null
  pay_period: string | null
  currency: string | null
  description: string | null
  raw: string | null
  created_at: string
  updated_at: string
}

const OPTIONAL_FIELDS = [
  'source_id', 'location', 'country', 'state', 'city', 'work_mode', 'job_type', 'posted_at',
  'pay_min', 'pay_max', 'pay_period', 'currency', 'description', 'raw',
] as const

type OptionalField = (typeof OPTIONAL_FIELDS)[number]

export type PostingInput = Pick<Posting, 'source' | 'url' | 'title' | 'company'> &
  Partial<Pick<Posting, OptionalField>>

export function upsertPosting(db: Db, input: PostingInput): Posting {
  const key = urlKey(input.url)
  if (key === null) throw new Error(`invalid posting URL: ${input.url}`)
  const now = nowIso()
  const columns = ['source', 'url', 'url_key', 'title', 'company', ...OPTIONAL_FIELDS, 'created_at', 'updated_at']
  const values = [
    input.source, input.url, key, input.title, input.company,
    ...OPTIONAL_FIELDS.map((field) => input[field] ?? null),
    now, now,
  ]
  const updates = [
    'url = excluded.url', 'title = excluded.title', 'company = excluded.company',
    ...OPTIONAL_FIELDS.map((field) => `${field} = COALESCE(excluded.${field}, postings.${field})`),
    'updated_at = excluded.updated_at',
  ]
  const sql = `INSERT INTO postings (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
    ON CONFLICT (url_key) DO UPDATE SET ${updates.join(', ')}
    RETURNING *`
  const row = one<Posting>(db.prepare(sql), ...values)
  if (!row) throw new Error('upsertPosting returned no row')
  return row
}

export function findPostingByUrl(db: Db, url: string): Posting | undefined {
  const key = urlKey(url)
  if (key === null) return undefined
  return one<Posting>(db.prepare('SELECT * FROM postings WHERE url_key = ?'), key)
}
