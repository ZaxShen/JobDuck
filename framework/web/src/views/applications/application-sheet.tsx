import { useEffect, useState } from 'react'
import { ExternalLinkIcon, Trash2Icon } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { useFlash } from '@/hooks/use-flash'
import { deleteJSON, errorMessage, fetchJSON, patchJSON, postJSON } from '@/lib/api'
import { safeUrl, stamp, statusLabel } from '@/lib/format'
import { kindLabel, outcomeLabel, stageTypeLabel } from '@/lib/stages'
import type { ApplicationEvent, ApplicationRow, Stage, StageKind, StageTypes } from '@/lib/types'
import { AddStageForm } from '@/views/applications/add-stage-form'
import { PAY_FIELDS, type PayKey, PaySection } from '@/views/applications/pay-section'
import { StageCard } from '@/views/applications/stage-card'

const OVERRIDES = [
  ['title', 'Title'],
  ['company', 'Company'],
  ['location', 'Location'],
  ['country', 'Country'],
  ['state', 'State'],
  ['city', 'City'],
] as const

const OVERRIDE_HINTS: Partial<Record<OverrideKey, string>> = {
  country_override: 'US (2-letter code)',
  state_override: 'State or province',
  city_override: 'City',
}

type OverrideKey = `${(typeof OVERRIDES)[number][0]}_override`
type FieldKey = OverrideKey | PayKey | 'currency'

const FIELD_KEYS: FieldKey[] = [
  ...OVERRIDES.map(([field]) => `${field}_override` as const), ...PAY_FIELDS.map(([key]) => key), 'currency',
]
const PAY_KEYS = new Set<FieldKey>(PAY_FIELDS.map(([key]) => key))

const storedText = (app: ApplicationRow, key: FieldKey) => (app[key] === null ? '' : String(app[key]))

const isStageEvent = (event: ApplicationEvent) =>
  event.stage_type !== null && (event.to_status === 'interviewing' || event.to_status === 'offered')

function eventLabel(event: ApplicationEvent): string {
  if (isStageEvent(event)) {
    return [kindLabel(event.to_status as StageKind), stageTypeLabel(event.stage_type ?? ''), event.outcome && outcomeLabel(event.outcome)]
      .filter(Boolean).join(' · ')
  }
  return event.from_status
    ? `${statusLabel(event.from_status)} → ${statusLabel(event.to_status)}`
    : `Created as ${statusLabel(event.to_status)}`
}

interface Detail {
  application: ApplicationRow
  events: ApplicationEvent[]
  stages: Stage[]
}

interface ApplicationSheetProps {
  id: number | null
  statuses: string[]
  terminal: string[]
  onClose: () => void
  onChanged: () => Promise<void>
}

