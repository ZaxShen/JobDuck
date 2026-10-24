import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { outcomeLabel, stageTypeLabel } from '@/lib/stages'
import { ContactsEditor, type ContactRow } from '@/views/applications/contacts-editor'

export interface StageDraft {
  stageType: string
  date: string
  outcome: string | null
  note: string
  contacts: ContactRow[]
}

interface StageFieldsProps {
  id: string
  draft: StageDraft
  stageTypes: string[]
  outcomes: string[] | null
  onChange: (draft: StageDraft) => void
}

function Choice({ id, label, value, options, format, onChange }: {
  id: string
  label: string
  value: string | null
  options: string[]
  format: (value: string) => string
  onChange: (value: string) => void
}) {
  const items = options.map((option) => ({ value: option, label: format(option) }))
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-muted-foreground">{label}</Label>
      <Select items={items} value={value} onValueChange={(next) => { if (next) onChange(next) }}>
        <SelectTrigger id={id} className="w-full"><SelectValue placeholder="Choose…" /></SelectTrigger>
        <SelectContent>
          {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  )
}

export function StageFields({ id, draft, stageTypes, outcomes, onChange }: StageFieldsProps) {
  const set = (patch: Partial<StageDraft>) => onChange({ ...draft, ...patch })
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Choice
          id={`${id}-type`}
          label="Stage"
          value={draft.stageType || null}
          options={stageTypes}
          format={stageTypeLabel}
          onChange={(stageType) => set({ stageType })}
        />
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-date`} className="text-muted-foreground">Date</Label>
          <Input id={`${id}-date`} type="date" value={draft.date} onChange={(event) => set({ date: event.target.value })} />
        </div>
      </div>
      {outcomes && (
        <Choice
          id={`${id}-outcome`}
          label="Outcome"
          value={draft.outcome}
          options={outcomes}
          format={outcomeLabel}
          onChange={(outcome) => set({ outcome })}
        />
      )}
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-note`} className="text-muted-foreground">Note</Label>
        <Textarea
          id={`${id}-note`}
          rows={3}
          placeholder="Who you met, what was asked, next steps"
          value={draft.note}
          onChange={(event) => set({ note: event.target.value })}
        />
      </div>
      <ContactsEditor id={`${id}-contacts`} rows={draft.contacts} onChange={(contacts) => set({ contacts })} />
    </div>
  )
}
