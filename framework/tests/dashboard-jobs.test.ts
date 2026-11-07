import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APPLICATION_STATUSES } from '../src/db/applications'
import { day } from '../web/src/lib/format'
import {
  NOT_APPLIED, appliedText, jobFilterOptions, jobStatusLabel, postedText, postingsPath,
} from '../web/src/lib/jobs'
import { VIEWS, hashFor, routeFromHash } from '../web/src/lib/routing'

describe('jobs route', () => {
  test('#jobs routes to the Jobs view', () => {
    expect(VIEWS).toContain('jobs')
    expect(routeFromHash('#jobs')).toEqual({ view: 'jobs', section: null })
    expect(routeFromHash('#jobs/anything')).toEqual({ view: 'jobs', section: null })
    expect(hashFor(routeFromHash('#jobs'))).toBe('#jobs')
  })

  test('the sidebar has a Jobs nav item', () => {
    const shell = readFileSync(join(import.meta.dir, '../web/src/components/layout/app-shell.tsx'), 'utf8')
    expect(shell).toMatch(/view: 'jobs', label: 'Jobs'/)
  })
})

describe('jobFilterOptions', () => {
  test('All, Not Applied, then every status in order with a Title Case label', () => {
    const options = jobFilterOptions(APPLICATION_STATUSES)
    expect(options.slice(0, 2)).toEqual([{ value: '', label: 'All' }, { value: NOT_APPLIED, label: 'Not Applied' }])
    expect(options.slice(2).map((option) => option.value)).toEqual([...APPLICATION_STATUSES])
    expect(options.find((option) => option.value === 'deny_by_employer')?.label).toBe('Deny By Employer')
    expect(options.find((option) => option.value === 'no_response')?.label).toBe('No Response')
    for (const { label } of options) {
      for (const word of label.split(' ')) expect(word.charAt(0)).toBe(word.charAt(0).toUpperCase())
    }
  })
})

describe('row helpers', () => {
  test('a row with no application reads Not Applied', () => {
    expect(jobStatusLabel({ application_status: null })).toBe('Not Applied')
    expect(jobStatusLabel({ application_status: 'interviewing' })).toBe('Interviewing')
  })

  test('applied text is a dash without applied_at, else the formatted date', () => {
    expect(appliedText({ applied_at: null })).toBe('—')
    expect(appliedText({ applied_at: '2026-01-05T00:00:00.000Z' })).toBe(day('2026-01-05T00:00:00.000Z'))
    expect(postedText({ posted_at: null })).toBe('—')
  })

  test('postingsPath adds the status only when one is chosen', () => {
    expect(postingsPath('')).toBe('/api/postings')
    expect(postingsPath('not_applied')).toBe('/api/postings?status=not_applied')
  })
})
