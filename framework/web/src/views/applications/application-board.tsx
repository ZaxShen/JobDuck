import { type ReactNode, useId, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  type Active,
  type DragEndEvent,
  type DragStartEvent,
  type Over,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronRightIcon, ExternalLinkIcon, GripVerticalIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  type StageColumn,
  type StageKey,
  type StageMove,
  type StatusAction,
  daysSince,
  isStageKey,
  stageColumns,
  stageMove,
  stageOf,
} from '@/lib/board'
import {
  CARD_CAP,
  type Density,
  type PreInterviewGroup,
  type PreInterviewStatus,
  preInterviewGroups,
  readCollapsed,
  saveCollapsed,
  visibleCards,
} from '@/lib/board-density'
import { day, safeUrl } from '@/lib/format'
import type { ApplicationRow } from '@/lib/types'
import { cn } from '@/lib/utils'
import { StatusActionsMenu } from '@/views/applications/status-actions-menu'

interface CardActions {
  busyId: number | null
  onOpen: (id: number) => void
  onAction: (row: ApplicationRow, action: StatusAction) => void
}

interface ApplicationBoardProps extends CardActions {
  rows: ApplicationRow[]
  terminal: string[]
  density: Density
  onMove: (row: ApplicationRow, move: StageMove) => void
}

const KEYBOARD_CODES = { start: ['Space'], cancel: ['Escape'], end: ['Space'] }

const INSTRUCTIONS = {
  draggable:
    'To move an application, press Space on its handle, use the arrow keys to reach another column, then press Space again to drop it or Escape to cancel.',
}

export function ApplicationBoard({ rows, terminal, density, onMove, ...actions }: ApplicationBoardProps) {
  const [activeId, setActiveId] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState<PreInterviewStatus[]>(readCollapsed)
  const [shown, setShown] = useState<Record<string, number>>({})

  const toggleGroup = (status: PreInterviewStatus) => {
    const next = collapsed.includes(status) ? collapsed.filter((item) => item !== status) : [...collapsed, status]
    setCollapsed(next)
    saveCollapsed(next)
  }
  const showMore = (key: string, next: number) => setShown((current) => ({ ...current, [key]: next }))

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: KEYBOARD_CODES }),
  )

  const columns = stageColumns(terminal)
  const labels = Object.fromEntries(columns.map((column) => [column.key, column.label])) as Record<StageKey, string>
  const grouped = new Map<StageKey, ApplicationRow[]>(columns.map((column) => [column.key, []]))
  for (const row of rows) grouped.get(stageOf(row.status, terminal))?.push(row)

  const rowOf = (id: Active['id'] | undefined) => rows.find((row) => row.id === id)
  const columnOf = (over: Over | null): StageKey | null => {
    if (!over) return null
    if (isStageKey(over.id)) return over.id
    const groupColumn = over.data.current?.column
    if (isStageKey(groupColumn)) return groupColumn
    const container = over.data.current?.sortable?.containerId
    if (isStageKey(container)) return container
    const row = rowOf(over.id)
    return row ? stageOf(row.status, terminal) : null
  }
  const company = (active: Active) => rowOf(active.id)?.company ?? 'Application'
  const columnLabel = (over: Over | null) => {
    const key = columnOf(over)
    return key ? labels[key] : 'no column'
  }

  const activeRow = activeId === null ? null : rowOf(activeId) ?? null

  const handleDragStart = (event: DragStartEvent) => setActiveId(Number(event.active.id))

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null)
    const row = rowOf(active.id)
    const to = columnOf(over)
    if (!row || !to) return
    const move = stageMove(row.status, to, terminal)
    if (move) onMove(row, move)
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
      accessibility={{
        screenReaderInstructions: INSTRUCTIONS,
        announcements: {
          onDragStart: ({ active }) => `Picked up ${company(active)}.`,
          onDragOver: ({ active, over }) => `${company(active)} is over ${columnLabel(over)}.`,
          onDragEnd: ({ active, over }) => `${company(active)} was dropped in ${columnLabel(over)}.`,
          onDragCancel: ({ active }) => `Moving ${company(active)} was cancelled.`,
        },
      }}
    >
      <div className="relative flex gap-4 overflow-x-auto pb-4">
        {columns.map((column) => (
          <BoardColumn
            key={column.key}
            column={column}
            rows={grouped.get(column.key) ?? []}
            density={density}
            collapsed={collapsed}
            shown={shown}
            onToggleGroup={toggleGroup}
            onShowMore={showMore}
            {...actions}
          />
        ))}
      </div>
      <DragOverlay>
        {activeRow
          ? density === 'compact' ? <CompactCardBody row={activeRow} dragging /> : <CardBody row={activeRow} dragging />
          : null}
      </DragOverlay>
    </DndContext>
  )
}

