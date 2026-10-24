import type { PostingInput } from '../db/postings'
import { freehireFields } from '../posting/freehire'
import type { FreehireJob } from './client'

export function stripUtmSource(url: string): string {
  const hashAt = url.indexOf('#')
  const fragment = hashAt === -1 ? '' : url.slice(hashAt)
  const withoutFragment = hashAt === -1 ? url : url.slice(0, hashAt)
  const queryAt = withoutFragment.indexOf('?')
  if (queryAt === -1) return url
  const base = withoutFragment.slice(0, queryAt)
  const kept = withoutFragment.slice(queryAt + 1).split('&')
    .filter((param) => param !== '' && param.split('=')[0] !== 'utm_source')
  return `${base}${kept.length > 0 ? `?${kept.join('&')}` : ''}${fragment}`
}

export function toPostingInput(job: FreehireJob): PostingInput {
  const fields = freehireFields(job)
  const payStated = fields.pay_min !== undefined || fields.pay_max !== undefined
  return {
    ...fields,
    source: 'freehire',
    source_id: job.external_id,
    url: stripUtmSource(job.url),
    title: fields.title ?? job.title,
    company: fields.company ?? job.company,
    location: fields.location ?? fields.country,
    pay_stated: payStated ? true : undefined,
    raw: JSON.stringify(job),
  }
}
