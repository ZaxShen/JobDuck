import { useState } from 'react'
import { ArchiveIcon, CheckIcon, PencilIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { FactStatus, ProfileFact } from '@/lib/types'
import { cn } from '@/lib/utils'

interface FactCardProps {
  fact: ProfileFact
  onSave: (body: Record<string, unknown>) => Promise<boolean>
  onDelete: () => Promise<boolean>
}

interface FactDraft {
  action: string
  outcome: string
  metrics: string
}

const CONFIDENCE_TONES: Record<string, string> = {
  high: 'border-green-600/40 text-green-700 dark:text-green-400',
  medium: 'border-amber-500/40 text-amber-700 dark:text-amber-400',
  low: 'border-destructive/40 text-destructive',
}

const MOVES: { status: FactStatus; label: string; icon: typeof CheckIcon; primary?: boolean }[] = [
  { status: 'accepted', label: 'Accept', icon: CheckIcon, primary: true },
  { status: 'archived', label: 'Archive', icon: ArchiveIcon },
  { status: 'proposed', label: 'Restore to proposed', icon: RotateCcwIcon },
]

const label = (tag: string) => tag.replace(/_/g, ' ')

const draftOf = (fact: ProfileFact): FactDraft => ({
  action: fact.action, outcome: fact.outcome ?? '', metrics: fact.metrics ?? '',
})

function changes(fact: ProfileFact, draft: FactDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (draft.action.trim() !== fact.action) body.action = draft.action
  if ((draft.outcome.trim() || null) !== fact.outcome) body.outcome = draft.outcome
  if ((draft.metrics.trim() ? draft.metrics : null) !== fact.metrics) body.metrics = draft.metrics
  return body
}

function Tags({ tags, variant }: { tags: string[]; variant: 'secondary' | 'outline' }) {
  return tags.map((tag) => <Badge key={tag} variant={variant} className="capitalize">{label(tag)}</Badge>)
}

export function FactCard({ fact, onSave, onDelete }: FactCardProps) {
  const [draft, setDraft] = useState<FactDraft | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const id = `fact-${fact.id}`

  const run = async (body: Record<string, unknown>) => {
    setBusy(true)
    const ok = Object.keys(body).length === 0 || await onSave(body)
    setBusy(false)
    return ok
  }

  const save = async () => {
    if (draft && await run(changes(fact, draft))) setDraft(null)
  }

  return (
    <li className="space-y-2 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary" className="capitalize">{label(fact.category)}</Badge>
          <Badge variant="outline" className={cn(fact.basis === 'inferred' && fact.confidence && CONFIDENCE_TONES[fact.confidence])}>
            {fact.basis === 'stated' ? 'Stated' : `Inferred${fact.confidence ? ` · ${fact.confidence} confidence` : ''}`}
          </Badge>
          {fact.role && <span className="text-xs text-muted-foreground">{fact.role}</span>}
          {fact.slug && <code className="rounded bg-muted px-1 text-xs text-muted-foreground">{fact.slug}</code>}
        </div>
        {!draft && (
          <div className="flex shrink-0">
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Edit fact" onClick={() => setDraft(draftOf(fact))}>
              <PencilIcon />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Delete fact" onClick={() => setConfirming(true)}>
              <Trash2Icon />
            </Button>
          </div>
        )}
      </div>

      {draft ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-action`} className="text-muted-foreground">Action</Label>
            <Textarea id={`${id}-action`} rows={2} value={draft.action} onChange={(event) => setDraft({ ...draft, action: event.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-outcome`} className="text-muted-foreground">Outcome</Label>
            <Textarea id={`${id}-outcome`} rows={2} value={draft.outcome} onChange={(event) => setDraft({ ...draft, outcome: event.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-metrics`} className="text-muted-foreground">Metrics</Label>
            <Input id={`${id}-metrics`} value={draft.metrics} onChange={(event) => setDraft({ ...draft, metrics: event.target.value })} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setDraft(null)}>Cancel</Button>
            <Button type="button" size="sm" disabled={busy || draft.action.trim() === ''} onClick={() => void save()}>Save</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          <p className="font-medium">{fact.action}</p>
          {fact.outcome && <p className="text-muted-foreground">{fact.outcome}</p>}
          {fact.metrics && <p className="text-xs"><span className="text-muted-foreground">Metrics: </span>{fact.metrics}</p>}
          {fact.basis === 'inferred' && fact.rationale && (
            <p className="text-xs text-muted-foreground italic">Why inferred: {fact.rationale}</p>
          )}
        </div>
      )}

      {(fact.skills.length > 0 || fact.tools.length > 0) && (
        <div className="flex flex-wrap gap-1">
          <Tags tags={fact.skills} variant="secondary" />
          <Tags tags={fact.tools} variant="outline" />
        </div>
      )}

      {!draft && (
        <div className="flex flex-wrap justify-end gap-2 border-t pt-2">
          {MOVES.filter((move) => move.status !== fact.status).map((move) => (
            <Button
              key={move.status}
              type="button"
              size="sm"
              variant={move.primary ? 'default' : 'outline'}
              disabled={busy}
              onClick={() => void run({ status: move.status })}
            >
              <move.icon />
              {move.label}
            </Button>
          ))}
        </div>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this fact?</AlertDialogTitle>
            <AlertDialogDescription>
              It is removed for good and your agent may propose it again. Archive it instead to keep it out of your CV.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => { void onDelete().then((ok) => { if (ok) setConfirming(false) }) }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}
