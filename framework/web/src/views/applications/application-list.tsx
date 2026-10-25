import { StatusBadge } from '@/components/status-badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { day } from '@/lib/format'
import type { ApplicationRow } from '@/lib/types'

interface ApplicationListProps {
  rows: ApplicationRow[]
  selected: number | null
  onOpen: (id: number) => void
}

export function ApplicationList({ rows, selected, onOpen }: ApplicationListProps) {
  return (
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
            onClick={() => onOpen(row.id)}
            onKeyDown={(event) => { if (event.key === 'Enter') onOpen(row.id) }}
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
  )
}
