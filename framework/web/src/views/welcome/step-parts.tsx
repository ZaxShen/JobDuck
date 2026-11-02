import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function StepIntro({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('text-center', className)}>
      <h1 className="text-3xl leading-tight font-semibold tracking-tight">{title}</h1>
      <p className="text-base text-muted-foreground">{children}</p>
    </div>
  )
}

export function StepActions({ onSkip, onContinue, label = 'Continue' }: {
  onSkip?: () => void
  onContinue: () => Promise<void> | void
  label?: string
}) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex w-full items-center gap-3">
      {onSkip && (
        <Button type="button" variant="ghost" size="lg" className="flex-1 text-muted-foreground" onClick={onSkip}>
          Skip For Now
        </Button>
      )}
      <Button
        type="button"
        size="lg"
        className="flex-1"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            await onContinue()
          } finally {
            setBusy(false)
          }
        }}
      >
        {label}
      </Button>
    </div>
  )
}

export function SegmentedToggle<T extends string>({ label, options, value, onChange }: {
  label: string
  options: readonly (readonly [T, string])[]
  value: string
  onChange: (value: T) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1.5 rounded-lg bg-muted p-1">
      {options.map(([option, text]) => {
        const on = value === option
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(option)}
            className={cn(
              'flex-1 rounded-md px-3 py-2 text-xs font-medium transition-all duration-200',
              on ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {text}
          </button>
        )
      })}
    </div>
  )
}

export const stepMotion ='animate-in fade-in slide-in-from-bottom-4 duration-700'
