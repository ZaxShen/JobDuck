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
    <div className="space-y-6 animate-in fade-in duration-500">
      <p className="text-sm text-muted-foreground">What Job Duck may do on your behalf.</p>
      {view && draft && (
        <div key={version} className="space-y-6">
          <FormGroups name="settings" groups={SETTINGS_GROUPS} draft={draft} onChange={setDraft} />
          <p className="text-xs text-muted-foreground">Stored in {view.path}</p>
        </div>
      )}
    </div>
  )
}
