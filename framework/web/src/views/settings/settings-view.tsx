import { useEffect } from 'react'
import { GanCard, GanCardContent, GanCardDescription, GanCardHeader, GanCardTitle } from '@/components/composed/gan-card'
import { FieldControl } from '@/components/fields/field-control'
import { LoadError, LoadSkeleton } from '@/components/load-states'
import { SaveBar } from '@/components/save-bar'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import type { DocForm } from '@/hooks/use-doc-form'
import { type Draft, type Field, type Group, SETTINGS_GROUPS, fieldId, visibleFields, withField } from '@/lib/forms'
import { getPath } from '@/lib/paths'
import type { PermissionsView } from '@/lib/types'

interface FieldProps {
  field: Field
  draft: Draft
  onChange: (draft: Draft) => void
}

function SwitchRow({ field, draft, onChange }: FieldProps) {
  const id = fieldId('settings', field)
  return (
    <Label className="flex items-center justify-between rounded-lg border p-4 gap-4 sm:col-span-2 cursor-pointer">
      <span className="space-y-0.5">
        <span className="block text-base">{field.label}</span>
        {field.help && <span className="block text-sm font-normal text-muted-foreground">{field.help}</span>}
      </span>
      <Switch
        id={id}
        checked={Boolean(getPath(draft, field.key))}
        onCheckedChange={(on) => onChange(withField(draft, field, on))}
      />
    </Label>
  )
}

function SettingsCard({ group, draft, onChange }: { group: Group; draft: Draft; onChange: (draft: Draft) => void }) {
  return (
    <GanCard variant="static">
      <GanCardHeader>
        <GanCardTitle><h2>{group.title}</h2></GanCardTitle>
        {group.help && <GanCardDescription>{group.help}</GanCardDescription>}
      </GanCardHeader>
      <GanCardContent>
        <div className="grid gap-4 sm:grid-cols-2">
          {visibleFields(group, draft).map((field) => field.type === 'switch'
            ? <SwitchRow key={field.key} field={field} draft={draft} onChange={onChange} />
            : (
              <FieldControl
                key={field.key}
                formName="settings"
                field={field}
                value={getPath(draft, field.key)}
                onChange={(value) => onChange(withField(draft, field, value))}
              />
            ))}
        </div>
      </GanCardContent>
    </GanCard>
  )
}

export function SettingsView({ form, active }: { form: DocForm<PermissionsView>; active: boolean }) {
  const { loaded, load, view, draft, version, setDraft, loadError } = form

  useEffect(() => {
    if (active && !loaded) void load()
  }, [active, loaded, load])

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="space-y-6">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Manage what Job Duck may do on your behalf.
        </p>
        <Separator />
      </div>

      {loadError && <LoadError message={loadError} onRetry={() => void load()} />}

      {!view || !draft ? (!loadError && <LoadSkeleton />) : (
        <div key={version} className="space-y-6">
          {SETTINGS_GROUPS.filter((group) => !group.when || group.when(draft)).map((group) => (
            <SettingsCard key={group.title} group={group} draft={draft} onChange={setDraft} />
          ))}
          <SaveBar {...form} onSave={() => void form.save()} onDiscard={() => void load()} />
          <p className="text-xs text-muted-foreground">Stored in {view.path}</p>
        </div>
      )}
    </div>
  )
}
