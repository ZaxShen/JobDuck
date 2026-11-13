import { Button } from '@/components/ui/button'
import { pageRangeText } from '@/lib/jobs'

interface PagerProps {
  offset: number
  count: number
  total: number
  pageSize: number
  emptyLabel?: string
  onPage: (offset: number) => void
}

export function Pager({ offset, count, total, pageSize, emptyLabel, onPage }: PagerProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground" aria-live="polite">{pageRangeText(offset, count, total, emptyLabel)}</p>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={offset === 0}
          onClick={() => onPage(Math.max(offset - pageSize, 0))}>
          Previous
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={offset + count >= total}
          onClick={() => onPage(offset + pageSize)}>
          Next
        </Button>
      </div>
    </div>
  )
}
