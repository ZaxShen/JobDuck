import type { ReactNode } from 'react'
import { BriefcaseIcon, type LucideIcon } from 'lucide-react'
import { NavUser } from '@/components/layout/nav-user'
import { Separator } from '@/components/ui/separator'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { View } from '@/hooks/use-hash-route'
import type { ProfileView } from '@/lib/types'

const NAV_GROUP: { title: string; items: { view: View; label: string; icon: LucideIcon }[] } = {
  title: 'Main',
  items: [{ view: 'applications', label: 'Applications', icon: BriefcaseIcon }],
}

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
          <img src="/logo.svg" alt="" aria-hidden="true" width={32} height={32} className="aspect-square size-8 shrink-0" />
          <div className="grid flex-1 text-start text-sm leading-tight">
            <span translate="no" className="truncate font-semibold">Job Duck</span>
            <span className="truncate text-xs">Career Intelligence</span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function NavGroup({ view }: { view: View }) {
  const { setOpenMobile } = useSidebar()
  return (
    <SidebarGroup>
      <SidebarGroupLabel id="nav-group-main" className="text-[11px] font-medium tracking-widest text-sidebar-foreground/40 uppercase">
        {NAV_GROUP.title}
      </SidebarGroupLabel>
      <nav aria-labelledby="nav-group-main">
        <SidebarMenu>
          {NAV_GROUP.items.map((item) => {
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

function Header({ title }: { title: string }) {
  return (
    <header className="z-50 h-16 shrink-0 border-b border-border bg-background">
      <div className="relative flex h-full items-center gap-3 p-4 sm:gap-4">
        <SidebarTrigger variant="outline" className="max-md:scale-125" />
        <Separator orientation="vertical" className="h-6" />
        <h1 className="truncate text-sm font-medium text-muted-foreground">{title}</h1>
      </div>
    </header>
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
            <NavGroup view={view} />
          </SidebarContent>
          <SidebarFooter>
            <div className="mx-3 border-t border-sidebar-border" />
            <NavUser profile={profile} />
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset className="@container/content h-svh min-w-0 overflow-auto">
          <Header title={TITLES[view]} />
          {children}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
