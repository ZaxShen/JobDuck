import { useEffect, useRef, useState } from 'react'
import { AppShell } from '@/components/layout/app-shell'
import { SaveBar } from '@/components/save-bar'
import { useDocForm } from '@/hooks/use-doc-form'
import { useFlash } from '@/hooks/use-flash'
import { useHashRoute } from '@/hooks/use-hash-route'
import { errorMessage, fetchJSON } from '@/lib/api'
import { needsWelcome, PROFILE_DOC, SETTINGS_DOC } from '@/lib/docs'
import type { PermissionsView, ProfileView as ProfileDoc, Statuses } from '@/lib/types'
import { ApplicationsView } from '@/views/applications/applications-view'
import { FactsView } from '@/views/facts/facts-view'
import { ProfileView } from '@/views/profile/profile-view'
import { SettingsView } from '@/views/settings/settings-view'
import { WelcomeView } from '@/views/welcome/welcome-view'

export function App() {
  const flash = useFlash()
  const { view, replace } = useHashRoute()
  const profile = useDocForm<ProfileDoc>(PROFILE_DOC)
  const settings = useDocForm<PermissionsView>(SETTINGS_DOC)
  const [statuses, setStatuses] = useState<Statuses | null>(null)
  const [routed, setRouted] = useState(() => Boolean(window.location.hash))
  const started = useRef(false)

  const form = view === 'profile' ? profile : view === 'settings' ? settings : null
  const anyDirty = profile.dirty || settings.dirty

  useEffect(() => {
    if (started.current) return
    started.current = true
    fetchJSON<Statuses>('/api/statuses').then(setStatuses, (error) => flash(errorMessage(error), true))
    if (window.location.hash) return
    void profile.load().then((loaded) => {
      if (loaded && needsWelcome(loaded)) replace('welcome')
      setRouted(true)
    })
  }, [flash, profile, replace])

  useEffect(() => {
    const onUnload = (event: BeforeUnloadEvent) => {
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

  if (!statuses || !routed) return <AppShell view={view}>{null}</AppShell>

  return (
    <AppShell view={view}>
      <div hidden={view !== 'applications'}>
        <ApplicationsView active={view === 'applications'} statuses={statuses.statuses} terminal={statuses.terminal} />
      </div>
      <div hidden={view !== 'profile'}>
        <ProfileView form={profile} active={view === 'profile'} />
      </div>
      <div hidden={view !== 'facts'}>
        <FactsView active={view === 'facts'} />
      </div>
      <div hidden={view !== 'settings'}>
        <SettingsView form={settings} active={view === 'settings'} />
      </div>
      <div hidden={view !== 'welcome'}>
        <WelcomeView active={view === 'welcome'} onProfileSaved={profile.invalidate} onSettingsSaved={settings.invalidate} />
      </div>
      {form?.dirty && (
        <div className="sticky bottom-0 z-30 px-4 pb-4">
          <SaveBar onSave={() => void form.save()} onDiscard={() => void form.load()} />
        </div>
      )}
    </AppShell>
  )
}
