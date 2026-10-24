import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FetchLike, FreehireJob } from '../src/freehire/client'
import { atsEndpoint } from '../src/posting/ats'
import { acceptAgentFields } from '../src/posting/evidence'
import type { LookupLike } from '../src/posting/fetch'
import { freehireFields } from '../src/posting/freehire'
import { appleRead, metaCareersRead } from '../src/posting/html'
import { resolvePosting } from '../src/posting/resolve'

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', 'postings', name), 'utf8')
const job = (name: string) => JSON.parse(fixture(name)) as FreehireJob

const lookup: LookupLike = async () => [{ address: '93.184.215.14', family: 4 }]

function routes(map: Record<string, () => Response>): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = []
  const fetch: FetchLike = async (url) => {
    calls.push(url)
    const route = map[url]
    if (!route) throw new Error(`unexpected URL ${url}`)
    return route()
  }
  return { fetch, calls }
}

const html = (body: string, status = 200) => () => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
const json = (body: string) => () => new Response(body, { headers: { 'content-type': 'application/json' } })

const GREENHOUSE_API = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/7002?pay_transparency=true'

describe('resolvePosting', () => {
  test('a complete freehire record needs no fetch', async () => {
    const { fetch, calls } = routes({})
    const record = job('freehire-full.json')
    const result = await resolvePosting({ url: record.url, freehire: record }, { fetch, lookup })
    expect(calls).toEqual([])
    expect(result.fetched).toEqual([])
    expect(result.fields).toMatchObject({
      title: 'Staff Platform Engineer', company: 'Acme', country: 'US', state: 'MD', city: 'Laurel', work_mode: 'hybrid',
      job_type: 'full_time', seniority: 'staff', min_experience_years: 8, pay_min: 180000, pay_max: 220000,
      pay_period: 'year', currency: 'USD', requires_clearance: false, posted_at: '2026-10-16T10:00:00.000Z',
    })
    expect(result.fields.requirements).toEqual([
      { text: '8+ years of software engineering experience', priority: 'required' },
      { text: 'Kubernetes operations', priority: 'preferred' },
    ])
    expect(result.sources.work_mode).toBe('freehire')
    expect(result.sources.pay_min).toBe('freehire')
    expect(result).toMatchObject({ missing: [], pay_stated: true, quality: 'ok', next: 'done', rejected: [] })
  })

  test('a freehire record without work mode or pay fetches the ATS API once', async () => {
    const { fetch, calls } = routes({ [GREENHOUSE_API]: json(fixture('greenhouse-7002.json')) })
    const record = job('freehire-gaps.json')
    const result = await resolvePosting({ url: record.url, freehire: record }, { fetch, lookup })
    expect(calls).toEqual([GREENHOUSE_API])
    expect(result.fetched).toEqual([GREENHOUSE_API])
    expect(result.fields).toMatchObject({
      country: 'US', state: 'TX', city: 'Austin', work_mode: 'hybrid', pay_min: 150000, pay_max: 190000,
      pay_period: 'year', currency: 'USD', seniority: 'senior',
    })
    expect(result.sources).toMatchObject({
      country: 'freehire', state: 'freehire', city: 'freehire', work_mode: 'ats', pay_min: 'ats', pay_max: 'ats',
    })
    expect(result).toMatchObject({ missing: [], pay_stated: true, quality: 'ok', next: 'done' })
  })

  test('a career page with JSON-LD fills every core field', async () => {
    const url = 'https://careers.example.com/jobs/data-engineer'
    const { fetch, calls } = routes({ [url]: html(fixture('page-jsonld.html')) })
    const result = await resolvePosting({ url }, { fetch, lookup })
    expect(calls).toEqual([url])
    expect(result.fields).toMatchObject({
      title: 'Data Engineer', company: 'Acme', country: 'CA', state: 'ON', city: 'Toronto', work_mode: 'remote',
      job_type: 'full_time', pay_min: 110000, pay_max: 135000, pay_period: 'year', currency: 'CAD',
      posted_at: '2026-10-10', closed_at: '2026-11-30T23:59:59.000Z',
    })
    expect(result.sources.pay_min).toBe('page')
    expect(result).toMatchObject({ missing: [], pay_stated: true, next: 'done' })
    expect(result.quality).not.toBe('blocked')
  })

  test('a captcha page is blocked and hands off to the agent browser', async () => {
    const url = 'https://careers.example.com/jobs/2'
    const { fetch, calls } = routes({ [url]: html(fixture('captcha.html')) })
    const result = await resolvePosting({ url }, { fetch, lookup })
    expect(calls).toEqual([url])
    expect(result).toMatchObject({ quality: 'blocked', next: 'agent_browser', pay_stated: null })
    expect(result.missing).toEqual(['country', 'city', 'work_mode', 'pay'])
  })

  test('a 403 or a refused fetch is blocked too', async () => {
    const url = 'https://careers.example.com/jobs/3'
    const denied = routes({ [url]: html('Forbidden', 403) })
    expect((await resolvePosting({ url }, { fetch: denied.fetch, lookup })).next).toBe('agent_browser')
    const internal = routes({})
    const result = await resolvePosting({ url: 'http://10.0.0.8/jobs/3' }, { fetch: internal.fetch, lookup })
    expect(internal.calls).toEqual([])
    expect(result).toMatchObject({ quality: 'blocked', next: 'agent_browser', fetched: ['http://10.0.0.8/jobs/3'] })
  })

  test('html the agent supplies is read without any fetch', async () => {
    const { fetch, calls } = routes({})
    const result = await resolvePosting(
      { url: 'https://careers.example.com/jobs/data-engineer', html: fixture('page-jsonld.html') },
      { fetch, lookup },
    )
    expect(calls).toEqual([])
    expect(result.fetched).toEqual([])
    expect(result.fields).toMatchObject({ country: 'CA', city: 'Toronto', work_mode: 'remote', pay_min: 110000 })
    expect(result.next).toBe('done')
  })

  test('an earlier layer wins when the page disagrees', async () => {
    const url = 'https://careers.example.com/jobs/data-engineer'
    const { fetch, calls } = routes({ [url]: html(fixture('page-jsonld.html')) })
    const record = { ...job('freehire-gaps.json'), url }
    const result = await resolvePosting({ url, freehire: record }, { fetch, lookup })
    expect(calls).toEqual([url])
    expect(result.fields).toMatchObject({
      title: 'Senior Backend Engineer', country: 'US', state: 'TX', city: 'Austin', work_mode: 'remote',
    })
    expect(result.sources).toMatchObject({
      title: 'freehire', country: 'freehire', state: 'freehire', city: 'freehire', work_mode: 'page',
    })
  })

  test('agent proposals fill gaps only with evidence from the posting text', async () => {
    const { fetch, calls } = routes({})
    const record = job('freehire-gaps.json')
    const text = `${'Acme builds services behind example.com. '.repeat(6)}You will work from our Austin office on Tuesdays and Thursdays and from home the rest of the week. Cash compensation sits between 150000 and 170000 dollars.`
    const result = await resolvePosting({
      url: record.url,
      freehire: record,
      text,
      agent: [
        { field: 'work_mode', value: 'hybrid', quote: 'Austin office on Tuesdays and Thursdays and from home the rest of the week' },
        { field: 'pay_min', value: 150000, quote: 'between 150000 and 170000 dollars' },
        { field: 'pay_max', value: 175000, quote: 'between 150000 and 170000 dollars' },
        { field: 'city', value: 'Dallas', quote: 'Austin office' },
      ],
    }, { fetch, lookup })
    expect(calls).toEqual([])
    expect(result.fields).toMatchObject({ work_mode: 'hybrid', pay_min: 150000, city: 'Austin' })
    expect(result.fields.pay_max).toBeUndefined()
    expect(result.sources).toMatchObject({ work_mode: 'agent', pay_min: 'agent', city: 'freehire' })
    expect(result.rejected.map((item) => [item.proposal.field, item.reason])).toEqual([
      ['pay_max', 'quote does not contain 175000'],
      ['city', 'city is already set by an earlier layer'],
    ])
    expect(result).toMatchObject({ missing: [], next: 'done' })
  })
})

