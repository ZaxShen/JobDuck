import { type ReactNode, useCallback, useEffect, useState } from 'react'
import {
  AlertCircleIcon, ClipboardListIcon, EyeIcon, EyeOffIcon, KanbanIcon, ListIcon, SearchIcon, XCircleIcon,
} from 'lucide-react'
import { SectionCard } from '@/components/composed/section-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useFlash } from '@/hooks/use-flash'
import { useVisiblePoll } from '@/hooks/use-visible-poll'
import { applicationsPath, deleteJSON, errorMessage, fetchJSON, isConflict } from '@/lib/api'
import { MOVE_REFUSED, type StageMove, type StatusAction, stageColumns } from '@/lib/board'
import { bulkSummary } from '@/lib/bulk'
import { statusLabel } from '@/lib/format'
import { BULK_TARGETS, type DialogScope, type StatusEntry, statusRequest } from '@/lib/status-entries'
import type { ApplicationRow, Outcome, StageTypes, Summary } from '@/lib/types'
import { ApplicationBoard } from '@/views/applications/application-board'
import { ApplicationList } from '@/views/applications/application-list'
import { ApplicationSheet } from '@/views/applications/application-sheet'
import { OutcomeItem } from '@/views/applications/outcome-item'
import { SelectionToolbar } from '@/views/applications/selection-toolbar'
import { StatusDialog, type StatusDialogRequest, sendStatus } from '@/views/applications/status-dialog'

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
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <ClipboardListIcon className="size-10 text-muted-foreground/40" aria-hidden />
      <p className="max-w-xs text-sm text-muted-foreground">{children}</p>
    </div>
  )
}

function BoardSkeleton() {
  return (
    <div className="flex gap-4 overflow-hidden" aria-hidden>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex min-w-64 flex-1 flex-col gap-2">
          <Skeleton className="h-5 w-24" />
          <div className="flex flex-col gap-2 p-2">
            {Array.from({ length: 3 }).map((_, j) => (
              <Skeleton key={j} className="h-20 w-full rounded-lg" />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-border" aria-hidden>
      <div className="divide-y divide-border">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="px-4 py-3">
            <Skeleton className="h-5 w-full" />
          </div>
        ))}
      </div>
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
  const [failed, setFailed] = useState(false)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [types, setTypes] = useState<StageTypes | null>(null)
  const [dialog, setDialog] = useState<{ request: StatusDialogRequest; rows: ApplicationRow[] } | null>(null)

  useEffect(() => {
    fetchJSON<StageTypes>('/api/stage-types').then(setTypes).catch((error: unknown) => flash(errorMessage(error), true))
  }, [flash])

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
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [filter, q])

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

  const runAction = (row: ApplicationRow, action: StatusAction) =>
    setDialog({ request: { target: action.target, title: action.label, subject: row.company }, rows: [row] })

  const moveCard = (row: ApplicationRow, move: StageMove) => {
    if (!move.allowed) {
      flash(MOVE_REFUSED, true)
      return
    }
    const column = stageColumns(terminal).find((candidate) => candidate.key === move.to)?.label ?? statusLabel(move.target)
    setDialog({ request: { target: move.target, title: `Move to ${column}`, subject: row.company }, rows: [row] })
  }

  const submitOne = async (row: ApplicationRow, title: string, scope: DialogScope, entry: StatusEntry) => {
    setBusyId(row.id)
    try {
      await sendStatus(statusRequest(row.id, scope, entry, row.updated_at))
    } catch (error) {
      if (isConflict(error)) await refresh()
      throw error
    } finally {
      setBusyId(null)
    }
    flash(`${title}: ${row.company}`)
    setDialog(null)
    await refresh()
  }

  const resetFilters = () => {
    setFilter('')
    setSearch('')
    setQ('')
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
  const selectedRows = view === 'list' ? listRows.filter((row) => selectedIds.has(row.id)) : []
  const filtersActive = filter !== '' || search.trim() !== ''
  const runBulk = async (verb: string, targets: ApplicationRow[], request: (row: ApplicationRow) => Promise<unknown>) => {
    setBulkBusy(true)
    const results = await Promise.allSettled(targets.map(request))
    setBulkBusy(false)
    const summary = bulkSummary(verb, results)
    const failed = summary.failed.map((index) => targets[index]!)
    setSelectedIds(new Set(failed.map((row) => row.id)))
    flash(summary.text, summary.isError)
    await refresh()
    return { summary, failed }
  }

  const bulkSetStatus = (status: string) => setDialog({
    request: { target: status, title: 'Set status', subject: 'One date and note for every selected application', bulk: true },
    rows: selectedRows,
  })

  const submitStatus = async (scope: DialogScope, entry: StatusEntry) => {
    if (!dialog) return
    const targets = dialog.rows.map((row) => rows.find((item) => item.id === row.id) ?? row)
    if (!dialog.request.bulk) return submitOne(targets[0]!, dialog.request.title, scope, entry)
    const { summary, failed } = await runBulk('Updated', targets,
      (row) => sendStatus(statusRequest(row.id, scope, entry, row.updated_at)))
    if (!summary.isError) {
      setDialog(null)
      return
    }
    setDialog({ ...dialog, rows: failed })
    throw new Error(summary.text)
  }

  const bulkDelete = () =>
    void runBulk('Deleted', selectedRows, (row) => deleteJSON(`/api/applications/${row.id}`, { expected_updated_at: row.updated_at }))

  const content = () => {
    if (!loaded) {
      if (failed) return null
      return view === 'board' ? <BoardSkeleton /> : <ListSkeleton />
    }
    if (rows.length === 0) {
      return (
        <EmptyState>
          {filter || q ? 'No applications match the current filters.' : 'No applications yet. Ask your agent to save or apply to a posting.'}
        </EmptyState>
      )
    }
    if (view === 'board') {
      return (
        <ApplicationBoard
          rows={rows}
          terminal={terminal}
          busyId={busyId}
          onOpen={setSelected}
          onAction={runAction}
          onMove={moveCard}
        />
      )
    }
    if (listRows.length === 0) return <EmptyState>No active applications. Click Show hidden to see closed ones.</EmptyState>
    return (
      <ApplicationList
        rows={listRows}
        open={selected}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        onOpen={setSelected}
      />
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
        {filtersActive && (
          <Button type="button" variant="outline" onClick={resetFilters}>
            Reset
            <XCircleIcon data-icon="inline-end" aria-hidden />
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

      {failed && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircleIcon className="size-4 shrink-0" aria-hidden />
          <span>Failed to load applications.</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto text-destructive hover:text-destructive"
            onClick={() => void refresh()}
          >
            Retry
          </Button>
        </div>
      )}

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

      <SelectionToolbar
        selectedCount={selectedRows.length}
        statuses={BULK_TARGETS}
        busy={bulkBusy}
        onSetStatus={bulkSetStatus}
        onDelete={bulkDelete}
        onClearSelection={() => setSelectedIds(new Set())}
      />

      <StatusDialog request={dialog?.request ?? null} types={types} onClose={() => setDialog(null)} onSubmit={submitStatus} />

      <ApplicationSheet id={selected} terminal={terminal} onClose={close} onChanged={refresh} />
    </div>
  )
}
