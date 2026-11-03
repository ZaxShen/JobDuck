import { expect, test } from 'bun:test'
import { doneSummary, NOTHING_SAVED } from '../web/src/lib/wizard-done'

test('skipping every step claims nothing was saved', () => {
  const summary = doneSummary({ uploaded: null, saved: NOTHING_SAVED, modulesOn: 2 })
  expect(summary.title).toBe('Nothing Saved Yet.')
  expect(summary.body).not.toMatch(/saved/i)
  expect(summary.body).toContain('skipped every step')
})

test('a partial save names only what was saved', () => {
  const summary = doneSummary({ uploaded: null, saved: { quiz: true, targets: false, modules: false }, modulesOn: 0 })
  expect(summary.title).toBe("You're Set Up.")
  expect(summary.body).toContain('Saved your Career DNA answers.')
  expect(summary.body).not.toContain('resume')
  expect(summary.body).not.toContain("what you're looking for")
  expect(summary.body).not.toContain('Nothing is turned on')
})

test('every step saved lists each one in plain words', () => {
  const summary = doneSummary({ uploaded: 'resume.pdf', saved: { quiz: true, targets: true, modules: true }, modulesOn: 3 })
  expect(summary.body).toContain(
    "Saved your resume, your Career DNA answers, what you're looking for and what Job Duck should do.",
  )
  expect(summary.body).not.toContain('Nothing is turned on')
})

test('saving modules with none on says so and points to Settings', () => {
  const summary = doneSummary({ uploaded: null, saved: { quiz: false, targets: false, modules: true }, modulesOn: 0 })
  expect(summary.title).toBe("You're Set Up.")
  expect(summary.body).toContain("Nothing is turned on, so Job Duck won't do anything yet.")
  expect(summary.body).toContain('Settings')
})

test('an uploaded resume tells the user to open any agent, which imports it automatically', () => {
  const { next } = doneSummary({ uploaded: 'resume.pdf', saved: NOTHING_SAVED, modulesOn: 0 })
  expect(next.title).toBe('Open Your Agent In This Folder')
  expect(next.body).toBe(
    'Any agent you use here (Claude Code, Codex, Gemini) will read inbox/resume.pdf and fill in your profile automatically.',
  )
})

test('without an upload the next step is the LinkedIn PDF, imported automatically too', () => {
  const { next } = doneSummary({ uploaded: null, saved: NOTHING_SAVED, modulesOn: 0 })
  expect(next.title).toBe('Add Your LinkedIn Or A Resume')
  expect(next.body).toContain('Save to PDF')
  expect(next.body).toContain('inbox/')
  expect(next.body).toContain('automatically')
})

test('no next step asks the user to type an import command', () => {
  for (const uploaded of ['resume.pdf', null]) {
    const { next } = doneSummary({ uploaded, saved: NOTHING_SAVED, modulesOn: 0 })
    expect(`${next.title} ${next.body}`).not.toMatch(/import my|say:/i)
  }
})
