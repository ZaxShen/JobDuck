import { SectionCard } from '@/components/composed/section-card'
import { FieldControl } from '@/components/fields/field-control'
import type { Draft, Field, Group } from '@/lib/forms'
import { getPath, setPath } from '@/lib/paths'

interface FormGroupsProps {
  name: string
  groups: Group[]
  draft: Draft
  onChange: (draft: Draft) => void
}

export function FormGroups({ name, groups, draft, onChange }: FormGroupsProps) {
  const change = (field: Field, value: unknown) => {
    const next = setPath(draft, field.key, value)
    onChange(field.after ? field.after(next, value) : next)
  }
  return (
    <>
      {groups.filter((group) => !group.when || group.when(draft)).map((group) => (
        <SectionCard key={group.title} title={group.title} description={group.help}>
          <div className="grid gap-4 sm:grid-cols-2">
            {group.fields.filter((field) => !field.when || field.when(draft)).map((field) => (
              <FieldControl
                key={field.key}
                formName={name}
                field={field}
                value={getPath(draft, field.key)}
                onChange={(value) => change(field, value)}
              />
            ))}
          </div>
        </SectionCard>
      ))}
    </>
  )
}
