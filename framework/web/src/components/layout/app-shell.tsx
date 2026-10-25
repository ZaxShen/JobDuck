import type { ReactNode } from 'react'
import { BriefcaseIcon, type LucideIcon } from 'lucide-react'
import { NavUser } from '@/components/layout/nav-user'
import { Separator } from '@/components/ui/separator'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { View } from '@/hooks/use-hash-route'
import type { ProfileView } from '@/lib/types'

const NAV: { view: View; label: string; icon: LucideIcon }[] = [
  { view: 'applications', label: 'Applications', icon: BriefcaseIcon },
]

const TITLES: Record<View, string> = {
  applications: 'Applications',
  profile: 'Profile',
  settings: 'Settings',
  welcome: 'Setup',
}

function Brand() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" render={<div />} className="pointer-events-none">
          <img src="/logo.svg" alt="" width={32} height={32} className="aspect-square size-8 shrink-0" />
          <div className="grid flex-1 text-start text-sm leading-tight">
            <span translate="no" className="truncate font-semibold">Job Duck</span>
            <span className="truncate text-xs text-muted-foreground">Career Intelligence</span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function NavLinks({ view }: { view: View }) {
  const { setOpenMobile } = useSidebar()
  return (
    <SidebarGroup>
      <nav aria-label="Sections">
        <SidebarMenu>
          {NAV.map((item) => {
            const active = item.view === view
            return (
              <SidebarMenuItem key={item.view}>
                <SidebarMenuButton
                  render={<a href={`#${item.view}`} aria-current={active ? 'page' : undefined} onClick={() => setOpenMobile(false)} />}
                  isActive={active}
                  tooltip={item.label}
                >
                  <item.icon aria-hidden="true" />
                  <span>{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </nav>
    </SidebarGroup>
  )
}

export function AppShell({ view, profile, children }: { view: View; profile: ProfileView | null; children: ReactNode }) {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <Brand />
          </SidebarHeader>
          <SidebarContent>
            <NavLinks view={view} />
          </SidebarContent>
          <SidebarFooter>
            <SidebarSeparator />
            <NavUser profile={profile} />
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset className="@container/content min-w-0">
          <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur">
            <SidebarTrigger />
            <Separator orientation="vertical" className="data-vertical:h-5 data-vertical:self-center" />
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{TITLES[view]}</h1>
          </header>
          {children}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
