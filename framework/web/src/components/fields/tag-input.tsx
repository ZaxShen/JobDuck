import { useId, useState, type KeyboardEvent } from 'react'
import { XIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { splitList } from '@/lib/paths'

interface TagInputProps {
  id: string
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  suggest?: readonly string[]
}

export function TagInput({ id, value, onChange, placeholder, suggest }: TagInputProps) {
  const [text, setText] = useState('')
  const listId = useId()

  const add = (raw: string) => {
    const fresh = splitList(raw).filter((tag, index, all) => !value.includes(tag) && all.indexOf(tag) === index)
    if (fresh.length > 0) onChange([...value, ...fresh])
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      add(text)
      setText('')
    } else if (event.key === 'Backspace' && text === '' && value.length > 0) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <div
      className="flex min-h-8 w-full flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent px-1.5 py-1 text-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30"
      onClick={() => document.getElementById(id)?.focus()}
    >
      {value.map((tag, index) => (
        <Badge key={`${tag}-${index}`} variant="secondary" className="h-6 gap-1 pr-1">
          {tag}
          <button
            type="button"
            className="rounded-sm text-muted-foreground hover:text-foreground"
            aria-label={`Remove ${tag}`}
            onClick={(event) => {
              event.stopPropagation()
              onChange(value.filter((_, i) => i !== index))
            }}
          >
            <XIcon className="size-3" />
          </button>
        </Badge>
      ))}
      <input
        id={id}
        type="text"
        autoComplete="off"
        list={suggest ? listId : undefined}
        className="h-6 min-w-24 flex-1 bg-transparent px-1 outline-none placeholder:text-muted-foreground"
        placeholder={placeholder ?? 'Type, then press Enter'}
        value={text}
        onKeyDown={onKeyDown}
        onChange={(event) => {
          const inputType = (event.nativeEvent as InputEvent).inputType
          const picked = (inputType === undefined || inputType === 'insertReplacementText') && suggest?.includes(event.target.value)
          if (picked) {
            add(event.target.value)
            setText('')
          } else setText(event.target.value)
        }}
        onBlur={() => {
          add(text)
          setText('')
        }}
      />
      {suggest && (
        <datalist id={listId}>
          {suggest.map((option) => <option key={option} value={option} />)}
        </datalist>
      )}
    </div>
  )
}
