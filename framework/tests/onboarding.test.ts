import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { type Sandbox, migratedDb, sandbox } from './helpers'
import { SKILLS, TEMPLATES } from '../src/assets'
import { updateProfile } from '../src/config/profile'
import { handleApi } from '../src/dashboard/api'
import { createServer } from '../src/mcp/server'
import { importsPath, markImported, readLedger, scanImports, sha256Of } from '../src/onboarding/ledger'
import { DASHBOARD_HINT, onboardingStatus, profileEmpty, serverInstructions, workspaceOf } from '../src/onboarding/status'
import { ensureHome, profilePath } from '../src/paths'

let box: Sandbox
let inbox: string

beforeEach(() => {
  box = sandbox()
  ensureHome(box.home)
  inbox = join(box.workspace, 'inbox')
  mkdirSync(inbox)
})

afterEach(() => box.cleanup())

const put = (path: string, text: string) => writeFileSync(join(box.workspace, path), text)
const paths = (files: { path: string }[]) => files.map((file) => file.path)

describe('ledger scan', () => {
  test('finds supported inbox files and top-level PDF/DOCX, nothing else', () => {
    put('inbox/resume.pdf', 'resume')
    put('inbox/linkedin.zip', 'zip')
    put('inbox/Profile.csv', 'csv')
    put('inbox/notes.md', 'md')
    put('inbox/photo.png', 'png')
    put('inbox/.hidden.pdf', 'hidden')
    mkdirSync(join(inbox, 'export.pdf'))
    put('cv.docx', 'docx')
    put('Old CV.PDF', 'upper')
    put('notes.md', 'top-level markdown is not a candidate')
    put('README.txt', 'nor text')
    mkdirSync(join(box.workspace, 'cv'))
    put('cv/generated.pdf', 'generated')
    expect(paths(scanImports(box.home, box.workspace).pending)).toEqual([
      'inbox/Profile.csv', 'inbox/linkedin.zip', 'inbox/notes.md', 'inbox/resume.pdf', 'Old CV.PDF', 'cv.docx',
    ])
  })

  test('a workspace without inbox/ still scans its top level', () => {
    const bare = join(box.root, 'bare')
    mkdirSync(bare)
    writeFileSync(join(bare, 'resume.pdf'), 'resume')
    expect(paths(scanImports(box.home, bare).pending)).toEqual(['resume.pdf'])
  })

  test('candidates carry the SHA-256 of their content', () => {
    put('inbox/resume.pdf', 'resume v1')
    const [candidate] = scanImports(box.home, box.workspace).pending
    expect(candidate).toEqual({ path: 'inbox/resume.pdf', name: 'resume.pdf', sha256: sha256Of(Buffer.from('resume v1')) })
  })

  test('a renamed or copied imported file is not pending', () => {
    put('inbox/resume.pdf', 'resume v1')
    markImported(box.home, box.workspace, ['inbox/resume.pdf'])
    renameSync(join(inbox, 'resume.pdf'), join(inbox, 'renamed.pdf'))
    copyFileSync(join(inbox, 'renamed.pdf'), join(box.workspace, 'copy.pdf'))
    const scan = scanImports(box.home, box.workspace)
    expect(scan.pending).toEqual([])
    expect(paths(scan.imported)).toEqual(['inbox/renamed.pdf', 'copy.pdf'])
  })

  test('an edited file with the same name is pending again', () => {
    put('inbox/resume.pdf', 'resume v1')
    markImported(box.home, box.workspace, ['inbox/resume.pdf'])
    put('inbox/resume.pdf', 'resume v2')
    const scan = scanImports(box.home, box.workspace)
    expect(paths(scan.pending)).toEqual(['inbox/resume.pdf'])
    expect(scan.imported).toEqual([])
  })

  test('a file named like an imported one but with other content is pending', () => {
    put('inbox/resume.pdf', 'resume v1')
    markImported(box.home, box.workspace, ['inbox/resume.pdf'])
    put('resume.pdf', 'someone else entirely')
    expect(paths(scanImports(box.home, box.workspace).pending)).toEqual(['resume.pdf'])
  })

  test('two pending copies of one file are listed once', () => {
    put('inbox/resume.pdf', 'same')
    put('resume.pdf', 'same')
    expect(paths(scanImports(box.home, box.workspace).pending)).toEqual(['inbox/resume.pdf'])
  })

  test('the ledger lives in the Job Duck home, never in inbox/, and stores the name only for display', () => {
    put('inbox/resume.pdf', 'resume v1')
    const now = new Date('2026-01-02T03:04:05.000Z')
    markImported(box.home, box.workspace, ['inbox/resume.pdf'], now)
    expect(importsPath(box.home)).toBe(join(box.home, 'imports.json'))
    expect(existsSync(join(inbox, 'imports.json'))).toBe(false)
    expect(statSync(importsPath(box.home)).mode & 0o777).toBe(0o600)
    expect(readLedger(box.home)).toEqual([
      { sha256: sha256Of(Buffer.from('resume v1')), name: 'resume.pdf', imported_at: '2026-01-02T03:04:05.000Z' },
    ])
  })

  test('marking is idempotent and refuses files outside the workspace', () => {
    put('inbox/resume.pdf', 'resume v1')
    const first = markImported(box.home, box.workspace, ['inbox/resume.pdf'])
    expect(paths(first.marked)).toEqual(['inbox/resume.pdf'])
    const before = readFileSync(importsPath(box.home), 'utf8')
    const second = markImported(box.home, box.workspace, ['inbox/resume.pdf', join(inbox, 'resume.pdf')])
    expect(second.marked).toEqual([])
    expect(paths(second.already)).toEqual(['inbox/resume.pdf', 'inbox/resume.pdf'])
    expect(readFileSync(importsPath(box.home), 'utf8')).toBe(before)
    writeFileSync(join(box.root, 'outside.pdf'), 'outside')
    expect(() => markImported(box.home, box.workspace, ['../outside.pdf'])).toThrow('is not a file in the workspace')
    expect(() => markImported(box.home, box.workspace, ['inbox/missing.pdf'])).toThrow('does not exist')
  })

  test('a corrupt ledger is reported, not silently reset', () => {
    writeFileSync(importsPath(box.home), '{not json')
    expect(() => scanImports(box.home, box.workspace)).toThrow('imports.json is not valid JSON')
  })
})

