import { useState } from 'react'
import { PlusIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Column } from '@/lib/forms'

type Row = Record<string, string>

interface RowListProps {
  id: string
  initial: Row[]
  columns: readonly Column[]
  addLabel: string
  onChange: (rows: Row[]) => void
}

export function RowList({ id, initial, columns, addLabel, onChange }: RowListProps) {
  const [rows, setRows] = useState<Row[]>(initial)
  const update = (next: Row[], write = true) => {
    setRows(next)
    if (write) onChange(next)
  }
  return (
    <div id={id} className="space-y-2">
      {rows.map((row, index) => (
        <div key={index} className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {columns.map((column) => (
            <Input
              key={column.name}
              aria-label={column.label}
              placeholder={column.placeholder}
              value={row[column.name] ?? ''}
              onChange={(event) => update(rows.map((r, i) => (i === index ? { ...r, [column.name]: event.target.value } : r)))}
            />
          ))}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove row"
            className="self-end sm:self-auto"
            onClick={() => update(rows.filter((_, i) => i !== index))}
          >
            <Trash2Icon />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => update([...rows, Object.fromEntries(columns.map((column) => [column.name, '']))], false)}
      >
        <PlusIcon />
        {addLabel}
      </Button>
    </div>
  )
}
