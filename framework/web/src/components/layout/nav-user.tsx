import { ChevronsUpDown, MonitorIcon, MoonIcon, PaletteIcon, SettingsIcon, SparklesIcon, SunIcon, UserIcon, type LucideIcon } from 'lucide-react'
import { useTheme, type Theme } from '@/components/theme-provider'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'
import type { View } from '@/hooks/use-hash-route'
import type { ProfileView } from '@/lib/types'

const THEMES: { value: Theme; label: string; icon: LucideIcon }[] = [
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
  { value: 'system', label: 'System', icon: MonitorIcon },
]

const LINKS: { view: View; label: string; icon: LucideIcon }[] = [
  { view: 'profile', label: 'Profile', icon: UserIcon },
  { view: 'settings', label: 'Settings', icon: SettingsIcon },
]

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

function identityOf(profile: ProfileView | null) {
  const front = profile?.front_matter ?? {}
  const name = text(front.name)
  const titles = Array.isArray(front.target_titles) ? front.target_titles.map(text).filter(Boolean) : []
  return { name, initials: initialsOf(name), title: name || 'Your profile', subtitle: titles[0] ?? 'Local profile' }
}

type Identity = ReturnType<typeof identityOf>

function IdentityRow({ identity }: { identity: Identity }) {
  return (
    <>
      <Avatar className="h-8 w-8 rounded-lg after:rounded-lg">
        <AvatarFallback className="rounded-lg">
          {identity.initials || <UserIcon aria-hidden="true" />}
        </AvatarFallback>
      </Avatar>
      <div className="grid flex-1 text-start text-sm leading-tight">
        <span className="truncate font-semibold">{identity.title}</span>
        <span className="truncate text-xs">{identity.subtitle}</span>
      </div>
    </>
  )
}

export function NavUser({ profile }: { profile: ProfileView | null }) {
  const { isMobile, setOpenMobile } = useSidebar()
  const { theme, setTheme } = useTheme()
  const identity = identityOf(profile)
  const close = () => setOpenMobile(false)

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                tooltip={identity.title}
                aria-label={`Account menu: ${identity.title}`}
                className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
              />
            }
          >
            <IdentityRow identity={identity} />
            <ChevronsUpDown aria-hidden="true" className="ms-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-56 rounded-lg" side={isMobile ? 'bottom' : 'right'} align="end" sideOffset={4}>
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-start text-sm text-foreground">
                  <IdentityRow identity={identity} />
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {LINKS.map((link) => (
                <DropdownMenuItem key={link.view} render={<a href={`#${link.view}`} />} onClick={close}>
                  <link.icon aria-hidden="true" />
                  {link.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <PaletteIcon aria-hidden="true" />
                  Theme
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-36">
                  <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
                    {THEMES.map((option) => (
                      <DropdownMenuRadioItem key={option.value} value={option.value}>
                        <option.icon aria-hidden="true" />
                        {option.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem render={<a href="#welcome" />} onClick={close}>
                <SparklesIcon aria-hidden="true" />
                Run setup again
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
