import { expect, test } from 'bun:test'
import { urlKey } from '../src/db/url-key'

test.each([
  ['https://www.Example.com/Jobs/123/', 'example.com/Jobs/123'],
  ['http://example.com:443/a//b///?utm_source=x#frag', 'example.com/a/b'],
  ['  https://boards.greenhouse.io/acme/jobs/42\n', 'job-boards.greenhouse.io/acme/jobs/42'],
  ['https://boards.greenhouse.io/embed/job_app?for=acme&token=99', 'job-boards.greenhouse.io/acme/jobs/99'],
  ['https://acme.com/careers?gh_jid=77&utm=1', 'acme.com/careers?gh_jid=77'],
  ['https://www.linkedin.com/jobs/view/senior-engineer-at-acme-3812345678/?trk=x', 'linkedin.com/jobs/view/3812345678'],
  ['https://www.linkedin.com/jobs/search?currentJobId=3812345678&keywords=ai', 'linkedin.com/jobs/view/3812345678'],
  ['https://jobs.ashbyhq.com/acme/uuid/application', 'jobs.ashbyhq.com/acme/uuid'],
  ['https://jobs.lever.co/acme/uuid/apply', 'jobs.lever.co/acme/uuid'],
  ['https://www.indeed.com/viewjob?jk=abc&from=serp', 'indeed.com/viewjob?jk=abc'],
  ['https://example.com/viewjob?jk=abc', 'example.com/viewjob'],
])('urlKey(%p) = %p', (input, expected) => {
  expect(urlKey(input)).toBe(expected)
})

test('empty or hostless URLs have no key', () => {
  expect(urlKey('')).toBeNull()
  expect(urlKey(null)).toBeNull()
  expect(urlKey('https:///path')).toBeNull()
})

test('scheme, www and trailing slash variants share a key', () => {
  const keys = ['https://www.acme.com/jobs/1', 'http://acme.com/jobs/1/', 'acme.com/jobs/1?ref=feed'].map(urlKey)
  expect(new Set(keys).size).toBe(1)
})
