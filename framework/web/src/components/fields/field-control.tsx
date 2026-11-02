import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CheckGroup } from '@/components/fields/check-group'
import { ChipInput } from '@/components/fields/chip-input'
import { NumberInput } from '@/components/fields/number-input'
import { RowList } from '@/components/fields/row-list'
import { fieldId, type Field } from '@/lib/forms'
import { cn } from '@/lib/utils'

interface FieldControlProps {
  formName: string
  field: Field
  value: unknown
  onChange: (next: unknown) => void
  size?: 'default' | 'compact'
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
      return <ChipInput id={id} label={field.label} value={asStrings(value)} onChange={onChange} placeholder={field.placeholder} suggest={field.suggest} />
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

const STYLES = {
  default: { item: 'space-y-2', label: '', help: 'text-sm text-muted-foreground' },
  compact: { item: 'space-y-1', label: 'text-xs font-medium text-muted-foreground', help: 'text-xs text-muted-foreground' },
} as const

export function FieldControl(props: FieldControlProps) {
  const { formName, field, value, onChange, size = 'default' } = props
  const id = fieldId(formName, field)
  const styles = STYLES[size]
  const help = field.help && <p className={styles.help}>{field.help}</p>
  if (field.type === 'checkbox') {
    return (
      <div className="space-y-1 sm:col-span-2">
        <Label className="flex cursor-pointer items-center gap-2 font-normal">
          <Checkbox id={id} checked={Boolean(value)} onCheckedChange={(on) => onChange(on)} />
          {field.label}
        </Label>
        {help && <div className="pl-6">{help}</div>}
      </div>
    )
  }
  return (
    <div className={cn(styles.item, 'min-w-0', field.wide && 'sm:col-span-2')}>
      <Label htmlFor={id} className={styles.label}>{field.label}</Label>
      <Control {...props} id={id} />
      {help}
    </div>
  )
}
