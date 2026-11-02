import { useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArchiveIcon, CheckIcon, GripVerticalIcon, Loader2Icon, PencilIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { SaveResult } from '@/lib/api'
import { splitList } from '@/lib/paths'
import type { FactStatus, ProfileFact } from '@/lib/types'
import { cn } from '@/lib/utils'

export interface FactRowProps {
  fact: ProfileFact
  onSave: (body: Record<string, unknown>) => Promise<SaveResult>
  onDelete: () => Promise<SaveResult>
}

interface FactDraft {
  action: string
  outcome: string
  metrics: string
  skills: string
  tools: string
  openedAt: string
}

const MOVES: { status: FactStatus; label: string; icon: typeof CheckIcon; primary?: boolean }[] = [
  { status: 'accepted', label: 'Accept', icon: CheckIcon, primary: true },
  { status: 'archived', label: 'Archive', icon: ArchiveIcon },
  { status: 'proposed', label: 'Restore to proposed', icon: RotateCcwIcon },
]

const EDITOR_LABEL = 'text-[10px] font-medium uppercase tracking-wide text-muted-foreground'
const TAG = 'h-4 px-1.5 text-[10px] font-normal'

const label = (tag: string) => tag.replace(/_/g, ' ')

const draftOf = (fact: ProfileFact): FactDraft => ({
  action: fact.action,
  outcome: fact.outcome ?? '',
  metrics: fact.metrics ?? '',
  skills: fact.skills.join(', '),
  tools: fact.tools.join(', '),
  openedAt: fact.updated_at,
})

const tagsOf = (text: string) =>
  [...new Set(splitList(text).map((tag) => tag.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')).filter(Boolean))]

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((item, index) => item === b[index])

function changes(fact: ProfileFact, draft: FactDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (draft.action.trim() !== fact.action) body.action = draft.action
  if ((draft.outcome.trim() || null) !== fact.outcome) body.outcome = draft.outcome
  if ((draft.metrics.trim() ? draft.metrics : null) !== fact.metrics) body.metrics = draft.metrics
  const skills = tagsOf(draft.skills)
  if (!sameList(skills, fact.skills)) body.skills = skills
  const tools = tagsOf(draft.tools)
  if (!sameList(tools, fact.tools)) body.tools = tools
  return body
}

function FactBody({ fact }: { fact: ProfileFact }) {
  const inferred = fact.basis === 'inferred'
  return (
    <div className="flex flex-col gap-1.5 text-sm sm:flex-row sm:items-start sm:justify-between sm:gap-3">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium leading-snug break-words text-foreground">{fact.action}</p>
        {fact.outcome && (
          <p className="border-l-2 border-muted pl-3 leading-snug break-words text-muted-foreground italic">
            <span aria-hidden="true" className="mr-1">→</span>
            {fact.outcome}
          </p>
        )}
        {fact.metrics && (
          <p className="text-xs break-words"><span className="text-muted-foreground">Metrics: </span>{fact.metrics}</p>
        )}
        {inferred && fact.rationale && (
          <p className="text-xs break-words text-muted-foreground italic">Why inferred: {fact.rationale}</p>
        )}
        {(fact.skills.length > 0 || fact.tools.length > 0) && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {fact.skills.map((skill) => <Badge key={`s-${skill}`} variant="secondary" className={TAG}>{label(skill)}</Badge>)}
            {fact.tools.map((tool) => <Badge key={`t-${tool}`} variant="outline" className={cn(TAG, 'text-muted-foreground')}>{label(tool)}</Badge>)}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1 sm:flex-col sm:items-end">
        <Badge variant="ghost" className={cn(TAG, 'text-muted-foreground')}>{label(fact.category)}</Badge>
        {inferred && (
          <span className="text-[10px] text-muted-foreground italic">
            inferred{fact.confidence && ` · ${fact.confidence} confidence`}
          </span>
        )}
        {fact.role && <span className="text-[10px] text-muted-foreground">{fact.role}</span>}
        {fact.slug && <code className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{fact.slug}</code>}
      </div>
    </div>
  )
}

interface EditorProps {
  id: string
  draft: FactDraft
  busy: boolean
  onChange: (draft: FactDraft) => void
  onCancel: () => void
  onSave: () => void
}

function FactEditor({ id, draft, busy, onChange, onCancel, onSave }: EditorProps) {
  const actionEmpty = draft.action.trim() === ''
  return (
    <div className="space-y-2 text-sm">
      <div className="space-y-1">
        <label htmlFor={`${id}-action`} className={EDITOR_LABEL}>Action</label>
        <Textarea
          id={`${id}-action`}
          rows={2}
          className="text-xs"
          value={draft.action}
          disabled={busy}
          aria-invalid={actionEmpty}
          aria-describedby={actionEmpty ? `${id}-action-error` : undefined}
          onChange={(event) => onChange({ ...draft, action: event.target.value })}
        />
        {actionEmpty && <p id={`${id}-action-error`} className="text-xs text-destructive">Action text is required.</p>}
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-outcome`} className={EDITOR_LABEL}>Outcome</label>
        <Textarea
          id={`${id}-outcome`}
          rows={2}
          className="text-xs"
          value={draft.outcome}
          disabled={busy}
          onChange={(event) => onChange({ ...draft, outcome: event.target.value })}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-metrics`} className={EDITOR_LABEL}>Metrics</label>
        <Input
          id={`${id}-metrics`}
          className="h-7 text-xs"
          autoComplete="off"
          value={draft.metrics}
          disabled={busy}
          onChange={(event) => onChange({ ...draft, metrics: event.target.value })}
        />
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor={`${id}-skills`} className={EDITOR_LABEL}>Skills (comma-separated)</label>
          <Input
            id={`${id}-skills`}
            className="h-7 text-xs"
            autoComplete="off"
            placeholder="python, sql…"
            value={draft.skills}
            disabled={busy}
            onChange={(event) => onChange({ ...draft, skills: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-tools`} className={EDITOR_LABEL}>Tools (comma-separated)</label>
          <Input
            id={`${id}-tools`}
            className="h-7 text-xs"
            autoComplete="off"
            placeholder="airflow, dbt…"
            value={draft.tools}
            disabled={busy}
            onChange={(event) => onChange({ ...draft, tools: event.target.value })}
          />
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button type="button" size="sm" disabled={busy || actionEmpty} onClick={onSave}>
          {busy ? <><Loader2Icon data-icon="inline-start" className="animate-spin" aria-hidden="true" />Saving…</> : 'Save'}
        </Button>
      </div>
    </div>
  )
}

export function FactRow({ fact, onSave, onDelete }: FactRowProps) {
  const [draft, setDraft] = useState<FactDraft | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const editing = draft !== null
  const id = `fact-${fact.id}`
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: fact.id,
    disabled: editing,
  })

  const run = async (body: Record<string, unknown>, expected: string): Promise<SaveResult> => {
    if (Object.keys(body).length === 0) return 'saved'
    setBusy(true)
    const result = await onSave({ ...body, expected_updated_at: expected })
    setBusy(false)
    return result
  }

  const save = async () => {
    if (draft && await run(changes(fact, draft), draft.openedAt) !== 'failed') setDraft(null)
  }

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'flex items-start gap-2 rounded-md border bg-card px-2 py-2',
        fact.basis === 'inferred' ? 'border-dashed border-border/60' : 'border-border',
        editing && 'bg-muted/40',
        isDragging && 'relative z-10 opacity-50',
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        disabled={editing}
        aria-label={`Move fact: ${fact.action}`}
        className={cn(
          'mt-0.5 shrink-0 cursor-grab touch-none rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          isDragging && 'cursor-grabbing',
          editing && 'pointer-events-none opacity-50',
        )}
      >
        <GripVerticalIcon className="size-4" aria-hidden="true" />
      </button>

      <div className="min-w-0 flex-1 space-y-2">
        {draft ? (
          <FactEditor
            id={id}
            draft={draft}
            busy={busy}
            onChange={setDraft}
            onCancel={() => setDraft(null)}
            onSave={() => void save()}
          />
        ) : (
          <>
            <FactBody fact={fact} />
            <div className="flex flex-wrap gap-1.5">
              {MOVES.filter((move) => move.status !== fact.status).map((move) => (
                <Button
                  key={move.status}
                  type="button"
                  size="xs"
                  variant={move.primary ? 'default' : 'outline'}
                  disabled={busy}
                  onClick={() => void run({ status: move.status }, fact.updated_at)}
                >
                  <move.icon data-icon="inline-start" aria-hidden="true" />
                  {move.label}
                </Button>
              ))}
            </div>
          </>
        )}
      </div>

      {!editing && (
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Edit fact" onClick={() => setDraft(draftOf(fact))}>
            <PencilIcon aria-hidden="true" />
          </Button>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Delete fact" disabled={busy} onClick={() => setConfirming(true)}>
            <Trash2Icon aria-hidden="true" />
          </Button>
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
              onClick={() => { void onDelete().then((result) => { if (result !== 'failed') setConfirming(false) }) }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}
