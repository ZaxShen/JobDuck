import { useEffect } from 'react'
import { FormGroups } from '@/components/form-groups'
import type { DocForm } from '@/hooks/use-doc-form'
import { SETTINGS_GROUPS } from '@/lib/forms'
import type { PermissionsView } from '@/lib/types'

export function SettingsView({ form, active }: { form: DocForm<PermissionsView>; active: boolean }) {
  const { loaded, load, view, draft, version, setDraft } = form

  useEffect(() => {
    if (active && !loaded) void load()
  }, [active, loaded, load])

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6 animate-in fade-in duration-500">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">What Job Duck may do on your behalf.</p>
      </div>
      {view && draft && (
        <div key={version} className="space-y-6">
          <FormGroups name="settings" groups={SETTINGS_GROUPS} draft={draft} onChange={setDraft} />
          <p className="text-xs text-muted-foreground">Stored in {view.path}</p>
        </div>
      )}
    </div>
  )
}
