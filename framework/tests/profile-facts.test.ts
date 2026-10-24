import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type Sandbox, migratedDb, sandbox } from './helpers'
import type { Db } from '../src/db/client'
import { deleteFact, type FactInput, getFact, listFacts, saveFacts, updateFact } from '../src/db/profile-facts'

let box: Sandbox
let db: Db
beforeEach(() => {
  box = sandbox()
  db = migratedDb(box.home)
})
afterEach(() => {
  db.close()
  box.cleanup()
})

const stated: FactInput = {
  slug: 'pm-001', company: 'Acme', role: 'Data Engineer', project: 'Pipeline Migration', category: 'action',
  action: 'Migrated 14 nightly batch jobs from cron to a workflow orchestrator.',
  outcome: 'Cut failed nightly runs.', metrics: '14 jobs; 80% fewer failed runs', skills: ['data_migration'],
  tools: ['airflow', 'postgresql'], basis: 'stated', sort_order: 10,
}

const inferred: FactInput = {
  slug: 'pm-002', company: 'Acme', role: 'Data Engineer', project: 'Pipeline Migration', category: 'methodology',
  action: 'Ran migrated jobs alongside cron before cutting over.', outcome: 'Avoided missed nightly loads.',
  metrics: '2 weeks', skills: ['parallel_run'], tools: ['airflow'], basis: 'inferred', confidence: 'medium',
  rationale: 'Parallel runs are the usual way to retire nightly cron jobs without missing data.', sort_order: 20,
}

const COLUMNS = ['id', 'slug', 'company', 'role', 'project', 'category', 'action', 'outcome', 'metrics', 'skills', 'tools',
  'basis', 'confidence', 'rationale', 'status', 'sort_order', 'created_at', 'updated_at']

test('saveFacts stores stated and inferred facts with every column set', () => {
  const result = saveFacts(db, [stated, inferred])
  expect(result).toMatchObject({ inserted: 2, updated: 0 })
  const raw = db.prepare('SELECT * FROM profile_facts ORDER BY id').all() as Record<string, unknown>[]
  for (const column of COLUMNS) {
    expect(raw[1]![column]).not.toBeNull()
    if (column !== 'confidence' && column !== 'rationale') expect(raw[0]![column]).not.toBeNull()
  }
  expect(raw[0]).toMatchObject({ confidence: null, rationale: null, skills: '["data_migration"]', tools: '["airflow","postgresql"]' })
  expect(raw[1]).toMatchObject({ status: 'proposed', confidence: 'medium', metrics: '2 weeks', sort_order: 20 })

  const [first, second] = listFacts(db)
  expect(first).toMatchObject({ ...stated, confidence: null, rationale: null, status: 'proposed' })
  expect(second).toMatchObject({ ...inferred, status: 'proposed' })
  expect(first!.skills).toEqual(['data_migration'])
  expect(first!.created_at).toBe(first!.updated_at)
})

test('metrics are kept exactly and empty optional fields become null', () => {
  const metrics = '  from 0.48 to 0.96 (200%)  '
  const [fact] = saveFacts(db, [{ project: 'Search', category: 'outcome', action: 'Raised F1.', basis: 'stated', metrics,
    outcome: '', company: ' ' }]).facts
  expect(fact).toMatchObject({ metrics, outcome: null, company: null, slug: null, skills: [], tools: [], sort_order: 0 })
})

test('inferred facts need a confidence and a rationale; stated facts take neither', () => {
  const { confidence: _c, rationale: _r, ...bare } = inferred
  expect(() => saveFacts(db, [bare])).toThrow('facts[0]: confidence: inferred facts need a confidence')
  expect(() => saveFacts(db, [{ ...inferred, rationale: null }])).toThrow('rationale: inferred facts need a rationale')
  expect(() => saveFacts(db, [{ ...stated, confidence: 'high' }])).toThrow('stated facts take no confidence')
  expect(() => saveFacts(db, [{ ...stated, rationale: 'because' }])).toThrow('stated facts take no rationale')
  expect(listFacts(db)).toEqual([])
})

test('validation rejects a bad category, a non-snake_case tag and a long rationale, saving nothing', () => {
  expect(() => saveFacts(db, [stated, { ...inferred, category: 'hobby' as never }])).toThrow('facts[1]: category')
  expect(() => saveFacts(db, [{ ...stated, skills: ['Data Migration'] }])).toThrow('lowercase snake_case')
  expect(() => saveFacts(db, [{ ...stated, tools: ['data-migration'] }])).toThrow('lowercase snake_case')
  const long = Array.from({ length: 26 }, (_, i) => `word${i}`).join(' ')
  expect(() => saveFacts(db, [{ ...inferred, rationale: long }])).toThrow('at most 25 words')
  expect(() => saveFacts(db, [{ ...stated, project: '' }])).toThrow('project')
  expect(() => saveFacts(db, [stated], { status: 'done' as never })).toThrow('status done is not valid')
  expect(listFacts(db)).toEqual([])
  saveFacts(db, [{ ...inferred, rationale: Array.from({ length: 25 }, () => 'word').join(' ') }])
  expect(listFacts(db)).toHaveLength(1)
})

