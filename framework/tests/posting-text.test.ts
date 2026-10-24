import { describe, expect, test } from 'bun:test'
import { decodeEntities, htmlToText, jsonLdFields, jsonLdPostings, metaFields, splitTitle } from '../src/posting/html'
import {
  extractClearance, extractJobType, extractLocation, extractMinExperience, extractPay, extractWorkMode, jobTypeFromTitle,
  parseLocation, type Pay, seniorityFromTitle, textFields, workModeFromTitle,
} from '../src/posting/text'

const PAY_CASES: [string, Pay][] = [
  ['$120,000 - $150,000 per year', { min: 120000, max: 150000, period: 'year', currency: 'USD' }],
  ['$60/hr', { min: 60, max: 60, period: 'hour', currency: 'USD' }],
  ['120k–150k USD', { min: 120000, max: 150000, period: 'year', currency: 'USD' }],
  ['€50.000', { min: 50000, max: 50000, period: 'year', currency: 'EUR' }],
  ['£45,000 a year', { min: 45000, max: 45000, period: 'year', currency: 'GBP' }],
  ['The annual base salary range for this role is $135,000 to $165,000.', { min: 135000, max: 165000, period: 'year', currency: 'USD' }],
  ['Pay: $45 - $55 per hour', { min: 45, max: 55, period: 'hour', currency: 'USD' }],
  ['CA$90,000 – CA$110,000', { min: 90000, max: 110000, period: 'year', currency: 'CAD' }],
  ['USD 200,000 - 250,000', { min: 200000, max: 250000, period: 'year', currency: 'USD' }],
  ['$150K - $180K + equity', { min: 150000, max: 180000, period: 'year', currency: 'USD' }],
  ['Salary: €60.000 - €75.000 per annum', { min: 60000, max: 75000, period: 'year', currency: 'EUR' }],
  ['Up to $175,000 base salary', { max: 175000, period: 'year', currency: 'USD' }],
  ['Hourly rate: $32.50', { min: 32.5, max: 32.5, period: 'hour', currency: 'USD' }],
  ['$8,000 - $10,000 per month', { min: 8000, max: 10000, period: 'month', currency: 'USD' }],
  ['$1,500/week', { min: 1500, max: 1500, period: 'week', currency: 'USD' }],
  ['$95K–$120K/yr', { min: 95000, max: 120000, period: 'year', currency: 'USD' }],
  ['£45,000 - £55,000 + bonus', { min: 45000, max: 55000, period: 'year', currency: 'GBP' }],
  ['Starting at $25 per hour', { min: 25, period: 'hour', currency: 'USD' }],
  ['$50/hr - $60/hr', { min: 50, max: 60, period: 'hour', currency: 'USD' }],
  ['The salary range is $100,000 - $120,000, plus bonus and equity.', { min: 100000, max: 120000, period: 'year', currency: 'USD' }],
  ['Base pay: 90k - 110k', { min: 90000, max: 110000, period: 'year' }],
]

const NO_PAY = [
  'We offer competitive pay and a 401(k) match.',
  'Acme raised $40M from investors last year.',
  'Includes a $2,000 annual learning stipend.',
  'Join 10,000 engineers building example.com.',
  'Founded in 2015, Acme has 2,000 employees and $1.5 billion in revenue.',
  'Up to $5,000 relocation bonus for new hires.',
]

describe('extractPay', () => {
  for (const [text, expected] of PAY_CASES) {
    test(text, () => {
      expect(extractPay(text)?.value).toEqual(expected)
    })
  }
  for (const text of NO_PAY) {
    test(`no pay: ${text}`, () => {
      expect(extractPay(text)).toBeUndefined()
    })
  }

  test('returns the matched span and reads a bare dollar as the hinted country currency', () => {
    const text = 'Compensation: $100,000 - $120,000 annually.'
    const span = extractPay(text)!
    expect(text.slice(span.start, span.end)).toBe('$100,000 - $120,000')
    expect(extractPay(text, { country: 'CA' })?.value.currency).toBe('CAD')
  })

  test('picks the stated salary over a benefit amount in a longer posting', () => {
    const text = 'Perks include a $1,000 home office budget.\n\nSalary: $140,000 - $160,000 per year.'
    expect(extractPay(text)?.value).toEqual({ min: 140000, max: 160000, period: 'year', currency: 'USD' })
  })
})

