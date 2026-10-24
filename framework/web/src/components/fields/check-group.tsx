import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import type { Choice } from '@/lib/forms'

interface CheckGroupProps {
  id: string
  value: string[]
  options: readonly Choice[]
  onChange: (next: string[]) => void
}

export function CheckGroup({ id, value, options, onChange }: CheckGroupProps) {
  const known = options.map(([option]) => option)
  const toggle = (option: string, on: boolean) => {
    const chosen = new Set(value)
    if (on) chosen.add(option)
    else chosen.delete(option)
    onChange([...known.filter((v) => chosen.has(v)), ...[...chosen].filter((v) => !known.includes(v))])
  }
  return (
    <div id={id} role="group" className="flex flex-wrap gap-x-4 gap-y-2 pt-1">
      {options.map(([option, text]) => (
        <Label key={option} className="font-normal">
          <Checkbox checked={value.includes(option)} onCheckedChange={(on) => toggle(option, on)} />
          {text}
        </Label>
      ))}
    </div>
  )
}
