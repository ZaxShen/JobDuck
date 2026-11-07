import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { type Sandbox, migratedDb, sandbox } from './helpers'
import type { Db } from '../src/db/client'
import {
  createApplication, listPostingsWithApplications, setStatus, softDeleteApplication,
} from '../src/db/applications'
import { upsertPosting } from '../src/db/postings'
import { type Dashboard, startDashboard } from '../src/dashboard/server'

let box: Sandbox
let db: Db
let ids: { applied: number; saved: number; fresh: number; deleted: number; undated: number }

const posting = (n: number, title: string, company: string, postedAt?: string) =>
  upsertPosting(db, {
    source: n % 2 === 0 ? 'freehire' : 'agent', url: `https://jobs.example.com/${n}`, title, company,
    location: 'Remote', posted_at: postedAt,
  }).id

beforeEach(() => {
  box = sandbox()
  db = migratedDb(box.home)
  ids = {
    applied: posting(1, 'Software Engineer', 'Acme', '2026-01-04T00:00:00.000Z'),
    saved: posting(2, 'Data Analyst', 'Beta Labs', '2026-01-03T00:00:00.000Z'),
    fresh: posting(3, 'Product Designer', 'Gamma', '2026-01-02T00:00:00.000Z'),
    deleted: posting(4, 'QA Engineer', 'Delta', '2026-01-01T00:00:00.000Z'),
    undated: posting(5, 'Support Specialist', 'Acme'),
  }
  createApplication(db, { postingId: ids.applied, status: 'applied', appliedAt: '2026-01-05T00:00:00.000Z' })
  createApplication(db, { postingId: ids.saved, status: 'saved' })
  softDeleteApplication(db, createApplication(db, { postingId: ids.deleted, status: 'applied' }).id)
})

afterEach(() => {
  db.close()
  box.cleanup()
})

describe('listPostingsWithApplications', () => {
  test('lists every posting newest first with its live application', () => {
    const rows = listPostingsWithApplications(db)
    expect(rows.map((row) => row.id)).toEqual([ids.undated, ids.applied, ids.saved, ids.fresh, ids.deleted])
    const byId = new Map(rows.map((row) => [row.id, row]))
    const applied = byId.get(ids.applied)!
    expect(applied.application_id).not.toBeNull()
    expect(applied.application_status).toBe('applied')
    expect(applied.applied_at).toBe('2026-01-05T00:00:00.000Z')
    expect(applied).toMatchObject({ title: 'Software Engineer', company: 'Acme', location: 'Remote', url: 'https://jobs.example.com/1' })
    expect(Object.keys(applied).sort()).toEqual([
      'application_id', 'application_status', 'applied_at', 'company', 'created_at', 'id', 'location', 'posted_at',
      'title', 'url', 'work_mode',
    ])

    const saved = byId.get(ids.saved)!
    expect(saved.application_status).toBe('saved')
    expect(saved.application_id).not.toBeNull()
    expect(saved.applied_at).toBeNull()

    for (const id of [ids.fresh, ids.deleted, ids.undated]) {
      expect(byId.get(id)).toMatchObject({ application_id: null, application_status: null, applied_at: null })
    }
  })

  test('not_applied keeps only postings without a live application', () => {
    expect(listPostingsWithApplications(db, { status: 'not_applied' }).map((row) => row.id))
      .toEqual([ids.undated, ids.fresh, ids.deleted])
  })

  test('a status keeps only postings whose live application has it', () => {
    expect(listPostingsWithApplications(db, { status: 'applied' }).map((row) => row.id)).toEqual([ids.applied])
    expect(listPostingsWithApplications(db, { status: 'saved' }).map((row) => row.id)).toEqual([ids.saved])
    expect(listPostingsWithApplications(db, { status: 'interviewing' })).toEqual([])
  })

  test('follows status changes and honours limit', () => {
    const live = listPostingsWithApplications(db, { status: 'saved' })[0]!
    setStatus(db, live.application_id!, 'applied')
    expect(listPostingsWithApplications(db, { status: 'applied' }).map((row) => row.id)).toEqual([ids.applied, ids.saved])
    expect(listPostingsWithApplications(db, { limit: 2 })).toHaveLength(2)
  })
})

describe('GET /api/postings', () => {
  let dash: Dashboard

  beforeEach(async () => {
    dash = await startDashboard({ home: box.home, port: 0, open: false, out: () => undefined })
  })

  afterEach(async () => {
    await dash.close()
  })

  const get = async (path: string) => {
    const res = await fetch(`${dash.url}${path}`)
    return { res, body: await res.json() as any }
  }

  test('lists postings with their application status', async () => {
    const { res, body } = await get('/api/postings')
    expect(res.status).toBe(200)
    expect(body.postings.map((row: any) => row.id)).toEqual([ids.undated, ids.applied, ids.saved, ids.fresh, ids.deleted])
    expect(body.postings[1]).toMatchObject({ application_status: 'applied', applied_at: '2026-01-05T00:00:00.000Z' })
  })

  test('honours ?status=', async () => {
    expect((await get('/api/postings?status=not_applied')).body.postings.map((row: any) => row.id))
      .toEqual([ids.undated, ids.fresh, ids.deleted])
    expect((await get('/api/postings?status=saved')).body.postings.map((row: any) => row.id)).toEqual([ids.saved])
    expect((await get('/api/postings?status=')).body.postings).toHaveLength(5)
  })

  test('rejects an unknown status with 400', async () => {
    const { res, body } = await get('/api/postings?status=withdrawn')
    expect(res.status).toBe(400)
    expect(body.error).toContain('status')
  })
})