describe('parseLocation', () => {
  const cases: [string, ReturnType<typeof parseLocation>][] = [
    ['Laurel, MD', { city: 'Laurel', state: 'MD', country: 'US' }],
    ['Portland, OR 97201', { city: 'Portland', state: 'OR', country: 'US' }],
    ['San Francisco, CA', { city: 'San Francisco', state: 'CA', country: 'US' }],
    ['New York, NY, USA', { city: 'New York', state: 'NY', country: 'US' }],
    ['Birmingham, Alabama, United States', { city: 'Birmingham', state: 'AL', country: 'US' }],
    ['Austin, Texas', { city: 'Austin', state: 'TX', country: 'US' }],
    ['Toronto, ON', { city: 'Toronto', state: 'ON', country: 'CA' }],
    ['Vancouver, BC, Canada', { city: 'Vancouver', state: 'BC', country: 'CA' }],
    ['Montréal, Québec, Canada', { city: 'Montréal', state: 'QC', country: 'CA' }],
    ['Halifax, Nova Scotia', { city: 'Halifax', state: 'NS', country: 'CA' }],
    ['Toronto, Canada', { city: 'Toronto', country: 'CA' }],
    ['Remote - United States', { country: 'US' }],
    ['Remote, US', { country: 'US' }],
    ['Austin, TX - Hybrid', { city: 'Austin', state: 'TX', country: 'US' }],
    ['US-CA-San Jose', { city: 'San Jose', state: 'CA', country: 'US' }],
    ['Munich, Bavaria, Germany', { city: 'Munich', state: 'Bavaria', country: 'DE' }],
    ['London, United Kingdom', { city: 'London', country: 'GB' }],
    ['Remote', {}],
  ]
  for (const [line, expected] of cases) {
    test(line, () => {
      expect(parseLocation(line)).toEqual(expected)
    })
  }

  test('reads a Location line in a posting', () => {
    const text = 'Senior Engineer\nLocation: Denver, CO\nAbout the team'
    const span = extractLocation(text)!
    expect(span.value).toEqual({ city: 'Denver', state: 'CO', country: 'US', location: 'Denver, CO' })
    expect(text.slice(span.start, span.end)).toBe('Location: Denver, CO')
  })
})

