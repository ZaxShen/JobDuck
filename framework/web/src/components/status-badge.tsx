import { Badge } from '@/components/ui/badge'
import { statusLabel } from '@/lib/format'
import { cn } from '@/lib/utils'

const TONES: Record<string, string> = {
  pending: 'border-amber-500/40 text-amber-700 dark:text-amber-400',
  applied: 'border-blue-500/40 text-blue-600 dark:text-blue-400',
  interviewing: 'border-violet-500/40 text-violet-600 dark:text-violet-400',
  offered: 'border-green-600/40 text-green-700 dark:text-green-400',
  accepted: 'border-green-600/40 text-green-700 dark:text-green-400',
  deny_by_employer: 'border-destructive/40 text-destructive',
  deny_by_candidate: 'border-destructive/40 text-destructive',
  no_response: 'border-destructive/40 text-destructive',
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant="outline" className={cn('capitalize', TONES[status])}>{statusLabel(status)}</Badge>
}
