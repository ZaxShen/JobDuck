import migration001 from './db/migrations/001_init.sql' with { type: 'text' }
import dashboardApp from './dashboard/public/app.js' with { type: 'text' }
import dashboardIndex from './dashboard/public/index.html' with { type: 'text' }
import dashboardStyle from './dashboard/public/style.css' with { type: 'text' }
import skillApply from '../skills/apply.md' with { type: 'text' }
import skillCv from '../skills/cv.md' with { type: 'text' }
import skillFind from '../skills/find.md' with { type: 'text' }
import skillInterview from '../skills/interview.md' with { type: 'text' }
import skillSetup from '../skills/setup.md' with { type: 'text' }
import skillTrack from '../skills/track.md' with { type: 'text' }
import templateAgents from '../templates/AGENTS.md' with { type: 'text' }
import templatePermissions from '../templates/permissions.toml' with { type: 'text' }
import templateProfile from '../templates/profile.md' with { type: 'text' }

export const SKILLS: Record<string, string> = {
  apply: skillApply,
  cv: skillCv,
  find: skillFind,
  interview: skillInterview,
  setup: skillSetup,
  track: skillTrack,
}

export const TEMPLATES: Record<string, string> = {
  'AGENTS.md': templateAgents,
  'permissions.toml': templatePermissions,
  'profile.md': templateProfile,
}

export const MIGRATIONS: { name: string; sql: string }[] = [
  { name: '001_init.sql', sql: migration001 },
]

export const DASHBOARD: Record<string, string> = {
  'app.js': dashboardApp,
  'index.html': dashboardIndex as unknown as string,
  'style.css': dashboardStyle,
}
