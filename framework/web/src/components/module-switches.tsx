import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { MODULES } from '@/lib/forms'

interface ModuleSwitchesProps {
  value: Record<string, boolean>
  onChange: (key: string, on: boolean) => void
}

export function ModuleSwitches({ value, onChange }: ModuleSwitchesProps) {
  return (
    <div className="divide-y rounded-xl bg-card ring-1 ring-foreground/10">
      {MODULES.map(([key, label, help]) => (
        <Label key={key} className="items-start justify-between gap-4 px-4 py-3">
          <span className="space-y-1">
            <span className="block">{label}</span>
            <span className="block text-xs font-normal text-muted-foreground">{help}</span>
          </span>
          <Switch id={`wizard-modules-${key}`} checked={Boolean(value[key])} onCheckedChange={(on) => onChange(key, on)} />
        </Label>
      ))}
    </div>
  )
}
