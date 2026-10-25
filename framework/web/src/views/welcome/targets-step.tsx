import { NumberInput } from '@/components/fields/number-input'
import { TagInput } from '@/components/fields/tag-input'
import { Label } from '@/components/ui/label'
import { SENIORITY } from '@/lib/forms'
import { cn } from '@/lib/utils'
import { StepActions, StepIntro, stepMotion } from '@/views/welcome/step-parts'

export interface Targets {
  target_titles: string[]
  locations: string[]
  seniority: string[]
  pay_floor: number
}

interface TargetsStepProps {
  targets: Targets
  onChange: (targets: Targets) => void
  onSkip: () => void
  onContinue: () => Promise<void>
}

const TAGS = [
  ['target_titles', 'Target titles', 'e.g. Software Engineer', undefined],
  ['locations', 'Cities or regions', 'e.g. Remote, New York', undefined],
  ['seniority', 'Seniority', undefined, SENIORITY],
] as const

export function TargetsStep({ targets, onChange, onSkip, onContinue }: TargetsStepProps) {
  const count = targets.target_titles.length
  const label = count > 0 ? `Continue with ${count} role${count > 1 ? 's' : ''}` : 'Continue'
  return (
    <div className={cn('flex flex-col items-center gap-6', stepMotion)}>
      <StepIntro className="space-y-2" title="What are you looking for?">
        Job Duck only suggests postings that match these. Press Enter after each one.{' '}
        {count > 0 && (
          <>
            <span className="font-medium text-foreground">{count}</span> selected
            {' · '}
            <button
              type="button"
              onClick={() => onChange({ ...targets, target_titles: [] })}
              className="text-muted-foreground underline hover:text-foreground"
            >
              clear
            </button>
          </>
        )}
      </StepIntro>

      <div className="w-full space-y-5">
        {TAGS.map(([key, label, placeholder, suggest]) => (
          <div key={key} className="space-y-1.5">
            <Label htmlFor={`wizard-${key}`}>{label}</Label>
            <TagInput
              id={`wizard-${key}`}
              value={targets[key]}
              placeholder={placeholder}
              suggest={suggest}
              onChange={(next) => onChange({ ...targets, [key]: next })}
            />
          </div>
        ))}
        <div className="space-y-1.5">
          <Label htmlFor="wizard-pay_floor">Minimum yearly pay</Label>
          <NumberInput
            id="wizard-pay_floor"
            value={targets.pay_floor}
            step={1000}
            placeholder="0"
            onChange={(pay_floor) => onChange({ ...targets, pay_floor })}
          />
          <p className="text-xs text-muted-foreground">Postings that pay less are skipped. Leave 0 for no minimum.</p>
        </div>
      </div>

      <p className="text-xs text-muted-foreground" aria-live="polite">
        {count > 0 ? `${count} role${count > 1 ? 's' : ''} selected · remove a title to deselect it` : 'Add a target title to choose roles'}
      </p>

      <StepActions label={label} onSkip={onSkip} onContinue={onContinue} />
    </div>
  )
}
