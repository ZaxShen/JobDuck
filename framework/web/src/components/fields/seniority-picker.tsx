import { ChevronDownIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { levelsFor, SENIORITY_LABELS, seniorityLabel, toggleLevel, type Track } from '@/lib/seniority'
import { cn } from '@/lib/utils'

interface SeniorityPickerProps {
  id: string
  track: Track
  value: string[]
  onChange: (next: string[]) => void
}

export function SeniorityPicker({ id, track, value, onChange }: SeniorityPickerProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        id={id}
        render={<Button variant="outline" className="w-full justify-between font-normal" />}
      >
        <span className={cn('truncate', value.length === 0 && 'text-muted-foreground')}>
          {value.length > 0 ? value.map(seniorityLabel).join(', ') : 'Any Level'}
        </span>
        <ChevronDownIcon data-icon="inline-end" className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {levelsFor(track).map((level) => (
          <DropdownMenuCheckboxItem
            key={level}
            checked={value.includes(level)}
            onCheckedChange={(on) => onChange(toggleLevel(value, level, on))}
          >
            {SENIORITY_LABELS[level]}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
