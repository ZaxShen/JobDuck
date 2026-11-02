import { AlertCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      <AlertCircleIcon className="size-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 break-words">Failed to load: {message}</p>
      <Button type="button" variant="ghost" size="sm" onClick={onRetry}>Retry</Button>
    </div>
  )
}

export function LoadSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-8 w-64 max-w-full" />
      <Skeleton className="h-[400px] w-full" />
    </div>
  )
}
