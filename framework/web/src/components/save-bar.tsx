import { Button } from '@/components/ui/button'

interface SaveBarProps {
  onSave: () => void
  onDiscard: () => void
}

export function SaveBar({ onSave, onDiscard }: SaveBarProps) {
  return (
    <div className="mx-auto flex w-full max-w-md items-center gap-2 rounded-xl border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-300">
      <span className="flex-1 text-muted-foreground">Unsaved changes</span>
      <Button type="button" variant="ghost" onClick={onDiscard}>Discard</Button>
      <Button type="button" onClick={onSave}>Save</Button>
    </div>
  )
}