interface ColumnProps extends CardActions {
  column: StageColumn
  rows: ApplicationRow[]
  density: Density
  collapsed: readonly PreInterviewStatus[]
  shown: Record<string, number>
  onToggleGroup: (status: PreInterviewStatus) => void
  onShowMore: (key: string, next: number) => void
}

function BoardColumn({ column, rows, density, collapsed, shown, onToggleGroup, onShowMore, ...actions }: ColumnProps) {
  const headingId = useId()
  const { setNodeRef, isOver } = useDroppable({ id: column.key })
  const cards = { density, shown, onShowMore, ...actions }
  return (
    <section aria-labelledby={headingId} className="flex min-w-[250px] flex-1 flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <h2 id={headingId} className="text-sm font-medium">{column.label}</h2>
        <Badge variant="secondary" className="text-xs tabular-nums">
          {rows.length}
          <span className="sr-only"> applications</span>
        </Badge>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex max-h-[calc(100vh-220px)] min-h-[120px] flex-col gap-2 overflow-y-auto rounded-lg p-2 transition-colors duration-150',
          isOver ? 'bg-muted/60' : 'bg-muted/20',
        )}
      >
        {column.key === 'pre_interview'
          ? preInterviewGroups(rows).map((group) => (
            <BoardGroup
              key={group.status}
              column={column.key}
              group={group}
              open={!collapsed.includes(group.status)}
              onToggle={() => onToggleGroup(group.status)}
              {...cards}
            />
          ))
          : <CardStack containerId={column.key} shownKey={column.key} rows={rows} {...cards} />}
      </div>
    </section>
  )
}

interface CardStackProps extends CardActions {
  containerId: string
  shownKey: string
  rows: ApplicationRow[]
  density: Density
  shown: Record<string, number>
  onShowMore: (key: string, next: number) => void
}

function CardStack({ containerId, shownKey, rows, density, shown, onShowMore, ...actions }: CardStackProps) {
  const { visible, more } = visibleCards(rows, shown[shownKey] ?? CARD_CAP)
  return (
    <SortableContext id={containerId} items={visible.map((row) => row.id)} strategy={verticalListSortingStrategy}>
      {rows.length === 0
        ? <p className="py-4 text-center text-xs text-muted-foreground">No applications</p>
        : (
          <ul className={cn('flex flex-col', density === 'compact' ? 'gap-1' : 'gap-2')}>
            {visible.map((row) => <li key={row.id}><SortableCard row={row} density={density} {...actions} /></li>)}
          </ul>
        )}
      {more > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => onShowMore(shownKey, visible.length + more)}
        >
          Show {more} more
        </Button>
      )}
    </SortableContext>
  )
}

interface BoardGroupProps extends Omit<CardStackProps, 'containerId' | 'shownKey' | 'rows'> {
  column: StageKey
  group: PreInterviewGroup<ApplicationRow>
  open: boolean
  onToggle: () => void
}

