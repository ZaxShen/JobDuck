import { MailCheckIcon } from 'lucide-react'
import { CopyPromptButton } from '@/components/composed/copy-prompt-button'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { GHOSTED_HINT, allFollowUpsPrompt, dueText, followUpKindLabel, followUpPrompt, waitLabel } from '@/lib/follow-ups'
import { stageTypeLabel } from '@/lib/stages'
import type { FollowUpItem, FollowUps } from '@/lib/types'

interface FollowUpsCardProps {
  data: FollowUps | null
  onOpen: (applicationId: number) => void
}

function FollowUpRow({ item, onOpen }: { item: FollowUpItem; onOpen: (applicationId: number) => void }) {
  const kind = followUpKindLabel(item.kind)
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Button
            type="button"
            variant="link"
            className="h-auto min-w-0 p-0 font-medium"
            aria-label={`Open ${item.company} — ${item.title}`}
            onClick={() => onOpen(item.application_id)}
          >
            <span className="truncate">{item.company}</span>
          </Button>
          <span className="min-w-0 truncate text-sm text-muted-foreground">{item.title}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={item.kind === 'thank_you' ? 'secondary' : 'default'}>{kind}</Badge>
          <Badge variant="outline">{stageTypeLabel(item.stage_type)}</Badge>
          <time dateTime={item.due_at} className="tabular-nums">{dueText(item)}</time>
        </div>
        {item.suggest_ghosted && <p className="text-xs text-muted-foreground">{GHOSTED_HINT}</p>}
      </div>
      <div className="shrink-0">
        <CopyPromptButton prompt={followUpPrompt(item)} context={`for the ${kind} to ${item.company}`} />
      </div>
    </li>
  )
}

export function FollowUpsCard({ data, onOpen }: FollowUpsCardProps) {
  if (data === null || data.items.length === 0) return null
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MailCheckIcon className="size-4 text-primary" aria-hidden="true" />
          <h2>Follow-Ups Due</h2>
        </CardTitle>
        <CardDescription>Thank-You Notes Within A Day, Follow-Ups {waitLabel(data.wait_business_days)}</CardDescription>
        <CardAction>
          <CopyPromptButton prompt={allFollowUpsPrompt()} label="Copy Prompt For All" />
        </CardAction>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y divide-border">
          {data.items.map((item) => (
            <FollowUpRow key={`${item.kind}-${item.round_id}`} item={item} onOpen={onOpen} />
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
