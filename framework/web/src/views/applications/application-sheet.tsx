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
import { deleteJSON, errorMessage, fetchJSON, patchJSON } from '@/lib/api'
import { safeUrl, stamp, statusLabel } from '@/lib/format'
import type { ApplicationEvent, ApplicationRow } from '@/lib/types'

const OVERRIDES = [
  ['title', 'Title'],
  ['company', 'Company'],
  ['location', 'Location'],
] as const

type OverrideKey = `${(typeof OVERRIDES)[number][0]}_override`

interface Detail {
  application: ApplicationRow
  events: ApplicationEvent[]
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
  const [overrides, setOverrides] = useState<Record<OverrideKey, string>>({ title_override: '', company_override: '', location_override: '' })
  const [confirming, setConfirming] = useState(false)

  const fill = (data: Detail) => {
    setDetail(data)
    setNote(data.application.note ?? '')
    setOverrides({
      title_override: data.application.title_override ?? '',
      company_override: data.application.company_override ?? '',
      location_override: data.application.location_override ?? '',
    })
  }

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

  const patch = async (body: Record<string, unknown>, message: string) => {
    if (id === null) return
    try {
      await patchJSON(`/api/applications/${id}`, body)
      fill(await fetchJSON<Detail>(`/api/applications/${id}`))
      flash(message)
      await onChanged()
    } catch (error) {
      flash(errorMessage(error), true)
    }
  }

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
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
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
                      value={overrides[key]}
                      placeholder={app[`posting_${field}`] ?? ''}
                      onChange={(event) => setOverrides({ ...overrides, [key]: event.target.value })}
                      onBlur={() => { if (overrides[key] !== (app[key] ?? '')) void patch({ [key]: overrides[key] }, 'Saved.') }}
                    />
                  </div>
                )
              })}
            </fieldset>
            <Separator />
            <div className="space-y-3">
              <h3 className="text-sm font-medium">Timeline</h3>
              <ol className="space-y-3 border-l pl-4">
                {detail.events.slice().reverse().map((event) => (
                  <li key={event.id} className="space-y-0.5">
                    <p className="capitalize">
                      {event.from_status
                        ? `${statusLabel(event.from_status)} → ${statusLabel(event.to_status)}`
                        : `Created as ${statusLabel(event.to_status)}`}
                    </p>
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
