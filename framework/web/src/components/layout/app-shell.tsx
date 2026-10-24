import type { ReactNode } from 'react'
import { BirdIcon, BriefcaseIcon, ListChecksIcon, SettingsIcon, SparklesIcon, UserIcon, type LucideIcon } from 'lucide-react'
import type { View } from '@/hooks/use-hash-route'
import { cn } from '@/lib/utils'

const NAV: { view: View; label: string; icon: LucideIcon }[] = [
  { view: 'applications', label: 'Applications', icon: BriefcaseIcon },
  { view: 'profile', label: 'Profile', icon: UserIcon },
  { view: 'facts', label: 'Experience facts', icon: ListChecksIcon },
  { view: 'settings', label: 'Settings', icon: SettingsIcon },
  { view: 'welcome', label: 'Setup', icon: SparklesIcon },
]

function Brand() {
  return (
    <div className="flex items-center gap-2 px-2 text-sm font-semibold tracking-tight text-foreground">
      <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <BirdIcon className="size-4" />
      </span>
      Job Duck
    </div>
  )
}

function NavLinks({ view, compact }: { view: View; compact?: boolean }) {
  return (
    <nav aria-label="Sections" className={cn('flex gap-1', compact ? 'flex-row' : 'flex-col')}>
      {NAV.map((item) => {
        const active = item.view === view
        return (
          <a
            key={item.view}
            href={`#${item.view}`}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
              compact && 'flex-1 justify-center px-1.5 text-xs',
              active
                ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
            )}
          >
            <item.icon className="size-4 shrink-0" />
            <span className={cn(compact && 'max-[379px]:sr-only')}>{item.label}</span>
          </a>
        )
      })}
    </nav>
  )
}

export function AppShell({ view, children }: { view: View; children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col bg-background md:flex-row">
      <aside className="hidden w-56 shrink-0 flex-col gap-6 border-r border-sidebar-border bg-sidebar p-3 md:flex">
        <div className="pt-1"><Brand /></div>
        <NavLinks view={view} />
      </aside>
      <header className="sticky top-0 z-40 space-y-2 border-b border-sidebar-border bg-sidebar/95 p-2 backdrop-blur md:hidden">
        <Brand />
        <NavLinks view={view} compact />
      </header>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  )
}
