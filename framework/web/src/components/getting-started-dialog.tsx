import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AGENT_PART, DASHBOARD_PART, GUIDE_SKILLS, GUIDE_TITLE } from '@/lib/getting-started'

interface GettingStartedDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function GettingStartedDialog({ open, onOpenChange }: GettingStartedDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{GUIDE_TITLE}</DialogTitle>
          <DialogDescription>The dashboard shows your data; your agent does the work.</DialogDescription>
        </DialogHeader>
        <section aria-labelledby="guide-dashboard" className="grid gap-1">
          <h2 id="guide-dashboard" className="font-medium">{DASHBOARD_PART.title}</h2>
          <p className="text-muted-foreground">{DASHBOARD_PART.body}</p>
        </section>
        <section aria-labelledby="guide-agent" className="grid gap-2">
          <h2 id="guide-agent" className="font-medium">{AGENT_PART.title}</h2>
          <p className="text-muted-foreground">{AGENT_PART.body}</p>
          <dl className="grid gap-2">
            {GUIDE_SKILLS.map((entry) => (
              <div key={entry.skill} className="grid gap-0.5 rounded-lg border border-border p-3 sm:grid-cols-[10rem_1fr] sm:gap-3">
                <dt className="font-medium">{entry.title}</dt>
                <dd className="grid gap-1">
                  <span className="text-muted-foreground">{entry.purpose}</span>
                  <span className="flex flex-wrap gap-1.5">
                    {entry.prompts.map((prompt) => (
                      <q key={prompt} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">{prompt}</q>
                    ))}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}
