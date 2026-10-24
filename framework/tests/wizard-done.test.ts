import { expect, test } from 'bun:test'
import { doneSummary, NOTHING_SAVED } from '../web/src/lib/wizard-done'

test('skipping every step claims nothing was saved', () => {
  const summary = doneSummary({ uploaded: false, saved: NOTHING_SAVED, modulesOn: 2 })
  expect(summary.title).toBe('Nothing saved yet.')
  expect(summary.body).not.toMatch(/saved/i)
  expect(summary.body).toContain('skipped every step')
})

test('a partial save names only what was saved', () => {
  const summary = doneSummary({ uploaded: false, saved: { quiz: true, targets: false, modules: false }, modulesOn: 0 })
  expect(summary.title).toBe("You're set up.")
  expect(summary.body).toContain('Saved your Career DNA answers.')
  expect(summary.body).not.toContain('resume')
  expect(summary.body).not.toContain("what you're looking for")
  expect(summary.body).not.toContain('Nothing is turned on')
})

test('every step saved lists each one in plain words', () => {
  const summary = doneSummary({ uploaded: true, saved: { quiz: true, targets: true, modules: true }, modulesOn: 3 })
  expect(summary.body).toContain(
    "Saved your resume, your Career DNA answers, what you're looking for and what Job Duck should do.",
  )
  expect(summary.body).not.toContain('Nothing is turned on')
})

test('saving modules with none on says so and points to Settings', () => {
  const summary = doneSummary({ uploaded: false, saved: { quiz: false, targets: false, modules: true }, modulesOn: 0 })
  expect(summary.title).toBe("You're set up.")
  expect(summary.body).toContain("Nothing is turned on, so Job Duck won't do anything yet.")
  expect(summary.body).toContain('Settings')
})

test('the next step follows whether a resume was uploaded', () => {
  expect(doneSummary({ uploaded: true, saved: NOTHING_SAVED, modulesOn: 0 }).nextStep).toBe('import my resume')
  expect(doneSummary({ uploaded: false, saved: NOTHING_SAVED, modulesOn: 0 }).nextStep).toBe('import my LinkedIn')
})
