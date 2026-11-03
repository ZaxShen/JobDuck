import { cn } from '@/lib/utils'

export function SegmentedToggle<T extends string>({ label, options, value, onChange }: {
  label: string
  options: readonly (readonly [T, string])[]
  value: string
  onChange: (value: T) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1.5 rounded-lg bg-muted p-1">
      {options.map(([option, text]) => {
        const on = value === option
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(option)}
            className={cn(
              'flex-1 rounded-md px-3 py-2 text-xs font-medium transition-all duration-200',
              on ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {text}
          </button>
        )
      })}
    </div>
  )
}