export function ApplicationSheet({ id, statuses, terminal, onClose, onChanged }: ApplicationSheetProps) {
  const flash = useFlash()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [note, setNote] = useState('')
  const [fields, setFields] = useState<Record<FieldKey, string>>(
    () => Object.fromEntries(FIELD_KEYS.map((key) => [key, ''])) as Record<FieldKey, string>,
  )
  const [types, setTypes] = useState<StageTypes | null>(null)
  const [confirming, setConfirming] = useState(false)

  const fill = (data: Detail) => {
    setDetail(data)
    setNote(data.application.note ?? '')
    setFields(Object.fromEntries(FIELD_KEYS.map((key) => [key, storedText(data.application, key)])) as Record<FieldKey, string>)
  }

  useEffect(() => {
    fetchJSON<StageTypes>('/api/stage-types').then(setTypes).catch((error: unknown) => flash(errorMessage(error), true))
  }, [flash])

  useEffect(() => {
    if (id === null) return
    let live = true
    fetchJSON<Detail>(`/api/applications/${id}`)
      .then((data) => { if (live) fill(data) })
      .catch((error: unknown) => {
        flash(errorMessage(error), true)
        onClose()
      })
    return () => { live = false }
  }, [id, flash, onClose])

  const run = async (action: () => Promise<unknown>, message: string) => {
    if (id === null) return false
    try {
      await action()
      fill(await fetchJSON<Detail>(`/api/applications/${id}`))
      flash(message)
      await onChanged()
      return true
    } catch (error) {
      flash(errorMessage(error), true)
      return false
    }
  }

  const patch = (body: Record<string, unknown>, message: string) =>
    run(() => patchJSON(`/api/applications/${id}`, body), message)

  const commit = (key: FieldKey) => {
    if (!app || fields[key] === storedText(app, key)) return
    const text = fields[key].trim()
    void patch({ [key]: PAY_KEYS.has(key) ? (text === '' ? null : Number(text)) : text }, 'Saved.')
  }

  const setField = (key: FieldKey, value: string) => setFields((current) => ({ ...current, [key]: value }))

  const remove = async () => {
    if (id === null) return
    try {
      await deleteJSON(`/api/applications/${id}`)
      setConfirming(false)
      onClose()
      flash('Application deleted.')
      await onChanged()
    } catch (error) {
      flash(errorMessage(error), true)
    }
  }

  const app = detail?.application.id === id ? detail.application : null
  const items = statuses.map((status) => ({
    value: status,
    label: terminal.includes(status) ? `${statusLabel(status)} (closed)` : statusLabel(status),
  }))

  return (
    <Sheet open={id !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader className="pr-10">
          <SheetTitle>{app ? `${app.company} — ${app.title}` : 'Loading…'}</SheetTitle>
          <SheetDescription>{app ? [app.location, app.work_mode].filter(Boolean).join(' · ') : ''}</SheetDescription>
          {app && safeUrl(app.url) && (
            <a
              href={app.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex w-fit items-center gap-1 pt-1 text-sm text-primary underline-offset-4 hover:underline"
            >
              Open posting <ExternalLinkIcon className="size-3.5" />
            </a>
          )}
        </SheetHeader>
        {app && detail && (
          <div className="space-y-5 px-4 pb-6">
            <div className="space-y-1.5">
              <Label htmlFor="f-status">Status</Label>
              <Select
                items={items}
                value={app.status}
                onValueChange={(status) => { if (status && status !== app.status) void patch({ status }, 'Status updated.') }}
              >
                <SelectTrigger id="f-status" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-note">Note</Label>
              <Textarea
                id="f-note"
                rows={5}
                placeholder="Interview notes, contacts, next steps"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                onBlur={() => { if (note !== (app.note ?? '')) void patch({ note }, 'Note saved.') }}
              />
            </div>
            <fieldset className="space-y-3">
              <legend className="mb-2 text-sm font-medium">Overrides</legend>
              {OVERRIDES.map(([field, label]) => {
                const key = `${field}_override` as const
                return (
                  <div key={key} className="space-y-1.5">
                    <Label htmlFor={`f-${key}`} className="text-muted-foreground">{label}</Label>
                    <Input
                      id={`f-${key}`}
                      value={fields[key]}
                      maxLength={key === 'country_override' ? 2 : undefined}
                      placeholder={OVERRIDE_HINTS[key] ?? app[`posting_${field as 'title' | 'company' | 'location'}`] ?? ''}
                      onChange={(event) => setField(key, key === 'country_override' ? event.target.value.toUpperCase() : event.target.value)}
                      onBlur={() => commit(key)}
                    />
                  </div>
                )
              })}
            </fieldset>
            <Separator />
            <section className="space-y-3">
              <h3 className="text-sm font-medium">Interviews</h3>
              {detail.stages.length === 0 && <p className="text-muted-foreground">No interviews or offers recorded yet.</p>}
              {types && (
                <>
                  <ul className="space-y-2">
                    {detail.stages.map((stage) => (
                      <StageCard
                        key={stage.id}
                        stage={stage}
                        types={types}
                        onSave={(body) => run(() => patchJSON(`/api/stages/${stage.id}`, body), 'Stage saved.')}
                        onDelete={() => run(() => deleteJSON(`/api/stages/${stage.id}`), 'Stage deleted.')}
                      />
                    ))}
                  </ul>
                  <AddStageForm
                    types={types}
                    onAdd={(body) => run(() => postJSON(`/api/applications/${app.id}/stages`, body), 'Stage added.')}
                  />
                </>
              )}
            </section>
            <Separator />
            <PaySection values={fields} onChange={setField} onCommit={commit} />
            <Separator />
            <div className="space-y-3">
              <h3 className="text-sm font-medium">Timeline</h3>
              <ol className="space-y-3 border-l pl-4">
                {detail.events.slice().reverse().map((event) => (
                  <li key={event.id} className="space-y-0.5">
                    <p className={isStageEvent(event) ? undefined : 'capitalize'}>{eventLabel(event)}</p>
                    {event.note && <p className="whitespace-pre-wrap text-muted-foreground">{event.note}</p>}
                    <p className="text-xs text-muted-foreground">{stamp(event.created_at)} · {event.source}</p>
                  </li>
                ))}
              </ol>
            </div>
            <Button type="button" variant="destructive" className="w-full" onClick={() => setConfirming(true)}>
              <Trash2Icon />
              Delete application
            </Button>
          </div>
        )}
      </SheetContent>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this application?</AlertDialogTitle>
            <AlertDialogDescription>It disappears from the board.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  )
}
