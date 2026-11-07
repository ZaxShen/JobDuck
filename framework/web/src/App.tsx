import { useCallback, useEffect, useRef, useState } from 'react'
import { GettingStartedDialog } from '@/components/getting-started-dialog'
import { AppShell } from '@/components/layout/app-shell'
import { Main } from '@/components/layout/main'
import { Skeleton } from '@/components/ui/skeleton'
import { useDocForm } from '@/hooks/use-doc-form'
import { useFlash } from '@/hooks/use-flash'
import { useHashRoute } from '@/hooks/use-hash-route'
import { errorMessage, fetchJSON } from '@/lib/api'
import { PROFILE_DOC, SETTINGS_DOC } from '@/lib/docs'
import { guideSeen, markGuideSeen, shouldAutoShowGuide } from '@/lib/getting-started'
import { hashFor, landingRoute, needsWelcome } from '@/lib/routing'
import type { PermissionsView, ProfileView as ProfileDoc, Statuses } from '@/lib/types'
import { ApplicationsView } from '@/views/applications/applications-view'
import { JobsView } from '@/views/jobs/jobs-view'
import { ProfileView } from '@/views/profile/profile-view'
import { SettingsView } from '@/views/settings/settings-view'
import { WelcomeView } from '@/views/welcome/welcome-view'

export function App() {
  const flash = useFlash()
  const { route, replace } = useHashRoute()
  const { view } = route
  const profile = useDocForm<ProfileDoc>(PROFILE_DOC)
  const settings = useDocForm<PermissionsView>(SETTINGS_DOC)
  const [statuses, setStatuses] = useState<Statuses | null>(null)
  const [routed, setRouted] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const guideAutoShown = useRef(false)
  const started = useRef(false)

  const { load: loadProfile } = profile
  const reloadProfile = useCallback(() => void loadProfile(), [loadProfile])

  const form = view === 'profile' ? profile : view === 'settings' ? settings : null
  const anyDirty = profile.dirty || settings.dirty

  useEffect(() => {
    if (started.current) return
    started.current = true
    fetchJSON<Statuses>('/api/statuses').then(setStatuses, (error) => flash(errorMessage(error), true))
    void profile.load().then((loaded) => {
      const next = landingRoute(window.location.hash, loaded)
      if (window.location.hash !== hashFor(next)) replace(next)
      setRouted(true)
    })
  }, [flash, profile, replace])

  useEffect(() => {
    if (!routed || !profile.view || guideAutoShown.current) return
    if (!shouldAutoShowGuide({ view, needsWelcome: needsWelcome(profile.view), seen: guideSeen(window.localStorage) })) return
    guideAutoShown.current = true
    setGuideOpen(true)
  }, [routed, view, profile.view])

  const onGuideOpenChange = useCallback((open: boolean) => {
    setGuideOpen(open)
    if (!open) markGuideSeen(window.localStorage)
  }, [])
  const openGuide = useCallback(() => setGuideOpen(true), [])

  useEffect(() => {
    const onUnload =(event: BeforeUnloadEvent) => {
      if (anyDirty) event.preventDefault()
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [anyDirty])

  useEffect(() => {
    const onFocus = () => {
      if (form && form.loaded && !form.dirty) void form.load()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [form])

  useEffect(() => {
    const block = (event: DragEvent) => {
      if (view === 'welcome') event.preventDefault()
    }
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
    }
  }, [view])

  if (!statuses || !routed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Skeleton className="h-8 w-48" />
      </div>
    )
  }

  return (
    <>
      <div hidden={view === 'welcome'}>
        <AppShell view={view} profile={profile.view} onOpenGuide={openGuide}>
          <Main>
            <div hidden={view !== 'applications'}>
              <ApplicationsView active={view === 'applications'} statuses={statuses.statuses} terminal={statuses.terminal} />
            </div>
            <div hidden={view !== 'jobs'}>
              <JobsView active={view === 'jobs'} statuses={statuses.statuses} />
            </div>
            <div hidden={view !== 'profile'}>
              <ProfileView form={profile} active={view === 'profile'} section={route.section} />
            </div>
            <div hidden={view !== 'settings'}>
              <SettingsView form={settings} active={view === 'settings'} />
            </div>
          </Main>
        </AppShell>
      </div>
      <div hidden={view !== 'welcome'}>
        <WelcomeView active={view === 'welcome'} onProfileSaved={reloadProfile} onSettingsSaved={settings.invalidate} />
      </div>
      <GettingStartedDialog open={guideOpen && view !== 'welcome'} onOpenChange={onGuideOpenChange} />
    </>
  )
}
