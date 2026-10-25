import { ArrowRightIcon, MessageSquareIcon, ShieldCheckIcon } from 'lucide-react'
import { SectionCard } from '@/components/composed/section-card'
import { Button } from '@/components/ui/button'
import { go } from '@/hooks/use-hash-route'
import type { InboxUpload } from '@/lib/types'
import { cn } from '@/lib/utils'
import type { DoneSummary } from '@/lib/wizard-done'
import { StepIntro, stepMotion } from '@/views/welcome/step-parts'

export function DoneStep({ uploaded, summary }: { uploaded: InboxUpload | null; summary: DoneSummary }) {
  return (
    <div className={cn('flex flex-col items-center gap-8', stepMotion)}>
      <StepIntro className="space-y-3" title={summary.title}>{summary.body}</StepIntro>
      <SectionCard
        className="w-full"
        title={<span className="flex items-center gap-2"><MessageSquareIcon className="size-4" aria-hidden="true" />Back in your agent, say: {summary.nextStep}</span>}
        description={uploaded
          ? `It reads inbox/${uploaded.name} and fills in your profile for you to review.`
          : 'It reads your own LinkedIn profile, read-only, and fills in your profile for you to review.'}
      >
        {uploaded && <span className="sr-only">Uploaded {uploaded.name}</span>}
      </SectionCard>
      <div className="w-full space-y-4">
        <Button type="button" size="lg" className="w-full" onClick={() => go('applications')}>
          Open Applications <ArrowRightIcon data-icon="inline-end" />
        </Button>
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <ShieldCheckIcon className="size-3.5" aria-hidden="true" />
          <span>Saved in your Job Duck workspace. No account, no telemetry.</span>
        </div>
      </div>
    </div>
  )
}
