import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CheckGroup } from '@/components/fields/check-group'
import { NumberInput } from '@/components/fields/number-input'
import { RowList } from '@/components/fields/row-list'
import { TagInput } from '@/components/fields/tag-input'
import type { Field } from '@/lib/forms'
import { cn } from '@/lib/utils'

interface FieldControlProps {
  formName: string
  field: Field
  value: unknown
  onChange: (next: unknown) => void
}

const asStrings = (value: unknown) => (Array.isArray(value) ? value.map(String) : [])

function Control({ id, field, value, onChange }: FieldControlProps & { id: string }) {
  switch (field.type) {
    case 'select': {
      const options = field.options ?? []
      return (
        <Select
          items={options.map(([v, label]) => ({ value: v, label }))}
          value={typeof value === 'string' ? value : null}
          onValueChange={(next) => onChange(next)}
        >
          <SelectTrigger id={id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map(([v, label]) => <SelectItem key={v} value={v}>{label}</SelectItem>)}
          </SelectContent>
        </Select>
      )
    }
    case 'number':
      return <NumberInput id={id} value={value} onChange={onChange} min={field.min} step={field.step} placeholder={field.placeholder} />
    case 'tags':
      return <TagInput id={id} value={asStrings(value)} onChange={onChange} placeholder={field.placeholder} suggest={field.suggest} />
    case 'checks':
      return <CheckGroup id={id} value={asStrings(value)} options={field.options ?? []} onChange={onChange} />
    case 'record': {
      const initial = Object.entries((value ?? {}) as Record<string, string>).map(([key, v]) => ({ key, value: v }))
      return (
        <RowList
          id={id}
          initial={initial}
          columns={field.columns ?? []}
          addLabel={field.addLabel ?? 'Add'}
          onChange={(rows) => onChange(Object.fromEntries(rows.filter((row) => row.key?.trim()).map((row) => [row.key!.trim(), row.value ?? ''])))}
        />
      )
    }
    case 'list': {
      const columns = field.columns ?? []
      const initial = (Array.isArray(value) ? value : []).map((row) => ({ ...(row as Record<string, string>) }))
      return (
        <RowList
          id={id}
          initial={initial}
          columns={columns}
          addLabel={field.addLabel ?? 'Add'}
          onChange={(rows) => onChange(rows.filter((row) => columns.some((column) => row[column.name]?.trim())))}
        />
      )
    }
    default:
      return (
        <Input
          id={id}
          type={field.type ?? 'text'}
          placeholder={field.placeholder}
          autoComplete={field.autocomplete ?? 'off'}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        />
      )
  }
}

export function FieldControl(props: FieldControlProps) {
  const { formName, field, value, onChange } = props
  const id = `${formName}-${field.key.replace(/[^A-Za-z0-9]+/g, '-')}`
  const help = field.help && <p className="text-xs text-muted-foreground">{field.help}</p>
  if (field.type === 'switch') {
    return (
      <Label className="items-start justify-between gap-4 sm:col-span-2">
        <span className="space-y-1">
          <span className="block">{field.label}</span>
          {field.help && <span className="block text-xs font-normal text-muted-foreground">{field.help}</span>}
        </span>
        <Switch id={id} checked={Boolean(value)} onCheckedChange={(on) => onChange(on)} />
      </Label>
    )
  }
  if (field.type === 'checkbox') {
    return (
      <div className="space-y-1 sm:col-span-2">
        <Label className="font-normal">
          <Checkbox id={id} checked={Boolean(value)} onCheckedChange={(on) => onChange(on)} />
          {field.label}
        </Label>
        {help && <div className="pl-6">{help}</div>}
      </div>
    )
  }
  return (
    <div className={cn('space-y-1.5', field.wide && 'sm:col-span-2')}>
      <Label htmlFor={id}>{field.label}</Label>
      <Control {...props} id={id} />
      {help}
    </div>
  )
}
