import { AlertCircleIcon, CheckCircleIcon, SaveIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { DocForm } from '@/hooks/use-doc-form'

type SaveState = Pick<DocForm<unknown>, 'saving' | 'saved' | 'error' | 'dirty'>

interface SaveBarProps extends SaveState {
  onSave: () => void
  onDiscard: () => void
}

export function SaveBar({ saving, saved, error, dirty, onSave, onDiscard }: SaveBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" size="sm" onClick={onSave} disabled={saving} className="gap-2">
        <SaveIcon data-icon="inline-start" aria-hidden="true" />
        {saving ? 'Saving…' : 'Save'}
      </Button>
      {dirty && !saving && (
        <Button type="button" size="sm" variant="ghost" onClick={onDiscard}>Discard</Button>
      )}
      <span role="status" aria-live="polite" className="flex min-w-0 items-center">
        {saved && (
          <span className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
            <CheckCircleIcon className="size-4" aria-hidden="true" />
            Saved
          </span>
        )}
        {error && (
          <span className="flex items-center gap-1.5 text-sm text-destructive">
            <AlertCircleIcon className="size-4 shrink-0" aria-hidden="true" />
            {error}
          </span>
        )}
      </span>
    </div>
  )
}
