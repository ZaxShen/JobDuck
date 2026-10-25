import { useState } from 'react'
import { Trash2Icon, XIcon } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { statusLabel } from '@/lib/format'
import { cn } from '@/lib/utils'

interface SelectionToolbarProps {
  selectedCount: number
  statuses: readonly string[]
  busy: boolean
  onSetStatus: (status: string) => void
  onDelete: () => void
  onClearSelection: () => void
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

export function SelectionToolbar({ selectedCount, statuses, busy, onSetStatus, onDelete, onClearSelection }: SelectionToolbarProps) {
  const [confirming, setConfirming] = useState(false)
  if (selectedCount === 0) return null

  const noun = selectedCount === 1 ? 'application' : 'applications'
  const items = statuses.map((status) => ({ value: status, label: sentence(statusLabel(status)) }))

  return (
    <div
      role="region"
      aria-label="Selected applications"
      className={cn(
        'fixed bottom-6 left-1/2 z-50 -translate-x-1/2',
        'flex w-max max-w-[calc(100vw-1rem)] flex-wrap items-center justify-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-4',
        'rounded-xl border border-border bg-card',
        'shadow-lg shadow-black/20',
        'animate-in fade-in slide-in-from-bottom-4 duration-200',
      )}
    >
      <span className="text-sm font-medium text-foreground" aria-live="polite">
        {selectedCount} selected
      </span>

      <div className="w-px self-stretch bg-border" aria-hidden />

      <Select items={items} value={null} disabled={busy} onValueChange={(value: string | null) => { if (value) onSetStatus(value) }}>
        <SelectTrigger className="w-32 text-xs sm:w-40" aria-label={`Set status of ${selectedCount} ${noun}`}>
          <SelectValue placeholder="Set status" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      <div className="w-px self-stretch bg-border" aria-hidden />

      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        <Trash2Icon data-icon="inline-start" aria-hidden />
        Delete
      </Button>

      <Button variant="ghost" size="icon-sm" aria-label="Clear selection" title="Clear selection" onClick={onClearSelection}>
        <XIcon aria-hidden />
      </Button>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedCount} {noun}?</AlertDialogTitle>
            <AlertDialogDescription>They disappear from the board and the list. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirming(false)
                onDelete()
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
