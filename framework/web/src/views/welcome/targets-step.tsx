import { useState } from 'react'
import { NumberInput } from '@/components/fields/number-input'
import { TagInput } from '@/components/fields/tag-input'
import { Label } from '@/components/ui/label'
import { inferTrack, pruneToTrack, TRACKS, type Track } from '@/lib/seniority'
import { cn } from '@/lib/utils'
import { LocationPicker } from '@/views/welcome/location-picker'
import { SeniorityPicker } from '@/views/welcome/seniority-picker'
import { SegmentedToggle, StepActions, StepIntro, stepMotion } from '@/views/welcome/step-parts'

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

export function TargetsStep({ targets, onChange, onSkip, onContinue }: TargetsStepProps) {
  const [track, setTrack] = useState<Track>(() => inferTrack(targets.seniority))
  const count = targets.target_titles.length
  const label = count > 0 ? `Continue With ${count} Role${count > 1 ? 's' : ''}` : 'Continue'

  const switchTrack = (next: Track) => {
    setTrack(next)
    onChange({ ...targets, seniority: pruneToTrack(targets.seniority, next) })
  }

  return (
    <div className={cn('flex flex-col items-center gap-6', stepMotion)}>
      <StepIntro className="space-y-2" title="What Are You Looking For?">
        Job Duck only suggests postings that match these. Press Enter after each title.{' '}
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
        <div className="space-y-1.5">
          <Label htmlFor="wizard-target_titles">Target Titles</Label>
          <TagInput
            id="wizard-target_titles"
            value={targets.target_titles}
            placeholder="e.g. Software Engineer"
            onChange={(target_titles) => onChange({ ...targets, target_titles })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wizard-locations">Cities Or Regions</Label>
          <LocationPicker
            id="wizard-locations"
            value={targets.locations}
            onChange={(locations) => onChange({ ...targets, locations })}
          />
        </div>
        <div className="space-y-1.5">
          <p className="text-sm leading-none font-medium">Career Track</p>
          <SegmentedToggle label="Career Track" options={TRACKS} value={track} onChange={switchTrack} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wizard-seniority">Seniority</Label>
          <SeniorityPicker
            id="wizard-seniority"
            track={track}
            value={targets.seniority}
            onChange={(seniority) => onChange({ ...targets, seniority })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wizard-pay_floor">Minimum Annual Salary (Base)</Label>
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
