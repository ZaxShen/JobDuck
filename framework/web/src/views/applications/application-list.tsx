import { useMemo, useState } from 'react'
import {
  type ColumnDef,
  type SortingState,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { RotateCcwIcon } from 'lucide-react'
import { Pager } from '@/components/pager'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableBody, TableHeader, TableRow } from '@/components/ui/table'
import { useColumnOrder } from '@/hooks/use-column-order'
import { appliedAtSortValue } from '@/lib/applied-sort'
import { pageSelection, togglePageSelection } from '@/lib/bulk'
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
  pageIndex: number
  onPageIndexChange: (pageIndex: number) => void
}

const LIST_PAGE_SIZE = 50

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation()

export function ApplicationList({
  rows, open, selectedIds, onSelectionChange, onOpen, pageIndex, onPageIndexChange,
}: ApplicationListProps) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'appliedAt', desc: true }])

  const columns = useMemo<ColumnDef<ApplicationRow>[]>(
    () => [
      {
        id: 'select',
        header: ({ table }) => {
          const pageIds = table.getRowModel().rows.map((row) => row.original.id)
          const state = pageSelection(pageIds, selectedIds)
          return (
            <Checkbox
              checked={state.checked}
              indeterminate={state.indeterminate}
              onCheckedChange={(checked) => onSelectionChange(togglePageSelection(selectedIds, pageIds, checked === true))}
              aria-label="Select all on this page"
            />
          )
        },
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
    [selectedIds, onSelectionChange],
  )

  const defaultColumnOrder = useMemo(() => columnDefIds(columns), [columns])
  const labels = useMemo(
    () => Object.fromEntries(columns.map((column) => [column.id ?? '', column.meta?.label ?? ''])),
    [columns],
  )
  const [columnOrder, setColumnOrder, resetColumnOrder] = useColumnOrder('applications', defaultColumnOrder, PINNED_COLUMNS)

  const lastPage = Math.max(Math.ceil(rows.length / LIST_PAGE_SIZE) - 1, 0)
  const currentPage = Math.min(pageIndex, lastPage)
  const pagination = { pageIndex: currentPage, pageSize: LIST_PAGE_SIZE }

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, columnOrder, pagination },
    onSortingChange: setSorting,
    onColumnOrderChange: setColumnOrder,
    onPaginationChange: (updater) =>
      onPageIndexChange((typeof updater === 'function' ? updater(pagination) : updater).pageIndex),
    autoResetPageIndex: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId: (row) => String(row.id),
  })

  const pageRows = table.getRowModel().rows
  const offset = currentPage * LIST_PAGE_SIZE

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
              {pageRows.map((row) => (
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
      <Pager
        offset={offset}
        count={pageRows.length}
        total={rows.length}
        pageSize={LIST_PAGE_SIZE}
        emptyLabel="No applications"
        onPage={(next) => onPageIndexChange(Math.floor(next / LIST_PAGE_SIZE))}
      />
    </div>
  )
}
