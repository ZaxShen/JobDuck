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
          Skip for now
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

export const stepMotion = 'animate-in fade-in slide-in-from-bottom-4 duration-700'
