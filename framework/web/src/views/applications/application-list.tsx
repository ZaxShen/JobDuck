import { useMemo, useState } from 'react'
import {
  type ColumnDef,
  type SortingState,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { RotateCcwIcon } from 'lucide-react'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableBody, TableHeader, TableRow } from '@/components/ui/table'
import { useColumnOrder } from '@/hooks/use-column-order'
import { appliedAtSortValue } from '@/lib/applied-sort'
import { columnDefIds, moveColumn, sameOrder } from '@/lib/column-order'
import { day } from '@/lib/format'
import type { ApplicationRow } from '@/lib/types'
import { cn } from '@/lib/utils'
import { ColumnDndContext, DragAlongCell, SortableHeaderCell } from '@/views/applications/sortable-header-cell'

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    className?: string
    label?: string
  }
}

const PINNED_COLUMNS = { start: ['select'] }
const FIXED_COLUMNS = new Set(PINNED_COLUMNS.start)

interface ApplicationListProps {
  rows: ApplicationRow[]
  open: number | null
  selectedIds: ReadonlySet<number>
  onSelectionChange: (ids: Set<number>) => void
  onOpen: (id: number) => void
}

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation()

export function ApplicationList({ rows, open, selectedIds, onSelectionChange, onOpen }: ApplicationListProps) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'appliedAt', desc: true }])

  const selectedCount = rows.filter((row) => selectedIds.has(row.id)).length
  const allSelected = rows.length > 0 && selectedCount === rows.length

  const columns = useMemo<ColumnDef<ApplicationRow>[]>(
    () => [
      {
        id: 'select',
        header: () => (
          <Checkbox
            checked={allSelected}
            indeterminate={selectedCount > 0 && !allSelected}
            onCheckedChange={(checked) => onSelectionChange(checked ? new Set(rows.map((row) => row.id)) : new Set())}
            aria-label="Select all"
          />
        ),
        cell: ({ row }) => (
          <div onClick={stop} onMouseDown={stop} onKeyDown={stop}>
            <Checkbox
              checked={selectedIds.has(row.original.id)}
              onCheckedChange={(checked) => {
                const next = new Set(selectedIds)
                if (checked) next.add(row.original.id)
                else next.delete(row.original.id)
                onSelectionChange(next)
              }}
              aria-label={`Select ${row.original.company}`}
            />
          </div>
        ),
        enableSorting: false,
        meta: { className: 'w-10' },
      },
      {
        id: 'company',
        accessorKey: 'company',
        header: 'Company',
        cell: ({ row }) => (
          <span className="block max-w-40 truncate text-sm font-medium">{row.original.company}</span>
        ),
        enableSorting: true,
        meta: { label: 'Company' },
      },
      {
        id: 'title',
        accessorKey: 'title',
        header: 'Title',
        cell: ({ row }) => (
          <div className="max-w-56">
            <span className="block truncate text-sm text-muted-foreground">{row.original.title}</span>
            {row.original.pending_reason && (
              <span className="block truncate text-xs text-amber-700 dark:text-amber-400" title={row.original.pending_reason}>
                {row.original.pending_reason}
              </span>
            )}
          </div>
        ),
        enableSorting: true,
        meta: { label: 'Title' },
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
        enableSorting: true,
        meta: { label: 'Status' },
      },
      {
        id: 'location',
        accessorKey: 'location',
        header: 'Location',
        cell: ({ row }) => (
          <span className="block max-w-48 truncate text-sm text-muted-foreground">{row.original.location ?? '—'}</span>
        ),
        enableSorting: false,
        meta: { className: 'hidden md:table-cell', label: 'Location' },
      },
      {
        id: 'appliedAt',
        accessorFn: (row) => appliedAtSortValue(row.applied_at),
        header: 'Applied',
        cell: ({ row }) => <span className="text-sm text-muted-foreground">{day(row.original.applied_at) || '—'}</span>,
        enableSorting: true,
        sortUndefined: 'last',
        meta: { className: 'hidden sm:table-cell', label: 'Applied' },
      },
      {
        id: 'updatedAt',
        accessorFn: (row) => appliedAtSortValue(row.updated_at),
        header: 'Updated',
        cell: ({ row }) => <span className="text-sm text-muted-foreground">{day(row.original.updated_at)}</span>,
        enableSorting: true,
        sortUndefined: 'last',
        meta: { className: 'hidden lg:table-cell', label: 'Updated' },
      },
    ],
    [rows, selectedIds, selectedCount, allSelected, onSelectionChange],
  )

  const defaultColumnOrder = useMemo(() => columnDefIds(columns), [columns])
  const labels = useMemo(
    () => Object.fromEntries(columns.map((column) => [column.id ?? '', column.meta?.label ?? ''])),
    [columns],
  )
  const [columnOrder, setColumnOrder, resetColumnOrder] = useColumnOrder('applications', defaultColumnOrder, PINNED_COLUMNS)

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, columnOrder },
    onSortingChange: setSorting,
    onColumnOrderChange: setColumnOrder,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => String(row.id),
  })

  const sortableColumnIds = table
    .getVisibleLeafColumns()
    .map((column) => column.id)
    .filter((id) => !FIXED_COLUMNS.has(id))

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          disabled={sameOrder(columnOrder, defaultColumnOrder)}
          onClick={resetColumnOrder}
          title="Restore the default column order"
        >
          <RotateCcwIcon data-icon="inline-start" aria-hidden />
          Reset columns
        </Button>
      </div>
      <ColumnDndContext
        items={sortableColumnIds}
        labels={labels}
        onMove={(activeId, overId) => setColumnOrder((order) => moveColumn(order, activeId, overId, PINNED_COLUMNS))}
      >
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id} className="hover:bg-transparent">
                  {headerGroup.headers.map((header) => (
                    <SortableHeaderCell key={header.id} header={header} draggable={!FIXED_COLUMNS.has(header.column.id)} />
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.original.id === open ? 'selected' : undefined}
                  className={cn('cursor-pointer transition-colors', selectedIds.has(row.original.id) && 'bg-accent/60')}
                  tabIndex={0}
                  onClick={() => onOpen(row.original.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && event.target === event.currentTarget) onOpen(row.original.id)
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <DragAlongCell key={cell.id} cell={cell} draggable={!FIXED_COLUMNS.has(cell.column.id)} />
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </ColumnDndContext>
    </div>
  )
}
