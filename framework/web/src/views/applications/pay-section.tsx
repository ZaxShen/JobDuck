import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export const PAY_FIELDS = [
  ['salary_min', 'Salary min'],
  ['salary_max', 'Salary max'],
  ['salary_offered', 'Salary offered'],
  ['bonus', 'Bonus'],
  ['rsu', 'RSU'],
  ['options', 'Options'],
  ['sign_on', 'Sign-on'],
  ['relocation_fee', 'Relocation'],
] as const

export type PayKey = (typeof PAY_FIELDS)[number][0]

interface PaySectionProps {
  values: Record<PayKey | 'currency', string>
  onChange: (key: PayKey | 'currency', value: string) => void
  onCommit: (key: PayKey | 'currency') => void
}

export function PaySection({ values, onChange, onCommit }: PaySectionProps) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-sm font-medium">Offer &amp; pay</legend>
      <div className="grid grid-cols-2 gap-3">
        {PAY_FIELDS.map(([key, label]) => (
          <div key={key} className="space-y-1.5">
            <Label htmlFor={`f-${key}`} className="text-muted-foreground">{label}</Label>
            <Input
              id={`f-${key}`}
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={values[key]}
              onChange={(event) => onChange(key, event.target.value)}
              onBlur={() => onCommit(key)}
            />
          </div>
        ))}
        <div className="space-y-1.5">
          <Label htmlFor="f-currency" className="text-muted-foreground">Currency</Label>
          <Input
            id="f-currency"
            maxLength={3}
            placeholder="USD"
            value={values.currency}
            onChange={(event) => onChange('currency', event.target.value.toUpperCase())}
            onBlur={() => onCommit('currency')}
          />
        </div>
      </div>
    </fieldset>
  )
}
