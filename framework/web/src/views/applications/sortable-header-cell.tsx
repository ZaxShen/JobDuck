import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToHorizontalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { flexRender, type Cell, type Header } from '@tanstack/react-table'
import { ChevronDownIcon, ChevronUpIcon, ChevronsUpDownIcon, GripVerticalIcon } from 'lucide-react'
import { TableCell, TableHead } from '@/components/ui/table'
import { cn } from '@/lib/utils'

const KEYBOARD_CODES = { start: ['Space'], cancel: ['Escape'], end: ['Space'] }

const INSTRUCTIONS = {
  draggable:
    'Press Enter to sort by this column. To move the column, press Space, use the left and right arrow keys, then press Space again to drop it or Escape to cancel.',
}

interface ColumnDndContextProps {
  items: string[]
  labels: Record<string, string>
  onMove: (activeId: string, overId: string) => void
  children: ReactNode
}

export function ColumnDndContext({ items, labels, onMove, children }: ColumnDndContextProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: KEYBOARD_CODES }),
  )

  const name = (id: string | number | undefined) => (id === undefined ? '' : labels[String(id)] ?? String(id))

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) onMove(String(active.id), String(over.id))
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToHorizontalAxis]}
      onDragEnd={handleDragEnd}
      accessibility={{
        screenReaderInstructions: INSTRUCTIONS,
        announcements: {
          onDragStart: ({ active }) => `Picked up the ${name(active.id)} column.`,
          onDragOver: ({ active, over }) => (over ? `${name(active.id)} column is over ${name(over.id)}.` : undefined),
          onDragEnd: ({ active, over }) => (over ? `${name(active.id)} column moved to ${name(over.id)}.` : `${name(active.id)} column dropped.`),
          onDragCancel: ({ active }) => `Moving the ${name(active.id)} column was cancelled.`,
        },
      }}
    >
      <SortableContext items={items} strategy={horizontalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  )
}

function dragStyle(
  transform: Parameters<typeof CSS.Translate.toString>[0],
  transition: string | undefined,
  isDragging: boolean,
): CSSProperties {
  return {
    transform: CSS.Translate.toString(transform),
    transition,
    position: 'relative',
    zIndex: isDragging ? 20 : undefined,
    opacity: isDragging ? 0.8 : undefined,
  }
}

type AriaSort = 'ascending' | 'descending' | 'none'

function ariaSort<TData>(header: Header<TData, unknown>): AriaSort | undefined {
  if (!header.column.getCanSort()) return undefined
  const sorted = header.column.getIsSorted()
  return sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'
}

function HeaderContent<TData>({ header, grip }: { header: Header<TData, unknown>; grip?: ReactNode }) {
  const sorted = header.column.getIsSorted()
  return (
    <span className="inline-flex items-center gap-1">
      {grip}
      {flexRender(header.column.columnDef.header, header.getContext())}
      {header.column.getCanSort() &&
        (sorted === 'asc' ? (
          <ChevronUpIcon className="size-3" aria-hidden />
        ) : sorted === 'desc' ? (
          <ChevronDownIcon className="size-3" aria-hidden />
        ) : (
          <ChevronsUpDownIcon className="size-3 text-muted-foreground/50" aria-hidden />
        ))}
    </span>
  )
}

function sortProps<TData>(header: Header<TData, unknown>) {
  if (!header.column.getCanSort()) return { onClick: undefined, onSortKey: undefined, cursor: undefined }
  const toggle = header.column.getToggleSortingHandler()
  return {
    onClick: toggle,
    onSortKey: (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.target !== event.currentTarget) return
      event.preventDefault()
      toggle?.(event)
    },
    cursor: 'pointer' as const,
  }
}

function DraggableHeaderCell<TData>({ header }: { header: Header<TData, unknown> }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: header.column.id,
  })
  const { onClick, onSortKey, cursor } = sortProps(header)

  return (
    <TableHead
      ref={setNodeRef}
      className={cn(
        'group outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
        header.column.columnDef.meta?.className,
        isDragging && 'bg-muted',
      )}
      style={{ ...dragStyle(transform, transition, isDragging), cursor: isDragging ? 'grabbing' : cursor }}
      onClick={onClick}
      {...attributes}
      {...listeners}
      onKeyDown={(event) => {
        listeners?.onKeyDown?.(event)
        if (!isDragging) onSortKey?.(event)
      }}
      role="columnheader"
      aria-roledescription="draggable column"
      aria-pressed={undefined}
      aria-sort={ariaSort(header)}
    >
      <HeaderContent
        header={header}
        grip={
          <GripVerticalIcon
            aria-hidden
            className="-ml-1 size-3 shrink-0 cursor-grab text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          />
        }
      />
    </TableHead>
  )
}

export function SortableHeaderCell<TData>({
  header,
  draggable,
}: {
  header: Header<TData, unknown>
  draggable: boolean
}) {
  if (draggable) return <DraggableHeaderCell header={header} />
  const { onClick, onSortKey, cursor } = sortProps(header)
  return (
    <TableHead
      className={header.column.columnDef.meta?.className}
      onClick={onClick}
      onKeyDown={onSortKey}
      tabIndex={onClick ? 0 : undefined}
      aria-sort={ariaSort(header)}
      style={cursor ? { cursor } : undefined}
    >
      <HeaderContent header={header} />
    </TableHead>
  )
}

function DraggingCell<TData>({ cell }: { cell: Cell<TData, unknown> }) {
  const { setNodeRef, transform, transition, isDragging } = useSortable({ id: cell.column.id })
  return (
    <TableCell
      ref={setNodeRef}
      className={cn(cell.column.columnDef.meta?.className, isDragging && 'bg-muted/60')}
      style={dragStyle(transform, transition, isDragging)}
    >
      {flexRender(cell.column.columnDef.cell, cell.getContext())}
    </TableCell>
  )
}

export function DragAlongCell<TData>({ cell, draggable }: { cell: Cell<TData, unknown>; draggable: boolean }) {
  if (draggable) return <DraggingCell cell={cell} />
  return (
    <TableCell className={cell.column.columnDef.meta?.className}>
      {flexRender(cell.column.columnDef.cell, cell.getContext())}
    </TableCell>
  )
}