function BoardGroup({ column, group, open, onToggle, ...cards }: BoardGroupProps) {
  const contentId = useId()
  const { setNodeRef, isOver } = useDroppable({ id: `group-${group.status}`, data: { column } })
  return (
    <section ref={setNodeRef} aria-label={`${group.label}, ${group.count} applications`} className={cn('flex flex-col gap-1 rounded-md', isOver && 'bg-muted/60')}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={onToggle}
        className="flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronRightIcon className={cn('size-3.5 transition-transform duration-150', open && 'rotate-90')} aria-hidden />
        {group.label}
        <span className="tabular-nums">· {group.count}</span>
      </button>
      {open && (
        <div id={contentId} className="flex flex-col gap-2">
          <CardStack containerId={`group-${group.status}-cards`} shownKey={`${column}:${group.status}`} rows={group.rows} {...cards} />
        </div>
      )}
    </section>
  )
}

function SortableCard({ row, density, busyId, onOpen, onAction }: CardActions & { row: ApplicationRow; density: Density }) {
  const busy = busyId === row.id
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: row.id, disabled: busy })

  const handle = (
    <button
      ref={setActivatorNodeRef}
      type="button"
      {...attributes}
      onKeyDown={(event) => listeners?.onKeyDown?.(event)}
      aria-pressed={undefined}
      aria-label={`Move ${row.company}`}
      disabled={busy}
      className={cn(
        'relative -mr-1 shrink-0 cursor-grab rounded-sm p-0.5 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
        density === 'comfortable' && '-mt-0.5',
      )}
    >
      <GripVerticalIcon className="size-4" aria-hidden />
    </button>
  )
  const heading = (
    <button
      type="button"
      className="block max-w-full truncate rounded-sm text-left text-sm leading-snug font-semibold outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:ring-3 focus-visible:ring-ring/50"
      onClick={() => onOpen(row.id)}
    >
      {row.company}
    </button>
  )

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      onPointerDown={(event) => listeners?.onPointerDown?.(event)}
      aria-busy={busy || undefined}
    >
      {density === 'compact'
        ? <CompactCardBody row={row} handle={handle} heading={heading} />
        : (
          <CardBody
            row={row}
            handle={handle}
            heading={heading}
            actions={<StatusActionsMenu row={row} busy={busy} onAction={onAction} className="relative mt-2 flex justify-end" />}
          />
        )}
    </div>
  )
}

function CompactCardBody({ row, dragging = false, handle, heading }: Omit<CardBodyProps, 'actions'>) {
  const applied = day(row.applied_at)
  return (
    <article
      className={cn(
        'relative flex cursor-grab items-center gap-2 rounded-md border border-border bg-card px-2 py-1 select-none',
        'transition-all duration-150',
        dragging ? 'cursor-grabbing opacity-80 shadow-lg' : 'hover:bg-card/80 hover:shadow-sm',
      )}
    >
      <div className="max-w-[45%] shrink-0">
        {heading ?? <p className="truncate text-sm leading-snug font-semibold">{row.company}</p>}
      </div>
      <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={row.title}>{row.title}</p>
      {applied && <span className="shrink-0 text-xs text-muted-foreground/70 tabular-nums">{applied}</span>}
      {handle}
    </article>
  )
}

interface CardBodyProps {
  row: ApplicationRow
  dragging?: boolean
  handle?: ReactNode
  heading?: ReactNode
  actions?: ReactNode
}

function CardBody({ row, dragging = false, handle, heading, actions }: CardBodyProps) {
  const linkable = safeUrl(row.url)
  return (
    <article
      className={cn(
        'relative cursor-grab rounded-lg border border-border bg-card p-3 select-none',
        'transition-all duration-150',
        dragging ? 'cursor-grabbing opacity-80 shadow-lg' : 'hover:bg-card/80 hover:shadow-sm',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {heading ?? <p className="truncate text-sm leading-snug font-semibold">{row.company}</p>}
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={row.title}>{row.title}</p>
          {row.pending_reason && (
            <p className="mt-1 truncate text-xs text-amber-700 dark:text-amber-400" title={row.pending_reason}>
              {row.pending_reason}
            </p>
          )}
        </div>
        {handle}
      </div>
      {(row.applied_at || linkable) && (
        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="truncate text-muted-foreground/70">{row.applied_at ? `Applied ${daysSince(row.applied_at)}d ago` : ''}</span>
          {linkable && !dragging && (
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
      {actions}
    </article>
  )
}
