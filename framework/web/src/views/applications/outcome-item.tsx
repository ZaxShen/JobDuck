import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useFlash } from '@/hooks/use-flash'
import { applicationsPath, errorMessage, fetchJSON, postJSON } from '@/lib/api'
import { stamp, statusLabel } from '@/lib/format'
import type { ApplicationRow, Outcome } from '@/lib/types'

interface OutcomeItemProps {
  outcome: Outcome
  onChanged: () => Promise<void>
}

export function OutcomeItem({ outcome, onChanged }: OutcomeItemProps) {
  const flash = useFlash()
  const [search, setSearch] = useState(outcome.company ?? '')
  const [options, setOptions] = useState<ApplicationRow[] | null>(null)
  const [choice, setChoice] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      fetchJSON<ApplicationRow[]>(applicationsPath({ q: search.trim(), limit: '50' }))
        .then((rows) => { if (live) setOptions(rows) })
        .catch((error: unknown) => flash(errorMessage(error), true))
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [search, flash])

  const run = async (action: () => Promise<unknown>, message?: string) => {
    try {
      await action()
      if (message) flash(message)
      await onChanged()
    } catch (error) {
      flash(errorMessage(error), true)
    }
  }

  const match = () => {
    if (!choice) return flash('Choose an application to match', true)
    return run(
      () => postJSON(`/api/outcomes/${outcome.id}/match`, { application_id: Number(choice) }),
      'Matched; application closed as deny by employer.',
    )
  }

  const items = (options ?? []).map((row) => ({
    value: String(row.id),
    label: `${row.company} — ${row.title} (${statusLabel(row.status)})`,
  }))

  return (
    <li className="flex flex-col gap-3 border-b py-3 last:border-b-0 lg:flex-row lg:items-center">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium">{outcome.company || 'Unknown company'}</p>
        <p className="truncate text-muted-foreground">{outcome.title || outcome.job_ref || ''}</p>
        <p className="text-xs text-muted-foreground">Received {stamp(outcome.received_at)}</p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row lg:w-[28rem]">
        <Input
          type="search"
          placeholder="Search by company or title"
          aria-label="Search applications to match"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select items={items} value={choice} onValueChange={(value) => setChoice(value)}>
          <SelectTrigger className="w-full sm:w-56" aria-label="Application">
            <SelectValue placeholder={items.length ? 'Choose an application' : 'No matching applications'} />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="flex gap-2">
        <Button type="button" onClick={() => void match()}>Match</Button>
        <Button type="button" variant="outline" onClick={() => void run(() => postJSON(`/api/outcomes/${outcome.id}/dismiss`))}>
          Dismiss
        </Button>
      </div>
    </li>
  )
}
