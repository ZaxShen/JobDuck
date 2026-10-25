import { ChevronDownIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { type StatusAction, statusActions } from '@/lib/board'
import type { ApplicationRow } from '@/lib/types'

interface StatusActionsMenuProps {
  row: ApplicationRow
  busy: boolean
  onAction: (row: ApplicationRow, action: StatusAction) => void
  className?: string
}

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation()

export function StatusActionsMenu({ row, busy, onAction, className }: StatusActionsMenuProps) {
  const { advance, close } = statusActions(row.status)
  if (advance.length === 0 && close.length === 0) return null

  const item = (action: StatusAction, variant: 'default' | 'destructive') => (
    <DropdownMenuItem
      key={action.target}
      disabled={busy}
      variant={variant}
      className="flex-col items-start gap-0.5"
      onClick={() => onAction(row, action)}
    >
      <span className="font-medium">{action.label}</span>
      <span className="text-xs whitespace-normal text-muted-foreground">{action.hint}</span>
    </DropdownMenuItem>
  )

  return (
    <div className={className} onClick={stop} onPointerDown={stop} onKeyDown={stop}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="xs" className="text-muted-foreground" />}
          aria-label={`Status actions for ${row.company}`}
        >
          Status actions
          <ChevronDownIcon data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {advance.length > 0 && (
            <DropdownMenuGroup>
              <DropdownMenuLabel>Next step</DropdownMenuLabel>
              {advance.map((action) => item(action, 'default'))}
            </DropdownMenuGroup>
          )}
          {advance.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuGroup>
            <DropdownMenuLabel>Close</DropdownMenuLabel>
            {close.map((action) => item(action, 'destructive'))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
