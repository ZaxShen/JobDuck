import { ModuleSwitches } from '@/components/module-switches'
import { withModule } from '@/lib/forms'
import { cn } from '@/lib/utils'
import { StepActions, StepIntro, stepMotion } from '@/views/welcome/step-parts'

interface ModulesStepProps {
  modules: Record<string, boolean>
  onChange: (modules: Record<string, boolean>) => void
  onSkip: () => void
  onContinue: () => Promise<void>
}

export function ModulesStep({ modules, onChange, onSkip, onContinue }: ModulesStepProps) {
  return (
    <div className={cn('flex flex-col gap-10', stepMotion)}>
      <StepIntro title="What should Job Duck do?">
        Nothing runs until its module is on. Change this any time in Settings.
      </StepIntro>
      <ModuleSwitches value={modules} onChange={(key, on) => onChange(withModule(modules, key, on))} />
      <StepActions onSkip={onSkip} onContinue={onContinue} />
    </div>
  )
}