describe('onboarding status and server instructions', () => {
  test('a fresh template profile is empty; a name, an email or a filled section is not', () => {
    expect(profileEmpty(box.home)).toBe(true)
    updateProfile({ sections: { Summary: 'Builds data platforms.' } }, profilePath(box.home))
    expect(profileEmpty(box.home)).toBe(false)
    updateProfile({ sections: { Summary: '' } }, profilePath(box.home))
    expect(profileEmpty(box.home)).toBe(true)
    updateProfile({ frontMatter: { email: 'you@example.com' } }, profilePath(box.home))
    expect(profileEmpty(box.home)).toBe(false)
  })

  test('target settings alone leave the profile empty, as the dashboard judges it', () => {
    updateProfile({ frontMatter: { target_titles: ['Data Engineer'] } }, profilePath(box.home))
    expect(profileEmpty(box.home)).toBe(true)
  })

  test('the status reports profile_empty, pending_imports and the dashboard hint', () => {
    put('inbox/resume.pdf', 'resume')
    expect(onboardingStatus(box.home, box.workspace)).toEqual({
      profile_empty: true,
      pending_imports: [{ path: 'inbox/resume.pdf', name: 'resume.pdf', sha256: sha256Of(Buffer.from('resume')) }],
      dashboard_hint: 'jobduck dashboard --background --view welcome',
      workspace: box.workspace,
    })
  })

  test('pending imports direct the auto-import, whatever the profile holds', () => {
    put('inbox/resume.pdf', 'resume')
    for (const filled of [false, true]) {
      if (filled) updateProfile({ frontMatter: { name: '<your name>' } }, profilePath(box.home))
      const text = serverInstructions(onboardingStatus(box.home, box.workspace))!
      expect(text).toContain('inbox/resume.pdf')
      expect(text).toContain('without asking')
      expect(text).toContain('Step 2')
      expect(text).toContain('mark_imported')
      expect(text).not.toContain(DASHBOARD_HINT)
    }
  })

  test('an empty profile with nothing pending points to onboarding', () => {
    const text = serverInstructions(onboardingStatus(box.home, box.workspace))!
    expect(text).toContain(DASHBOARD_HINT)
    expect(text).toContain('inbox/')
    expect(text).not.toContain('mark_imported')
  })

  test('a filled profile with nothing pending adds no instructions', () => {
    updateProfile({ frontMatter: { name: '<your name>' } }, profilePath(box.home))
    put('inbox/resume.pdf', 'resume')
    markImported(box.home, box.workspace, ['inbox/resume.pdf'])
    expect(serverInstructions(onboardingStatus(box.home, box.workspace))).toBeUndefined()
  })

  test('the workspace of a .jobduck home is its parent folder', () => {
    expect(workspaceOf(join(box.workspace, '.jobduck'), box.root, box.userHome)).toBe(box.workspace)
    expect(workspaceOf(join(box.userHome, '.jobduck'), box.workspace, box.userHome)).toBe(box.workspace)
    expect(workspaceOf(box.home, box.workspace, box.userHome)).toBe(box.workspace)
  })
})