describe('other extractors', () => {
  test('work mode', () => {
    expect(extractWorkMode('This is a hybrid role with 3 days onsite.')?.value).toBe('hybrid')
    expect(extractWorkMode('Acme is a remote-first company.')?.value).toBe('remote')
    expect(extractWorkMode('Work on our hybrid cloud platform. This role is onsite in Austin.')?.value).toBe('onsite')
    expect(extractWorkMode('Workplace type: Remote')?.value).toBe('remote')
    expect(extractWorkMode('We value craft and curiosity.')).toBeUndefined()
    expect(workModeFromTitle('Platform Engineer (Remote)')?.value).toBe('remote')
    expect(workModeFromTitle('Remote Sensing Scientist')).toBeUndefined()
  })

  test('job type', () => {
    expect(extractJobType('This is a full-time position.')?.value).toBe('full_time')
    expect(extractJobType('Employment type: Part-time')?.value).toBe('part_time')
    expect(extractJobType('A six-month contract role with Acme.')?.value).toBe('contract')
    expect(jobTypeFromTitle('Software Engineering Intern')?.value).toBe('internship')
  })

  test('seniority from title', () => {
    const cases: [string, string | undefined][] = [
      ['Senior Product Manager', 'senior'], ['Staff Software Engineer', 'staff'], ['Engineering Manager', 'manager'],
      ['Software Engineer II', 'mid'], ['Sr. Data Scientist', 'senior'], ['VP of Engineering', 'executive'],
      ['Director of Design', 'director'], ['Principal Engineer', 'principal'], ['Junior Developer', 'entry'],
      ['Software Engineering Intern', 'intern'], ['Tech Lead, Payments', 'lead'], ['Software Engineer', undefined],
    ]
    for (const [title, expected] of cases) expect([title, seniorityFromTitle(title)?.value]).toEqual([title, expected])
  })

  test('minimum experience and clearance', () => {
    expect(extractMinExperience('3-5 years of professional experience; 8+ years of experience preferred')?.value).toBe(3)
    expect(extractMinExperience('At least five years of relevant work experience')?.value).toBe(5)
    expect(extractMinExperience('Acme was founded 12 years ago.')).toBeUndefined()
    expect(extractClearance('Must hold an active TS/SCI clearance.')?.value).toBe(true)
    expect(extractClearance('No clearance needed.')).toBeUndefined()
  })

  test('textFields combines the extractors', () => {
    const text = 'Location: Laurel, MD\nThis is a full-time, hybrid role.\n5+ years of experience.\nPay: $150,000 - $170,000 per year'
    expect(textFields(text, { title: 'Senior Engineer' })).toEqual({
      location: 'Laurel, MD', city: 'Laurel', state: 'MD', country: 'US', work_mode: 'hybrid', job_type: 'full_time',
      seniority: 'senior', min_experience_years: 5, pay_min: 150000, pay_max: 170000, pay_period: 'year', currency: 'USD',
    })
  })
})

describe('html', () => {
  test('htmlToText keeps block breaks and decodes entities', () => {
    const html = '<head><title>x</title></head><h2>About</h2><p>Acme &amp; friends&nbsp;build&#8212;things.</p><ul><li>One</li><li>Two</li></ul><script>var x = 1</script><p>Line<br>break &#x2014; done</p>'
    expect(htmlToText(html)).toBe('About\n\nAcme & friends build—things.\n\n• One\n• Two\n\nLine\nbreak — done')
    expect(decodeEntities('&lt;p&gt; &unknown; &#0;')).toBe('<p> &unknown; &#0;')
  })

  test('JSON-LD arrays and a bare JobPosting', () => {
    const html = `<script type="application/ld+json">[{"@type":"WebSite"},{"@type":"JobPosting","title":"QA Engineer",
      "hiringOrganization":"Acme","employmentType":"CONTRACTOR","jobLocation":{"address":{"addressLocality":"Leeds","addressRegion":"West Yorkshire","addressCountry":{"name":"United Kingdom"}}},
      "baseSalary":{"currency":"gbp","value":{"value":400,"unitText":"DAY"}},"experienceRequirements":{"monthsOfExperience":36}}]</script>`
    const [posting] = jsonLdPostings(html)
    expect(jsonLdFields(posting!)).toEqual({
      title: 'QA Engineer', company: 'Acme', location: 'Leeds, West Yorkshire, United Kingdom', city: 'Leeds',
      state: 'West Yorkshire', country: 'GB', job_type: 'contract', pay_min: 400, pay_max: 400, pay_period: 'day',
      currency: 'GBP', min_experience_years: 3,
    })
  })

  test('OpenGraph and title splitting', () => {
    expect(splitTitle('Data Engineer - Acme Careers')).toEqual({ title: 'Data Engineer', company: 'Acme' })
    expect(splitTitle('Data Engineer at Acme')).toEqual({ title: 'Data Engineer', company: 'Acme' })
    expect(metaFields('<title>Designer | Acme</title><meta content="Acme Inc" property="og:site_name">'))
      .toEqual({ title: 'Designer', company: 'Acme' })
  })
})
