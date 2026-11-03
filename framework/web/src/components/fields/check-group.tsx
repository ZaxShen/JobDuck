import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { allChecked, setAllChecked, toggleChecked } from '@/lib/checks'
import type { Choice } from '@/lib/forms'

interface CheckGroupProps {
  id: string
  value: string[]
  options: readonly Choice[]
  anyLabel?: string
  onChange: (next: string[]) => void
}

export function CheckGroup({ id, value, options, anyLabel, onChange }: CheckGroupProps) {
  const known = options.map(([option]) => option)
  return (
    <div id={id} role="group" className="flex flex-wrap gap-x-4 gap-y-2 pt-1">
      {options.map(([option, text]) => (
        <Label key={option} className="font-normal">
          <Checkbox checked={value.includes(option)} onCheckedChange={(on) => onChange(toggleChecked(value, known, option, on))} />
          {text}
        </Label>
      ))}
      {anyLabel && (
        <Label className="font-normal">
          <Checkbox checked={allChecked(value, known)} onCheckedChange={(on) => onChange(setAllChecked(value, known, on))} />
          {anyLabel}
        </Label>
      )}
    </div>
  )
}
