import { useState } from 'react'
import { MailIcon, PencilIcon, PhoneIcon, Trash2Icon } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { safeUrl } from '@/lib/format'
import { OUTCOME_TONES, dateInputValue, kindLabel, outcomeLabel, scheduledLabel, scheduledPatch, stageTypeLabel } from '@/lib/stages'
import type { Contact, Stage, StageTypes } from '@/lib/types'
import { cn } from '@/lib/utils'
import { contactsValid, toContacts, toRows } from '@/views/applications/contacts-editor'
import { type StageDraft, StageFields } from '@/views/applications/stage-fields'

interface StageCardProps {
  stage: Stage
  types: StageTypes
  onSave: (body: Record<string, unknown>) => Promise<boolean>
  onDelete: () => Promise<boolean>
}

const draftOf = (stage: Stage): StageDraft => ({
  stageType: stage.stage_type,
  date: dateInputValue(stage.scheduled_at),
  outcome: stage.outcome,
  note: stage.note ?? '',
  contacts: toRows(stage.contacts),
})

function ContactLine({ contact }: { contact: Contact }) {
  return (
    <li className="space-y-0.5">
      <p>
        {contact.linkedin && safeUrl(contact.linkedin)
          ? <a href={contact.linkedin} target="_blank" rel="noreferrer noopener" className="text-primary underline-offset-4 hover:underline">{contact.name}</a>
          : contact.name}
        {contact.title && <span className="text-muted-foreground"> · {contact.title}</span>}
      </p>
      {(contact.email || contact.phone) && (
        <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          {contact.email && <span className="inline-flex items-center gap-1"><MailIcon className="size-3" />{contact.email}</span>}
          {contact.phone && <span className="inline-flex items-center gap-1"><PhoneIcon className="size-3" />{contact.phone}</span>}
        </p>
      )}
    </li>
  )
}

export function StageCard({ stage, types, onSave, onDelete }: StageCardProps) {
  const [draft, setDraft] = useState<StageDraft | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const interview = stage.to_status === 'interviewing'

  const save = async () => {
    if (!draft) return
    setBusy(true)
    const body: Record<string, unknown> = { stage_type: draft.stageType, note: draft.note, contacts: toContacts(draft.contacts) }
    const scheduled = scheduledPatch(stage.scheduled_at, draft.date)
    if (scheduled !== undefined) body.scheduled_at = scheduled
    if (interview && draft.outcome !== stage.outcome) body.outcome = draft.outcome
    if (await onSave(body)) setDraft(null)
    setBusy(false)
  }

  return (
    <li className="space-y-2 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{kindLabel(stage.to_status)}</Badge>
            <span className="font-medium">{stageTypeLabel(stage.stage_type)}</span>
            {stage.outcome && (
              <Badge variant="outline" className={cn(OUTCOME_TONES[stage.outcome])}>{outcomeLabel(stage.outcome)}</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{scheduledLabel(stage.scheduled_at)}</p>
        </div>
        {!draft && (
          <div className="flex shrink-0">
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Edit stage" onClick={() => setDraft(draftOf(stage))}>
              <PencilIcon />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Delete stage" onClick={() => setConfirming(true)}>
              <Trash2Icon />
            </Button>
          </div>
        )}
      </div>
      {draft ? (
        <div className="space-y-3">
          <StageFields
            id={`stage-${stage.id}`}
            draft={draft}
            stageTypes={interview ? types.interviewing : types.offered}
            outcomes={interview ? types.outcomes : null}
            onChange={setDraft}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setDraft(null)}>Cancel</Button>
            <Button type="button" size="sm" disabled={busy || !contactsValid(draft.contacts)} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <>
          {stage.note && <p className="whitespace-pre-wrap text-muted-foreground">{stage.note}</p>}
          {stage.contacts.length > 0 && (
            <ul className="space-y-1.5 border-t pt-2">
              {stage.contacts.map((contact, index) => <ContactLine key={index} contact={contact} />)}
            </ul>
          )}
        </>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this {kindLabel(stage.to_status).toLowerCase()} stage?</AlertDialogTitle>
            <AlertDialogDescription>
              {stageTypeLabel(stage.stage_type)}, its note and contacts are removed. The application status does not change.
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
