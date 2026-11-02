import { useId, useState } from 'react'
import { PlusIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { splitList } from '@/lib/paths'

interface ChipInputProps {
  id: string
  label: string
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  suggest?: readonly string[]
}

export function ChipInput({ id, label, value, onChange, placeholder, suggest }: ChipInputProps) {
  const [text, setText] = useState('')
  const listId = useId()

  const add = () => {
    const fresh = splitList(text).filter((chip, index, all) => !value.includes(chip) && all.indexOf(chip) === index)
    setText('')
    if (fresh.length > 0) onChange([...value, ...fresh])
  }

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul aria-label={label} className="flex flex-wrap gap-2">
          {value.map((chip, index) => (
            <li
              key={`${chip}-${index}`}
              className="flex max-w-full items-center gap-1 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs text-secondary-foreground"
            >
              <span className="min-w-0 break-words">{chip}</span>
              <button
                type="button"
                onClick={() => onChange(value.filter((_, i) => i !== index))}
                className="ml-0.5 rounded-full text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Remove ${chip}`}
              >
                <XIcon className="size-3" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={text}
          autoComplete="off"
          list={suggest ? listId : undefined}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            }
          }}
          onBlur={add}
          placeholder={placeholder ?? 'Type, then press Enter'}
          className="max-w-xs"
        />
        <Button type="button" variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={add}>
          <PlusIcon data-icon="inline-start" aria-hidden="true" />
          Add<span className="sr-only"> {label}</span>
        </Button>
      </div>
      {suggest && (
        <datalist id={listId}>
          {suggest.map((option) => <option key={option} value={option} />)}
        </datalist>
      )}
    </div>
  )
}