describe('acceptAgentFields', () => {
  const text = 'Acme is hiring in Denver, Colorado. This is a hybrid role. The salary range is $120K to $140,000 per year.'

  test('accepts a value whose quote is in the text and holds the number', () => {
    const { accepted, rejected } = acceptAgentFields(text, [
      { field: 'work_mode', value: 'Hybrid', quote: 'this is a  HYBRID role' },
      { field: 'pay_min', value: 120000, quote: 'salary range is $120K to $140,000' },
      { field: 'pay_max', value: '140000', quote: 'salary range is $120K to $140,000' },
      { field: 'state', value: 'Colorado', quote: 'Denver, Colorado' },
      { field: 'country', value: 'United States', quote: 'Denver, Colorado' },
    ])
    expect(rejected).toEqual([])
    expect(accepted.map(({ field, value }) => [field, value])).toEqual([
      ['country', 'US'], ['work_mode', 'hybrid'], ['pay_min', 120000], ['pay_max', 140000], ['state', 'CO'],
    ])
  })

  test('rejects a quote that is not in the text', () => {
    const { accepted, rejected } = acceptAgentFields(text, [{ field: 'work_mode', value: 'remote', quote: 'fully remote role' }])
    expect(accepted).toEqual([])
    expect(rejected[0]?.reason).toBe('quote not found in posting text')
  })

  test('rejects a number that is not in its quote', () => {
    const { accepted, rejected } = acceptAgentFields(text, [
      { field: 'pay_min', value: 125000, quote: 'salary range is $120K to $140,000' },
    ])
    expect(accepted).toEqual([])
    expect(rejected[0]?.reason).toBe('quote does not contain 125000')
  })

  test('never replaces a value from an earlier layer', () => {
    const { accepted, rejected } = acceptAgentFields(text, [
      { field: 'work_mode', value: 'hybrid', quote: 'This is a hybrid role' },
      { field: 'pay_max', value: 140000, quote: '$140,000 per year' },
      { field: 'pay_period', value: 'year', quote: 'per year' },
    ], { work_mode: 'onsite', pay_min: 120000 })
    expect(accepted.map((item) => item.field)).toEqual(['pay_period'])
    expect(rejected.map((item) => item.reason)).toEqual([
      'work_mode is already set by an earlier layer',
      'pay_max is already set by an earlier layer',
    ])
  })

  test('rejects unknown fields, empty quotes and invalid values', () => {
    const { rejected } = acceptAgentFields(text, [
      { field: 'salary', value: 1, quote: 'salary' },
      { field: 'city', value: 'Denver', quote: '  ' },
      { field: 'work_mode', value: 'sometimes', quote: 'hybrid role' },
    ])
    expect(rejected.map((item) => item.reason)).toEqual(['unknown field salary', 'quote is empty', 'invalid value for work_mode'])
  })
})

