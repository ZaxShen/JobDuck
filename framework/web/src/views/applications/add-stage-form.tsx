import { useState } from 'react'
import { PlusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { SaveResult } from '@/lib/api'
import { kindLabel } from '@/lib/stages'
import type { StageKind, StageTypes } from '@/lib/types'
import { contactsValid, toContacts } from '@/views/applications/contacts-editor'
import { type StageDraft, StageFields } from '@/views/applications/stage-fields'

const KINDS: StageKind[] = ['interviewing', 'offered']

const emptyDraft = (types: StageTypes, kind: StageKind): StageDraft => ({
  stageType: types[kind][0] ?? '',
  date: '',
  outcome: kind === 'interviewing' ? 'pending' : null,
  note: '',
  contacts: [],
})

interface AddStageFormProps {
  types: StageTypes
  onAdd: (body: Record<string, unknown>) => Promise<SaveResult>
}

export function AddStageForm({ types, onAdd }: AddStageFormProps) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<StageKind>('interviewing')
  const [draft, setDraft] = useState<StageDraft>(() => emptyDraft(types, 'interviewing'))
  const [busy, setBusy] = useState(false)

  const reset = (next: StageKind) => {
    setKind(next)
    setDraft({ ...emptyDraft(types, next), note: draft.note, date: draft.date, contacts: draft.contacts })
  }

  const submit = async () => {
    setBusy(true)
    const body: Record<string, unknown> = {
      kind,
      stage_type: draft.stageType,
      scheduled_at: draft.date || null,
      note: draft.note,
    }
    if (draft.contacts.length > 0) body.contacts = toContacts(draft.contacts)
    if (kind === 'interviewing') body.outcome = draft.outcome
    if (await onAdd(body) === 'saved') {
      setOpen(false)
      setKind('interviewing')
      setDraft(emptyDraft(types, 'interviewing'))
    }
    setBusy(false)
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => setOpen(true)}>
        <PlusIcon />
        Add stage
      </Button>
    )
  }

  return (
    <div className="space-y-3 rounded-lg border border-dashed p-3">
      <ToggleGroup
        variant="outline"
        size="sm"
        spacing={0}
        value={[kind]}
        onValueChange={(value: string[]) => { const next = value[0] as StageKind | undefined; if (next) reset(next) }}
        aria-label="Stage kind"
      >
        {KINDS.map((option) => <ToggleGroupItem key={option} value={option}>{kindLabel(option)}</ToggleGroupItem>)}
      </ToggleGroup>
      <StageFields
        id="new-stage"
        draft={draft}
        stageTypes={types[kind]}
        outcomes={kind === 'interviewing' ? types.outcomes : null}
        onChange={setDraft}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
        <Button
          type="button"
          size="sm"
          disabled={busy || draft.stageType === '' || !contactsValid(draft.contacts)}
          onClick={() => void submit()}
        >
          Add {kindLabel(kind).toLowerCase()}
        </Button>
      </div>
    </div>
  )
}