describe('MCP surface', () => {
  const connect = async () => {
    const jobduck = createServer({ home: box.home, workspace: box.workspace })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'jobduck-test', version: '0.0.0' })
    await Promise.all([jobduck.server.connect(serverTransport), client.connect(clientTransport)])
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] }
      return { isError: result.isError === true, body: result.isError ? result.content[0]!.text : JSON.parse(result.content[0]!.text) }
    }
    return {
      call,
      instructions: client.getInstructions(),
      close: async () => {
        await client.close()
        await jobduck.close()
      },
    }
  }

  test('cold start instructions follow the status: import, then onboarding, then nothing', async () => {
    put('inbox/resume.pdf', 'resume')
    let mcp = await connect()
    expect(mcp.instructions).toContain('inbox/resume.pdf')
    expect(mcp.instructions).toContain('mark_imported')
    expect((await mcp.call('mark_imported', { files: ['inbox/resume.pdf'] })).body.marked).toHaveLength(1)
    await mcp.close()

    mcp = await connect()
    expect(mcp.instructions).toContain(DASHBOARD_HINT)
    await mcp.close()

    updateProfile({ frontMatter: { name: '<your name>' } }, profilePath(box.home))
    mcp = await connect()
    expect(mcp.instructions).toBeUndefined()
    await mcp.close()
  })

  test('get_onboarding_status and mark_imported work and marking twice is a no-op', async () => {
    put('inbox/resume.pdf', 'resume')
    const mcp = await connect()
    const status = await mcp.call('get_onboarding_status')
    expect(status.body.profile_empty).toBe(true)
    expect(status.body.dashboard_hint).toBe(DASHBOARD_HINT)
    expect(paths(status.body.pending_imports)).toEqual(['inbox/resume.pdf'])

    const first = await mcp.call('mark_imported', { files: ['inbox/resume.pdf'] })
    expect(paths(first.body.marked)).toEqual(['inbox/resume.pdf'])
    const second = await mcp.call('mark_imported', { files: ['inbox/resume.pdf'] })
    expect(second.body).toEqual({ marked: [], already: first.body.marked })
    expect(readLedger(box.home)).toHaveLength(1)
    expect((await mcp.call('get_onboarding_status')).body.pending_imports).toEqual([])

    const outside = await mcp.call('mark_imported', { files: ['../outside.pdf'] })
    expect(outside.isError).toBe(true)
    await mcp.close()
  })

  test('a corrupt ledger leaves the server running without instructions and the tool reports it', async () => {
    writeFileSync(importsPath(box.home), '{not json')
    const mcp = await connect()
    expect(mcp.instructions).toBeUndefined()
    const status = await mcp.call('get_onboarding_status')
    expect(status.isError).toBe(true)
    expect(status.body).toContain('imports.json')
    await mcp.close()
  })
})

describe('dashboard endpoint', () => {
  test('GET /api/onboarding returns the same status as the MCP tool', () => {
    put('inbox/resume.pdf', 'resume')
    const db = migratedDb(box.home)
    try {
      const response = handleApi(
        { db, home: box.home, workspace: box.workspace },
        { method: 'GET', path: '/api/onboarding', query: new URLSearchParams(), body: undefined },
      )
      expect(response.status).toBe(200)
      expect(response.body).toEqual(onboardingStatus(box.home, box.workspace))
      markImported(box.home, box.workspace, ['inbox/resume.pdf'])
      const after = handleApi(
        { db, home: box.home, workspace: box.workspace },
        { method: 'GET', path: '/api/onboarding', query: new URLSearchParams(), body: undefined },
      )
      expect((after.body as { pending_imports: unknown[] }).pending_imports).toEqual([])
    } finally {
      db.close()
    }
  })
})

describe('agent guidance', () => {
  test('the AGENTS.md block tells agents to check onboarding at session start, in step with the instructions', () => {
    const agents = TEMPLATES['AGENTS.md']!
    const rule = agents.split('\n').find((line) => line.includes('get_onboarding_status'))!
    expect(rule).toContain('At session start')
    for (const word of ['pending_imports', 'without asking', 'Step 2', 'mark_imported', 'profile_empty', 'dashboard_hint', 'inbox/']) {
      expect(rule).toContain(word)
    }
  })

  test('setup.md imports pending files, marks them imported and no longer waits for the user', () => {
    const setup = SKILLS.setup!
    expect(setup).toContain('get_onboarding_status')
    expect(setup).toContain('Call `mark_imported`')
    expect(setup).toContain('"Import my resume" / "import my LinkedIn": run Step 2 only.')
    expect(setup).not.toContain('Wait until they say they are done')
  })
})