describe('ATS adapters', () => {
  test('maps job board URLs to their JSON APIs', () => {
    const cases: [string, string][] = [
      ['https://job-boards.greenhouse.io/acme/jobs/7002', GREENHOUSE_API],
      ['https://boards.greenhouse.io/embed/job_app?for=acme&token=7002', GREENHOUSE_API],
      ['https://jobs.lever.co/acme/0b5a1f2e-1111-4222-8333-944455556666', 'https://api.lever.co/v0/postings/acme/0b5a1f2e-1111-4222-8333-944455556666'],
      ['https://jobs.ashbyhq.com/acme/0b5a1f2e-1111-4222-8333-944455556666', 'https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true'],
      ['https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin-TX/Engineer_R-100', 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/job/Austin-TX/Engineer_R-100'],
      ['https://jobs.smartrecruiters.com/Acme/7440001-data-engineer', 'https://api.smartrecruiters.com/v1/companies/Acme/postings/7440001'],
    ]
    for (const [url, api] of cases) expect([url, atsEndpoint(url)?.apiUrl]).toEqual([url, api])
    expect(atsEndpoint('https://careers.example.com/jobs/1')).toBeUndefined()
  })

  test('parses a Lever posting with a salary range', () => {
    const endpoint = atsEndpoint('https://jobs.lever.co/acme/0b5a1f2e-1111-4222-8333-944455556666')!
    const read = endpoint.parse({
      text: 'Product Designer', country: 'US', workplaceType: 'remote',
      categories: { location: 'Remote - United States', commitment: 'Full-time' },
      descriptionPlain: 'Design the example.com experience at Acme.',
      salaryRange: { min: 130000, max: 160000, currency: 'USD', interval: 'per-year-salary' },
    })
    expect(read?.fields).toMatchObject({
      title: 'Product Designer', country: 'US', work_mode: 'remote', job_type: 'full_time',
      pay_min: 130000, pay_max: 160000, pay_period: 'year', currency: 'USD',
    })
  })

  test('parses an Ashby job board entry by id', () => {
    const endpoint = atsEndpoint('https://jobs.ashbyhq.com/acme/0b5a1f2e-1111-4222-8333-944455556666')!
    const read = endpoint.parse({
      jobs: [
        { id: 'other', title: 'Other' },
        {
          id: '0b5a1f2e-1111-4222-8333-944455556666', title: 'Support Engineer', location: 'Seattle, WA',
          workplaceType: 'Hybrid', employmentType: 'FullTime', descriptionPlain: 'Help Acme customers.',
          compensation: { summaryComponents: [{ compensationType: 'Salary', minValue: 90000, maxValue: 110000, currencyCode: 'USD', interval: '1 YEAR' }] },
        },
      ],
    })
    expect(read?.fields).toMatchObject({
      title: 'Support Engineer', city: 'Seattle', state: 'WA', country: 'US', work_mode: 'hybrid',
      job_type: 'full_time', pay_min: 90000, pay_max: 110000, pay_period: 'year',
    })
  })

  test('parses Workday and SmartRecruiters payloads', () => {
    const workday = atsEndpoint('https://acme.wd5.myworkdayjobs.com/External/job/Austin-TX/Engineer_R-100')!.parse({
      jobPostingInfo: {
        title: 'Engineer', location: 'Austin, TX', timeType: 'Full time', startDate: '2026-10-01',
        jobDescription: '<p>Build Acme systems.</p><p>Pay range: $100,000 - $130,000 per year</p>',
      },
      hiringOrganization: { name: 'Acme' },
    })
    expect(workday?.fields).toMatchObject({
      title: 'Engineer', company: 'Acme', city: 'Austin', state: 'TX', country: 'US', job_type: 'full_time',
      pay_min: 100000, pay_max: 130000, posted_at: '2026-10-01',
    })
    const smart = atsEndpoint('https://jobs.smartrecruiters.com/Acme/7440001-data-engineer')!.parse({
      name: 'Data Engineer', company: { name: 'Acme' },
      location: { city: 'Berlin', country: 'de', remote: true },
      typeOfEmployment: { id: 'permanent', label: 'Full-time' },
      jobAd: { sections: { jobDescription: { title: 'The role', text: '<p>Build pipelines for example.com.</p>' } } },
    })
    expect(smart?.fields).toMatchObject({ title: 'Data Engineer', company: 'Acme', city: 'Berlin', country: 'DE', work_mode: 'remote', job_type: 'full_time' })
  })
})

describe('embedded readers', () => {
  test('reads public compensation from a careers page script', () => {
    const page = '<script>{"job":{"title":"x","public_compensation":[{"country_code":"GB","compensation_amount_minimum":"£50,000","compensation_amount_maximum":"£60,000"},{"country_code":"US","compensation_amount_minimum":"$120,000/year","compensation_amount_maximum":"$150,000/year"}]}}</script>'
    expect(metaCareersRead(page)?.fields).toMatchObject({ pay_min: 120000, pay_max: 150000, pay_period: 'year', currency: 'USD' })
  })

  test('reads hydration data with a pay footer', () => {
    const data = {
      loaderData: {
        jobDetails: {
          jobsData: {
            postingTitle: 'Software Engineer', locations: [{ city: 'Cupertino', stateProvince: 'California', countryName: 'United States' }],
            jobSummary: 'Build software for example.com.', postingDateMeta: '2026-10-05',
            postingFooters: [{ localizations: { en_US: [{ content: '<p>The base pay range for this role is $140,000 - $250,000 annualized.</p>' }] } }],
          },
        },
      },
    }
    const page = `<script>window.__staticRouterHydrationData = JSON.parse(${JSON.stringify(JSON.stringify(data))});</script>`
    expect(appleRead(page)?.fields).toMatchObject({
      title: 'Software Engineer', city: 'Cupertino', state: 'CA', country: 'US', pay_min: 140000, pay_max: 250000, posted_at: '2026-10-05',
    })
  })
})

test('freehireFields maps the enrichment block', () => {
  expect(freehireFields(job('freehire-gaps.json'))).toMatchObject({
    title: 'Senior Backend Engineer', company: 'Acme', location: 'Austin, Texas, United States', country: 'US',
    city: 'Austin', state: 'TX', job_type: 'full_time', seniority: 'senior', skills: ['go'],
  })
})
