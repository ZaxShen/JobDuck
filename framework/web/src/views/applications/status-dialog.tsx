import { useState } from 'react'
import { AlertCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { errorMessage, patchJSON, postJSON } from '@/lib/api'
import { stageTypeLabel } from '@/lib/stages'
import {
  type DialogScope, type StatusEntry, type StatusRequest, dialogScope, entryLabel, isEntryDate,
} from '@/lib/status-entries'
import type { StageTypes } from '@/lib/types'
import { Choice } from '@/views/applications/stage-fields'

export interface StatusDialogRequest {
  target: string
  title: string
  subject: string
  bulk?: boolean
}

interface StatusDialogProps {
  request: StatusDialogRequest | null
  types: StageTypes | null
  onClose: () => void
  onSubmit: (scope: DialogScope, entry: StatusEntry) => Promise<void>
}

export const sendStatus = ({ method, path, body }: StatusRequest) =>
  (method === 'POST' ? postJSON(path, body) : patchJSON(path, body))

export function StatusDialog({ request, types, onClose, onSubmit }: StatusDialogProps) {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        {request && (
          <StatusForm
            key={`${request.title}-${request.subject}-${request.target}-${types ? 'typed' : 'untyped'}`}
            request={request}
            scope={dialogScope(request.target, types, request.bulk)}
            onSubmit={onSubmit}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function StatusForm({ request, scope, onSubmit }: {
  request: StatusDialogRequest
  scope: DialogScope
  onSubmit: StatusDialogProps['onSubmit']
}) {
  const [entry, setEntry] = useState<StatusEntry>({ choice: scope.initial, date: '', note: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const stage = scope.stageKind !== null
  const ready = entry.choice !== '' && isEntryDate(entry.date)
  const set = (patch: Partial<StatusEntry>) => setEntry((current) => ({ ...current, ...patch }))

  const submit = async () => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(scope, entry)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <DialogHeader>
        <DialogTitle>{request.title}</DialogTitle>
        <DialogDescription>
          {request.subject}. {stage ? 'Pick the round and the date it happened or is scheduled.' : 'Pick the date it happened.'}
          {' '}The note is optional.
        </DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-2 gap-2">
        <Choice
          id="status-entry-choice"
          label={stage ? 'Stage' : 'Status'}
          value={entry.choice || null}
          options={scope.options}
          format={stage ? stageTypeLabel : entryLabel}
          onChange={(choice) => set({ choice })}
        />
        <div className="space-y-1.5">
          <Label htmlFor="status-entry-date" className="text-muted-foreground">Date</Label>
          <Input
            id="status-entry-date"
            type="date"
            required
            value={entry.date}
            onChange={(event) => set({ date: event.target.value })}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="status-entry-note" className="text-muted-foreground">Note</Label>
        <Textarea
          id="status-entry-note"
          rows={3}
          placeholder="Optional"
          value={entry.note}
          onChange={(event) => set({ note: event.target.value })}
        />
      </div>
      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={!ready || busy}>Save</Button>
      </DialogFooter>
    </form>
  )
}
