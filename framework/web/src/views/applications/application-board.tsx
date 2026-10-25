import { useId } from 'react'
import { ExternalLinkIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { type StageColumn, type StatusAction, daysSince, stageColumns, stageOf } from '@/lib/board'
import { safeUrl } from '@/lib/format'
import type { ApplicationRow } from '@/lib/types'
import { StatusActionsMenu } from '@/views/applications/status-actions-menu'

interface CardActions {
  busyId: number | null
  onOpen: (id: number) => void
  onAction: (row: ApplicationRow, action: StatusAction) => void
}

interface ApplicationBoardProps extends CardActions {
  rows: ApplicationRow[]
  terminal: string[]
}

export function ApplicationBoard({ rows, terminal, ...actions }: ApplicationBoardProps) {
  const columns = stageColumns(terminal)
  const grouped = new Map<string, ApplicationRow[]>(columns.map((column) => [column.key, []]))
  for (const row of rows) grouped.get(stageOf(row.status, terminal))?.push(row)

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {columns.map((column) => (
        <BoardColumn key={column.key} column={column} rows={grouped.get(column.key) ?? []} {...actions} />
      ))}
    </div>
  )
}

function BoardColumn({ column, rows, ...actions }: CardActions & { column: StageColumn; rows: ApplicationRow[] }) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex min-w-[250px] flex-1 flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <h2 id={headingId} className="text-sm font-medium">{column.label}</h2>
        <Badge variant="secondary" className="text-xs tabular-nums">
          {rows.length}
          <span className="sr-only"> applications</span>
        </Badge>
      </div>
      <div className="flex max-h-[calc(100vh-220px)] min-h-[120px] flex-col gap-2 overflow-y-auto rounded-lg bg-muted/20 p-2">
        {rows.length === 0
          ? <p className="py-4 text-center text-xs text-muted-foreground">No applications</p>
          : (
            <ul className="flex flex-col gap-2">
              {rows.map((row) => <li key={row.id}><ApplicationCard row={row} {...actions} /></li>)}
            </ul>
          )}
      </div>
    </section>
  )
}

function ApplicationCard({ row, busyId, onOpen, onAction }: CardActions & { row: ApplicationRow }) {
  const linkable = safeUrl(row.url)
  return (
    <article className="relative rounded-lg border border-border bg-card p-3 transition-colors duration-150 hover:bg-muted/40">
      <div className="min-w-0">
        <button
          type="button"
          className="block max-w-full truncate rounded-sm text-left text-sm leading-snug font-semibold outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={() => onOpen(row.id)}
        >
          {row.company}
        </button>
        <p className="mt-0.5 truncate text-xs text-muted-foreground" title={row.title}>{row.title}</p>
        {row.pending_reason && (
          <p className="mt-1 truncate text-xs text-amber-700 dark:text-amber-400" title={row.pending_reason}>
            {row.pending_reason}
          </p>
        )}
      </div>
      {(row.applied_at || linkable) && (
        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="truncate">{row.applied_at ? `Applied ${daysSince(row.applied_at)}d ago` : ''}</span>
          {linkable && (
            <a
              href={row.url}
              target="_blank"
              rel="noopener noreferrer"
              className="relative shrink-0 rounded-sm p-0.5 text-muted-foreground outline-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
              title="Open job posting"
              aria-label="Open job posting"
            >
              <ExternalLinkIcon className="size-3.5" aria-hidden />
            </a>
          )}
        </div>
      )}
      <StatusActionsMenu row={row} busy={busyId === row.id} onAction={onAction} className="relative mt-2 flex justify-end" />
    </article>
  )
}
