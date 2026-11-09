import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLinkIcon, HourglassIcon, Trash2Icon } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { StatusBadge } from '@/components/status-badge'
import { useFlash } from '@/hooks/use-flash'
import { POLL_MS, isVisible } from '@/hooks/use-visible-poll'
import { type SaveResult, deleteJSON, errorMessage, fetchJSON, isConflict, patchJSON, postJSON } from '@/lib/api'
import { followUpSentLabel } from '@/lib/follow-ups'
import { postingPay, safeUrl, statusLabel } from '@/lib/format'
import { kindLabel, outcomeLabel, stageTypeLabel } from '@/lib/stages'
import { type DialogScope, type StatusEntry, statusRequest, timelineOrder, undoableEntryId } from '@/lib/status-entries'
import type { ApplicationEvent, ApplicationRow, Stage, StageKind, StageTypes } from '@/lib/types'
import { AddStageForm } from '@/views/applications/add-stage-form'
import { PAY_FIELDS, type PayKey, PaySection } from '@/views/applications/pay-section'
import { StageCard } from '@/views/applications/stage-card'
import { StatusActionsMenu } from '@/views/applications/status-actions-menu'
import { StatusDialog, type StatusDialogRequest, sendStatus } from '@/views/applications/status-dialog'
import { TimelineEntry } from '@/views/applications/timeline-entry'

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
type FieldKey = OverrideKey | PayKey | 'currency' | 'note'
type Form = Record<FieldKey, string>
type FillMode = 'poll' | 'saved' | 'reload'

const FIELD_KEYS: FieldKey[] = [
  ...OVERRIDES.map(([field]) => `${field}_override` as const), ...PAY_FIELDS.map(([key]) => key), 'currency', 'note',
]
const PAY_KEYS = new Set<FieldKey>(PAY_FIELDS.map(([key]) => key))
const PAY_ERROR = 'Enter a whole number, 0 or more.'
const PENDING_REASON_MAX = 500

const storedText = (app: ApplicationRow, key: FieldKey) => (app[key] === null ? '' : String(app[key]))
const formOf = (app: ApplicationRow | null) =>
  Object.fromEntries(FIELD_KEYS.map((key) => [key, app ? storedText(app, key) : ''])) as Form
const parsePay = (text: string) => (/^\d+$/.test(text) ? Number(text) : null)

const isStageEvent = (event: ApplicationEvent) =>
  event.stage_type !== null && (event.to_status === 'interviewing' || event.to_status === 'offered')

function eventLabel(event: ApplicationEvent): string {
  if (event.kind !== null) return followUpSentLabel(event.kind)
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
  terminal: string[]
  onClose: () => void
  onChanged: () => Promise<void>
}

