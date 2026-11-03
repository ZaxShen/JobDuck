import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { isPlaceholder, readStoredProfile, splitSections } from '../config/profile'
import { HOME_DIR, profilePath } from '../paths'
import { type ImportCandidate, scanImports } from './ledger'

export const DASHBOARD_HINT = 'jobduck dashboard --background --view welcome'

export interface OnboardingStatus {
  profile_empty: boolean
  pending_imports: ImportCandidate[]
  dashboard_hint: string
  workspace: string
}

export function workspaceOf(home: string, start = process.cwd(), userHome = homedir()): string {
  const holder = dirname(resolve(home))
  return basename(resolve(home)) === HOME_DIR && holder !== resolve(userHome) ? holder : resolve(start)
}

export function profileEmpty(home: string): boolean {
  const { frontMatter, body } = readStoredProfile(profilePath(home))
  return !frontMatter.name && !frontMatter.email
    && splitSections(body).sections.every((section) => isPlaceholder(section) || section.content.trim() === '')
}

export function onboardingStatus(home: string, workspace: string): OnboardingStatus {
  return {
    profile_empty: profileEmpty(home),
    pending_imports: scanImports(home, workspace).pending,
    dashboard_hint: DASHBOARD_HINT,
    workspace,
  }
}

export function serverInstructions(status: OnboardingStatus): string | undefined {
  if (status.pending_imports.length > 0) {
    const files = status.pending_imports.map((file) => file.path).join(', ')
    return [
      `Job Duck: the user added files to import that no agent has imported yet: ${files}.`,
      'Before anything else, and without asking, import them now: read the setup skill (skills/setup.md in the Job Duck home)',
      'and follow its Step 2 for these files, then call mark_imported with their paths so no agent imports them again.',
      'Then tell the user what changed in their profile and ask them to review it: jobduck dashboard --view profile.',
    ].join(' ')
  }
  if (status.profile_empty) {
    return [
      'Job Duck: the user\'s profile is empty and nothing is waiting to be imported.',
      `Point them to onboarding in the dashboard (${status.dashboard_hint}),`,
      'or to drop a resume or LinkedIn PDF in inbox/, which any agent opened in this folder then imports automatically.',
    ].join(' ')
  }
  return undefined
}
