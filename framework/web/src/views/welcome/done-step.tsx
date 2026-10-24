import { ArrowRightIcon, MessageSquareIcon } from 'lucide-react'
import { SectionCard } from '@/components/composed/section-card'
import { Button } from '@/components/ui/button'
import { go } from '@/hooks/use-hash-route'
import type { InboxUpload } from '@/lib/types'
import { cn } from '@/lib/utils'
import { StepIntro, stepMotion } from '@/views/welcome/step-parts'

export function DoneStep({ uploaded }: { uploaded: InboxUpload | null }) {
  return (
    <div className={cn('flex flex-col items-center gap-8', stepMotion)}>
      <StepIntro title="You're set up.">Your profile and settings are saved. Review or change them any time.</StepIntro>
      {uploaded && (
        <SectionCard
          className="w-full"
          title={<span className="flex items-center gap-2"><MessageSquareIcon className="size-4" />Back in your agent, say: import my resume</span>}
          description={`It reads inbox/${uploaded.name} and fills in your profile for you to review.`}
        >
          <span className="sr-only">Uploaded {uploaded.name}</span>
        </SectionCard>
      )}
      <div className="flex w-full items-center gap-3">
        <Button type="button" variant="outline" size="lg" className="flex-1" onClick={() => go('profile')}>Open Profile</Button>
        <Button type="button" size="lg" className="flex-1" onClick={() => go('applications')}>
          Open Applications <ArrowRightIcon data-icon="inline-end" />
        </Button>
      </div>
    </div>
  )
}
