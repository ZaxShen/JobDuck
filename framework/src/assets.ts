import migration001 from './db/migrations/001_init.sql' with { type: 'text' }
import migration002 from './db/migrations/002_interview_stages.sql' with { type: 'text' }
import migration003 from './db/migrations/003_profile_facts.sql' with { type: 'text' }
import migration004 from './db/migrations/004_pending_status.sql' with { type: 'text' }
import migration005 from './db/migrations/005_posting_fields.sql' with { type: 'text' }
import dashboardApp from './dashboard/public/app.js' with { type: 'text' }
import dashboardIndex from './dashboard/public/index.html' with { type: 'text' }
import dashboardStyle from './dashboard/public/style.css' with { type: 'text' }
import fontCyrillic from './dashboard/public/geist-cyrillic-wght-normal.woff2' with { type: 'file' }
import fontCyrillicExt from './dashboard/public/geist-cyrillic-ext-wght-normal.woff2' with { type: 'file' }
import fontLatin from './dashboard/public/geist-latin-wght-normal.woff2' with { type: 'file' }
import fontLatinExt from './dashboard/public/geist-latin-ext-wght-normal.woff2' with { type: 'file' }
import fontVietnamese from './dashboard/public/geist-vietnamese-wght-normal.woff2' with { type: 'file' }
import skillApply from '../skills/apply.md' with { type: 'text' }
import skillAugment from '../skills/augment.md' with { type: 'text' }
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
  augment: skillAugment,
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
  { name: '002_interview_stages.sql', sql: migration002 },
  { name: '003_profile_facts.sql', sql: migration003 },
  { name: '004_pending_status.sql', sql: migration004 },
  { name: '005_posting_fields.sql', sql: migration005 },
]

export const DASHBOARD: Record<string, string> = {
  'app.js': dashboardApp,
  'index.html': dashboardIndex as unknown as string,
  'style.css': dashboardStyle,
}

export const DASHBOARD_FONTS: Record<string, string> = {
  'geist-cyrillic-ext-wght-normal.woff2': fontCyrillicExt,
  'geist-cyrillic-wght-normal.woff2': fontCyrillic,
  'geist-latin-ext-wght-normal.woff2': fontLatinExt,
  'geist-latin-wght-normal.woff2': fontLatin,
  'geist-vietnamese-wght-normal.woff2': fontVietnamese,
}