test('a duplicate slug updates that fact instead of adding one', () => {
  const [original] = saveFacts(db, [stated]).facts
  updateFact(db, original!.id, { status: 'accepted' })
  const result = saveFacts(db, [{ ...stated, action: 'Migrated 14 nightly jobs to an orchestrator.' }, { ...stated, slug: null }])
  expect(result).toMatchObject({ inserted: 1, updated: 1 })
  expect(result.facts[0]).toMatchObject({ id: original!.id, action: 'Migrated 14 nightly jobs to an orchestrator.',
    status: 'proposed', created_at: original!.created_at })
  expect(listFacts(db)).toHaveLength(2)
  expect(db.prepare("SELECT COUNT(*) AS n FROM profile_facts WHERE slug = 'pm-001'").get()).toEqual({ n: 1 })
})

test('saveFacts takes a status for importers', () => {
  const { facts } = saveFacts(db, [stated], { status: 'accepted' })
  expect(facts[0]!.status).toBe('accepted')
})

test('listFacts filters by status, company and project and orders by company, project, sort_order, id', () => {
  saveFacts(db, [
    { ...stated, slug: 'b-1', company: 'Globex', project: 'Beta', sort_order: 0 },
    { ...stated, slug: 'a-2', project: 'Alpha', sort_order: 20 },
    { ...stated, slug: 'a-1', project: 'Alpha', sort_order: 10 },
    { ...stated, slug: 'p-1', company: null, role: null, project: 'Side Project' },
  ])
  expect(listFacts(db).map((fact) => fact.slug)).toEqual(['p-1', 'a-1', 'a-2', 'b-1'])
  expect(listFacts(db, { company: 'acme' }).map((fact) => fact.slug)).toEqual(['a-1', 'a-2'])
  expect(listFacts(db, { project: 'beta' }).map((fact) => fact.slug)).toEqual(['b-1'])
  updateFact(db, listFacts(db, { project: 'Beta' })[0]!.id, { status: 'archived' })
  expect(listFacts(db, { status: 'archived' }).map((fact) => fact.slug)).toEqual(['b-1'])
  expect(listFacts(db, { status: ['proposed', 'accepted'] })).toHaveLength(3)
  expect(() => listFacts(db, { status: 'done' as never })).toThrow('status done is not valid')
})

test('updateFact patches any field, validates the result and keeps other fields', () => {
  const { facts: [fact] } = saveFacts(db, [inferred])
  const accepted = updateFact(db, fact!.id, { status: 'accepted', tools: ['airflow', 'dbt'] })
  expect(accepted).toMatchObject({ status: 'accepted', tools: ['airflow', 'dbt'], action: inferred.action, confidence: 'medium' })
  expect(updateFact(db, fact!.id, {})).toEqual(accepted)
  expect(() => updateFact(db, fact!.id, { basis: 'stated' })).toThrow('stated facts take no confidence')
  const confirmed = updateFact(db, fact!.id, { basis: 'stated', confidence: null, rationale: null, outcome: null })
  expect(confirmed).toMatchObject({ basis: 'stated', confidence: null, rationale: null, outcome: null, status: 'accepted' })
  expect(() => updateFact(db, fact!.id, { basis: 'inferred' })).toThrow('inferred facts need a confidence')
  expect(() => updateFact(db, fact!.id, { status: 'done' as never })).toThrow('status done is not valid')
  expect(() => updateFact(db, fact!.id, { category: 'hobby' as never })).toThrow('category')

  saveFacts(db, [stated])
  expect(() => updateFact(db, fact!.id, { slug: 'pm-001' })).toThrow(`slug pm-001 is already used by fact ${fact!.id + 1}`)
  expect(() => updateFact(db, 9999, { status: 'accepted' })).toThrow('fact 9999 not found')
  expect(getFact(db, fact!.id)).toEqual(confirmed)
})

test('a status-only update works on an imported row the schema would reject', () => {
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO profile_facts (id, project, category, action, skills, basis, confidence, created_at, updated_at)
    VALUES (1, 'Search', 'action', 'Built search.', '["Elastic Search"]', 'stated', 'high', ?, ?)`).run(now, now)
  expect(updateFact(db, 1, { status: 'accepted' })).toMatchObject({ status: 'accepted', confidence: 'high', skills: ['Elastic Search'] })
  expect(() => updateFact(db, 1, { action: 'Built site search.' })).toThrow('stated facts take no confidence')
})

test('deleteFact removes one fact and returns it', () => {
  const { facts } = saveFacts(db, [stated, inferred])
  expect(deleteFact(db, facts[0]!.id)).toEqual(facts[0]!)
  expect(listFacts(db).map((fact) => fact.id)).toEqual([facts[1]!.id])
  expect(() => deleteFact(db, facts[0]!.id)).toThrow(`fact ${facts[0]!.id} not found`)
})

test('facts survive deleting every posting and application', () => {
  saveFacts(db, [stated])
  db.exec('DELETE FROM application_events; DELETE FROM applications; DELETE FROM postings')
  expect(listFacts(db)).toHaveLength(1)
})
