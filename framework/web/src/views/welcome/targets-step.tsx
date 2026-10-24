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
  return (
    <div className={cn('flex flex-col gap-10', stepMotion)}>
      <StepIntro title="What are you looking for?">
        Job Duck only suggests postings that match these. Press Enter after each one.
      </StepIntro>

      <div className="space-y-5">
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

      <StepActions onSkip={onSkip} onContinue={onContinue} />
    </div>
  )
}
