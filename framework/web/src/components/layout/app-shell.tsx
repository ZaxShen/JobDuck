import type { ReactNode } from 'react'
import { BriefcaseIcon, ListChecksIcon, SettingsIcon, SparklesIcon, UserIcon, type LucideIcon } from 'lucide-react'
import { ThemeSwitch } from '@/components/theme-switch'
import { Separator } from '@/components/ui/separator'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
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

const NAV: { view: View; label: string; icon: LucideIcon }[] = [
  { view: 'applications', label: 'Applications', icon: BriefcaseIcon },
  { view: 'profile', label: 'Profile', icon: UserIcon },
  { view: 'facts', label: 'Experience facts', icon: ListChecksIcon },
  { view: 'settings', label: 'Settings', icon: SettingsIcon },
  { view: 'welcome', label: 'Setup', icon: SparklesIcon },
]

function Brand() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" render={<div />} className="pointer-events-none">
          <img src="/logo.svg" alt="" width={32} height={32} className="aspect-square size-8 shrink-0" />
          <span translate="no" className="truncate text-sm font-semibold tracking-tight">Job Duck</span>
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

export function AppShell({ view, children }: { view: View; children: ReactNode }) {
  const title = NAV.find((item) => item.view === view)?.label
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
          <SidebarRail />
        </Sidebar>
        <SidebarInset className="min-w-0">
          <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur">
            <SidebarTrigger />
            <Separator orientation="vertical" className="data-vertical:h-5 data-vertical:self-center" />
            <p className="min-w-0 flex-1 truncate text-sm font-medium">{title}</p>
            <ThemeSwitch />
          </header>
          {children}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
