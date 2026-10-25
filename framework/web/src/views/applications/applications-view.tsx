import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { EyeIcon, EyeOffIcon, InboxIcon, KanbanIcon, ListIcon, SearchIcon } from 'lucide-react'
import { SectionCard } from '@/components/composed/section-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useFlash } from '@/hooks/use-flash'
import { useVisiblePoll } from '@/hooks/use-visible-poll'
import { applicationsPath, errorMessage, fetchJSON, isConflict, patchJSON } from '@/lib/api'
import type { StatusAction } from '@/lib/board'
import { statusLabel } from '@/lib/format'
import type { ApplicationRow, Outcome, Summary } from '@/lib/types'
import { ApplicationBoard } from '@/views/applications/application-board'
import { ApplicationList } from '@/views/applications/application-list'
import { ApplicationSheet } from '@/views/applications/application-sheet'
import { OutcomeItem } from '@/views/applications/outcome-item'

interface ApplicationsViewProps {
  active: boolean
  statuses: string[]
  terminal: string[]
}

type ViewMode = 'board' | 'list'

const VIEW_MODE_KEY = 'applications-view-mode'

function readViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'board'
  } catch {
    return 'board'
  }
}

function saveViewMode(mode: ViewMode): void {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode)
  } catch {
    return
  }
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-sm text-muted-foreground">
      <InboxIcon className="size-5" aria-hidden />
      {children}
    </div>
  )
}

export function ApplicationsView({ active, statuses, terminal }: ApplicationsViewProps) {
  const flash = useFlash()
  const [view, setView] = useState<ViewMode>(readViewMode)
  const [filter, setFilter] = useState('')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [rows, setRows] = useState<ApplicationRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

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

  const chooseView = (value: string[]) => {
    const next = value[0]
    if (next !== 'board' && next !== 'list') return
    setView(next)
    saveViewMode(next)
  }

  const runAction = async (row: ApplicationRow, action: StatusAction) => {
    setBusyId(row.id)
    try {
      await patchJSON(`/api/applications/${row.id}`, { status: action.target, expected_updated_at: row.updated_at })
      flash(`${action.label}: ${row.company}`)
    } catch (error) {
      flash(errorMessage(error), true)
      if (!isConflict(error)) return
    } finally {
      setBusyId(null)
    }
    await refresh()
  }

  const total = summary ? Object.values(summary.counts).reduce((a, b) => a + b, 0) : 0
  const items = [
    { value: '', label: `All statuses (${total})` },
    ...statuses.map((status) => ({ value: status, label: `${sentence(statusLabel(status))} (${summary?.counts[status] ?? 0})` })),
  ]

  const closedFilter = terminal.includes(filter)
  const activeRows = rows.filter((row) => !terminal.includes(row.status))
  const hiddenCount = rows.length - activeRows.length
  const listRows = showHidden || closedFilter ? rows : activeRows

  const content = () => {
    if (!loaded) return null
    if (rows.length === 0) {
      return (
        <EmptyState>
          {filter || q ? 'No applications match the current filters.' : 'No applications yet. Ask your agent to save or apply to a posting.'}
        </EmptyState>
      )
    }
    if (view === 'board') {
      return <ApplicationBoard rows={rows} terminal={terminal} busyId={busyId} onOpen={setSelected} onAction={runAction} />
    }
    return (
      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        {listRows.length > 0
          ? <ApplicationList rows={listRows} selected={selected} onOpen={setSelected} />
          : <EmptyState>No active applications. Click Show hidden to see closed ones.</EmptyState>}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 animate-in fade-in duration-500">
      <p className="text-sm text-muted-foreground">Everything your agent saved, applied to or is waiting on you for, newest first.</p>

      <div className="flex flex-wrap items-center gap-3">
        <Select items={items} value={filter} onValueChange={(value: string | null) => setFilter(value ?? '')}>
          <SelectTrigger aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value || 'all'} value={item.value}>{item.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative w-full sm:w-72">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            className="pl-8"
            placeholder="Search company, title, location…"
            aria-label="Search applications"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        {view === 'list' && loaded && !closedFilter && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full text-muted-foreground"
            aria-pressed={showHidden}
            onClick={() => setShowHidden((current) => !current)}
          >
            {showHidden ? <EyeOffIcon data-icon="inline-start" aria-hidden /> : <EyeIcon data-icon="inline-start" aria-hidden />}
            Showing {activeRows.length} active · {hiddenCount} hidden (closed) — {showHidden ? 'Hide' : 'Show hidden'}
          </Button>
        )}
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          value={[view]}
          onValueChange={chooseView}
          aria-label="View"
          className="sm:ml-auto"
        >
          <ToggleGroupItem value="board" aria-label="Board view">
            <KanbanIcon data-icon="inline-start" aria-hidden />
            Board
          </ToggleGroupItem>
          <ToggleGroupItem value="list" aria-label="List view">
            <ListIcon data-icon="inline-start" aria-hidden />
            List
          </ToggleGroupItem>
        </ToggleGroup>
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

      {content()}

      <ApplicationSheet id={selected} statuses={statuses} terminal={terminal} onClose={close} onChanged={refresh} />
    </div>
  )
}
