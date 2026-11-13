import { useCallback, useEffect, useState } from 'react'
import { SearchIcon } from 'lucide-react'
import { LoadError, LoadSkeleton } from '@/components/load-states'
import { StatusBadge } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useVisiblePoll } from '@/hooks/use-visible-poll'
import { errorMessage, fetchJSON } from '@/lib/api'
import { safeUrl } from '@/lib/format'
import {
  ALL_JOBS, JOBS_PAGE_SIZE, NOT_APPLIED_LABEL, appliedText, jobFilterOptions, pageRangeText, postedText, postingsPath,
} from '@/lib/jobs'
import type { PostingRow } from '@/lib/types'

interface JobsViewProps {
  active: boolean
  statuses: string[]
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
      <SearchIcon className="size-10 text-muted-foreground/40" aria-hidden />
      <h2 className="text-base font-medium">{filtered ? 'No Matching Jobs' : 'No Jobs Yet'}</h2>
      <p className="max-w-xs text-sm text-muted-foreground">
        {filtered ? 'No fetched job has this status.' : 'Ask your agent to find jobs, and they show up here.'}
      </p>
    </div>
  )
}

function JobTitle({ row }: { row: PostingRow }) {
  if (!safeUrl(row.url)) return <span className="font-medium">{row.title}</span>
  return (
    <a href={row.url} target="_blank" rel="noopener noreferrer" className="font-medium hover:text-primary hover:underline">
      {row.title}
    </a>
  )
}

function JobsTable({ rows }: { rows: PostingRow[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Job</TableHead>
            <TableHead>Company</TableHead>
            <TableHead>Location</TableHead>
            <TableHead>Posted</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Applied</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="max-w-80 truncate"><JobTitle row={row} /></TableCell>
              <TableCell>{row.company}</TableCell>
              <TableCell className="text-muted-foreground">{row.location ?? '—'}</TableCell>
              <TableCell className="text-muted-foreground">{postedText(row)}</TableCell>
              <TableCell>
                {row.application_status === null
                  ? <Badge variant="outline" className="text-muted-foreground">{NOT_APPLIED_LABEL}</Badge>
                  : <StatusBadge status={row.application_status} />}
              </TableCell>
              <TableCell className="text-muted-foreground">{appliedText(row)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

interface PostingsPage {
  postings: PostingRow[]
  total: number
  limit: number
  offset: number
}

function Pager({ offset, count, total, onPage }: {
  offset: number
  count: number
  total: number
  onPage: (offset: number) => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground" aria-live="polite">{pageRangeText(offset, count, total)}</p>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={offset === 0}
          onClick={() => onPage(Math.max(offset - JOBS_PAGE_SIZE, 0))}>
          Previous
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={offset + count >= total}
          onClick={() => onPage(offset + JOBS_PAGE_SIZE)}>
          Next
        </Button>
      </div>
    </div>
  )
}

export function JobsView({ active, statuses }: JobsViewProps) {
  const [filter, setFilter] = useState(ALL_JOBS)
  const [offset, setOffset] = useState(0)
  const [rows, setRows] = useState<PostingRow[]>([])
  const [total, setTotal] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const page = await fetchJSON<PostingsPage>(postingsPath(filter, offset, JOBS_PAGE_SIZE))
      if (page.postings.length === 0 && page.total > 0 && offset > 0) {
        setOffset(Math.floor((page.total - 1) / JOBS_PAGE_SIZE) * JOBS_PAGE_SIZE)
        return
      }
      setRows(page.postings)
      setTotal(page.total)
      setLoaded(true)
      setError(null)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }, [filter, offset])

  const changeFilter = (value: string) => {
    setFilter(value)
    setOffset(0)
  }

  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh])

  useVisiblePoll(refresh, active)

  const items = jobFilterOptions(statuses)

  const content = () => {
    if (!loaded) return error ? null : <LoadSkeleton />
    if (rows.length === 0) return <EmptyState filtered={filter !== ALL_JOBS} />
    return (
      <>
        <JobsTable rows={rows} />
        <Pager offset={offset} count={rows.length} total={total} onPage={setOffset} />
      </>
    )
  }

  return (
    <div className="flex flex-col gap-6 animate-in fade-in duration-500">
      <p className="text-sm text-muted-foreground">Every job your agent fetched or saved, and whether you applied, newest first.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Select items={items} value={filter} onValueChange={(value: string | null) => changeFilter(value ?? ALL_JOBS)}>
          <SelectTrigger aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value || 'all'} value={item.value}>{item.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {error && <LoadError message={error} onRetry={() => void refresh()} />}
      {content()}
    </div>
  )
}
