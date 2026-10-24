import { useCallback, useEffect, useState } from 'react'
import { InboxIcon, SearchIcon } from 'lucide-react'
import { SectionCard } from '@/components/composed/section-card'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useFlash } from '@/hooks/use-flash'
import { useVisiblePoll } from '@/hooks/use-visible-poll'
import { applicationsPath, errorMessage, fetchJSON } from '@/lib/api'
import { day, statusLabel } from '@/lib/format'
import type { ApplicationRow, Outcome, Summary } from '@/lib/types'
import { cn } from '@/lib/utils'
import { ApplicationSheet } from '@/views/applications/application-sheet'
import { OutcomeItem } from '@/views/applications/outcome-item'

interface ApplicationsViewProps {
  active: boolean
  statuses: string[]
  terminal: string[]
}

export function ApplicationsView({ active, statuses, terminal }: ApplicationsViewProps) {
  const flash = useFlash()
  const [filter, setFilter] = useState('')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<ApplicationRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const [selected, setSelected] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [nextSummary, nextRows, nextOutcomes] = await Promise.all([
        fetchJSON<Summary>('/api/summary'),
        fetchJSON<ApplicationRow[]>(applicationsPath({ status: filter, q })),
        fetchJSON<Outcome[]>('/api/outcomes?status=needs_match'),
      ])
      setSummary(nextSummary)
      setRows(nextRows)
      setOutcomes(nextOutcomes)
      setLoaded(true)
    } catch (error) {
      flash(errorMessage(error), true)
    }
  }, [filter, q, flash])

  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh])

  useVisiblePoll(refresh, active)

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 200)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    if (!active) setSelected(null)
  }, [active])

  const close = useCallback(() => setSelected(null), [])
  const total = summary ? Object.values(summary.counts).reduce((a, b) => a + b, 0) : 0
  const chips: [string, string, number][] = [
    ['', 'All', total],
    ...statuses.map((status): [string, string, number] => [status, statusLabel(status), summary?.counts[status] ?? 0]),
  ]

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6 animate-in fade-in duration-500">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Applications</h1>
        <p className="text-sm text-muted-foreground">Everything your agent applied to or is waiting on you for, newest first.</p>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <nav aria-label="Filter by status" className="flex flex-wrap gap-1.5">
          {chips.map(([value, text, n]) => (
            <Button
              key={value || 'all'}
              type="button"
              size="sm"
              variant={filter === value ? 'default' : 'outline'}
              aria-pressed={filter === value}
              className="capitalize"
              onClick={() => setFilter(value)}
            >
              {text}
              <span className={cn('tabular-nums', filter === value ? 'opacity-80' : 'text-muted-foreground')}>{n}</span>
            </Button>
          ))}
        </nav>
        <div className="relative lg:w-72">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            className="pl-8"
            placeholder="Search company, title, location"
            aria-label="Search applications"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      {outcomes.length > 0 && (
        <SectionCard
          title="Needs a match"
          description="Rejection emails that could not be matched to an application automatically."
        >
          <ul>
            {outcomes.map((outcome) => <OutcomeItem key={outcome.id} outcome={outcome} onChanged={refresh} />)}
          </ul>
        </SectionCard>
      )}

      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Company</TableHead>
              <TableHead>Title</TableHead>
              <TableHead className="hidden md:table-cell">Location</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden sm:table-cell">Applied</TableHead>
              <TableHead className="hidden lg:table-cell">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.id}
                data-state={row.id === selected ? 'selected' : undefined}
                className="cursor-pointer"
                tabIndex={0}
                onClick={() => setSelected(row.id)}
                onKeyDown={(event) => { if (event.key === 'Enter') setSelected(row.id) }}
              >
                <TableCell className="max-w-40 truncate font-medium">{row.company}</TableCell>
                <TableCell className="max-w-56">
                  <div className="truncate">{row.title}</div>
                  {row.pending_reason && (
                    <div className="truncate text-xs text-amber-700 dark:text-amber-400" title={row.pending_reason}>
                      {row.pending_reason}
                    </div>
                  )}
                </TableCell>
                <TableCell className="hidden max-w-48 truncate text-muted-foreground md:table-cell">{row.location ?? ''}</TableCell>
                <TableCell><StatusBadge status={row.status} /></TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">{day(row.applied_at)}</TableCell>
                <TableCell className="hidden text-muted-foreground lg:table-cell">{day(row.updated_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {loaded && rows.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-sm text-muted-foreground">
            <InboxIcon className="size-5" />
            No applications yet. Ask your agent to apply to a posting.
          </div>
        )}
      </div>

      <ApplicationSheet id={selected} statuses={statuses} terminal={terminal} onClose={close} onChanged={refresh} />
    </div>
  )
}