export function ApplicationSheet({ id, terminal, onClose, onChanged }: ApplicationSheetProps) {
  const flash = useFlash()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [form, setForm] = useState<Form>(() => formOf(null))
  const [payErrors, setPayErrors] = useState<Partial<Record<PayKey, string>>>({})
  const [types, setTypes] = useState<StageTypes | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState<string | null>(null)
  const [statusDialog, setStatusDialog] = useState<StatusDialogRequest | null>(null)
  const shown = useRef<number | null>(null)
  const version = useRef('')
  const latest = useRef('')
  const outsideChanges = useRef(0)
  const dirty = useRef(new Set<FieldKey>())
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  const fill = useCallback((data: Detail, mode: FillMode) => {
    if (data.application.id !== shown.current) return
    if (mode === 'reload') dirty.current.clear()
    if (mode !== 'poll' || dirty.current.size === 0) version.current = data.application.updated_at
    if (mode !== 'saved' && data.application.updated_at !== latest.current) outsideChanges.current += 1
    latest.current = data.application.updated_at
    const keep = new Set(dirty.current)
    const next = formOf(data.application)
    setDetail(data)
    setForm((current) => Object.fromEntries(FIELD_KEYS.map((key) => [key, keep.has(key) ? current[key] : next[key]])) as Form)
  }, [])

  const enqueue = useCallback(<T,>(task: () => Promise<T>) => {
    const next = queue.current.then(task)
    queue.current = next.catch(() => undefined)
    return next
  }, [])

  const load = useCallback((target: number, mode: FillMode) =>
    fetchJSON<Detail>(`/api/applications/${target}`).then((data) => fill(data, mode)), [fill])

  useEffect(() => {
    fetchJSON<StageTypes>('/api/stage-types').then(setTypes).catch((error: unknown) => flash(errorMessage(error), true))
  }, [flash])

  useEffect(() => {
    shown.current = id
    dirty.current.clear()
    setPayErrors({})
    setReason(null)
    setStatusDialog(null)
    if (id === null) return
    void enqueue(() => load(id, 'reload')).catch((error: unknown) => {
      flash(errorMessage(error), true)
      onClose()
    })
    const timer = setInterval(() => {
      if (isVisible()) void enqueue(() => load(id, 'poll')).catch(() => undefined)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [id, flash, onClose, enqueue, load])

  const attempt = (action: () => Promise<unknown>, message: string, done?: () => void): Promise<void> =>
    enqueue(async () => {
      if (id === null) throw new Error('No application is open.')
      try {
        await action()
      } catch (error) {
        if (isConflict(error)) {
          await load(id, 'reload').catch((reloadError: unknown) => flash(errorMessage(reloadError), true))
          await onChanged()
        }
        throw error
      }
      flash(message)
      if (done) done()
      else await load(id, 'saved').catch((error: unknown) => flash(errorMessage(error), true))
      await onChanged()
    })

  const run = (action: () => Promise<unknown>, message: string, done?: () => void): Promise<SaveResult> =>
    attempt(action, message, done).then((): SaveResult => 'saved', (error: unknown): SaveResult => {
      flash(errorMessage(error), true)
      return isConflict(error) ? 'reloaded' : 'failed'
    })

  const expected = () => ({ expected_updated_at: version.current })

  const openVersion = () => {
    const opened = latest.current
    const mark = outsideChanges.current
    return () => (outsideChanges.current === mark ? latest.current : opened)
  }

  const patch = (body: Record<string, unknown>, message: string) =>
    run(() => patchJSON(`/api/applications/${id}`, { ...body, ...expected() }), message)

  const commit = (key: FieldKey) => {
    if (!app || !dirty.current.has(key)) return
    dirty.current.delete(key)
    if (form[key] === storedText(app, key)) return
    const text = form[key].trim()
    if (PAY_KEYS.has(key) && text !== '' && parsePay(text) === null) {
      setPayErrors((current) => ({ ...current, [key]: PAY_ERROR }))
      setForm((current) => ({ ...current, [key]: storedText(app, key) }))
      return
    }
    const value = PAY_KEYS.has(key) ? (text === '' ? null : parsePay(text)) : key === 'note' ? form[key] : text
    void patch({ [key]: value }, key === 'note' ? 'Note saved.' : 'Saved.')
  }

  const setField = (key: FieldKey, value: string) => {
    dirty.current.add(key)
    if (PAY_KEYS.has(key)) setPayErrors((current) => ({ ...current, [key]: undefined }))
    setForm((current) => ({ ...current, [key]: value }))
  }

  const markPending = async () => {
    const text = reason?.trim()
    if (!text) return
    const result = await patch({ status: 'pending', pending_reason: text }, 'Marked pending.')
    if (result !== 'failed') setReason(null)
  }

  const submitStatus = async (scope: DialogScope, entry: StatusEntry) => {
    if (id === null || !statusDialog) return
    await attempt(() => sendStatus(statusRequest(id, scope, entry, version.current)), `${statusDialog.title}.`)
    setStatusDialog(null)
  }

  const remove = async () => {
    const result = await run(() => deleteJSON(`/api/applications/${id}`, expected()), 'Application deleted.', onClose)
    if (result !== 'failed') setConfirming(false)
  }

  const app = detail?.application.id === id ? detail.application : null
  const undoable = detail ? undoableEntryId(detail.events) : null

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
            {app.status === 'pending' && app.pending_reason && (
              <div role="status" className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
                    <HourglassIcon className="size-4" />
                    Waiting on you
                  </p>
                  <Button type="button" variant="ghost" size="xs" onClick={() => setReason(app.pending_reason ?? '')}>
                    Edit
                  </Button>
                </div>
                <p className="whitespace-pre-wrap">{app.pending_reason}</p>
              </div>
            )}
            <section className="space-y-1.5" aria-labelledby="f-status">
              <h3 id="f-status" className="text-sm font-medium">Status</h3>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <StatusBadge status={app.status} />
                <div className="flex items-center gap-2">
                  {app.status === 'saved' && (
                    <Button type="button" variant="outline" size="xs" className="text-muted-foreground" onClick={() => setReason('')}>
                      <HourglassIcon data-icon="inline-start" />
                      Mark pending
                    </Button>
                  )}
                  <StatusActionsMenu
                    row={app}
                    busy={false}
                    onAction={(_row, action) => setStatusDialog({ target: action.target, title: action.label, subject: app.company })}
                  />
                </div>
              </div>
              {terminal.includes(app.status) && (
                <p className="text-xs text-muted-foreground">Closed. To reopen it, Undo its latest entry in the Timeline.</p>
              )}
            </section>
            <div className="space-y-1.5">
              <Label htmlFor="f-note">Note</Label>
              <Textarea
                id="f-note"
                rows={5}
                placeholder="Interview notes, contacts, next steps"
                value={form.note}
                onChange={(event) => setField('note', event.target.value)}
                onBlur={() => commit('note')}
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
                      value={form[key]}
                      maxLength={key === 'country_override' ? 2 : undefined}
                      placeholder={app[`posting_${field}`] ?? OVERRIDE_HINTS[key] ?? ''}
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
                        openVersion={openVersion}
                        onSave={(body) => run(() => patchJSON(`/api/stages/${stage.id}`, body), 'Stage saved.')}
                        onDelete={() => run(() => deleteJSON(`/api/stages/${stage.id}`, expected()), 'Stage deleted.')}
                      />
                    ))}
                  </ul>
                  <AddStageForm
                    types={types}
                    onAdd={(body) => run(() => postJSON(`/api/applications/${app.id}/stages`, { ...body, ...expected() }), 'Stage added.')}
                  />
                </>
              )}
            </section>
            <Separator />
            <PaySection
              values={form}
              errors={payErrors}
              onChange={setField}
              onCommit={commit}
              postingPay={postingPay(app)}
              postingCurrency={app.posting_currency}
            />
            <Separator />
            <div className="space-y-3">
              <h3 className="text-sm font-medium">Timeline</h3>
              <ol className="space-y-3 border-l pl-4">
                {timelineOrder(detail.events).map((event) => (
                  <TimelineEntry
                    key={event.id}
                    event={event}
                    label={eventLabel(event)}
                    undoable={event.id === undoable}
                    openVersion={openVersion}
                    onSave={(body) => run(() => patchJSON(`/api/events/${event.id}`, body), 'Entry saved.')}
                    onUndo={() => run(() => deleteJSON(`/api/events/${event.id}`, expected()), 'Entry undone.')}
                  />
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
      <AlertDialog open={reason !== null} onOpenChange={(open) => { if (!open) setReason(null) }}>
        <AlertDialogContent>
          <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void markPending() }}>
            <AlertDialogHeader>
              <AlertDialogTitle>What Is It Waiting On?</AlertDialogTitle>
              <AlertDialogDescription>
                Pending means the application is stopped until someone acts. Say what has to happen next.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="f-pending-reason">Reason</Label>
              <Textarea
                id="f-pending-reason"
                rows={3}
                maxLength={PENDING_REASON_MAX}
                placeholder="Solve the CAPTCHA on the form, then tell the agent to continue."
                value={reason ?? ''}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction type="submit" disabled={!reason?.trim()}>Mark pending</AlertDialogAction>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
      <StatusDialog request={statusDialog} types={types} onClose={() => setStatusDialog(null)} onSubmit={submitStatus} />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete This Application?</AlertDialogTitle>
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
