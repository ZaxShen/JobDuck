import { useState } from 'react'
import { Input } from '@/components/ui/input'

interface NumberInputProps {
  id: string
  value: unknown
  onChange: (next: number) => void
  min?: number
  step?: number
  placeholder?: string
}

export function NumberInput({ id, value, onChange, min = 0, step = 1, placeholder }: NumberInputProps) {
  const [text, setText] = useState(value ? String(value) : '')
  return (
    <Input
      id={id}
      type="number"
      inputMode="decimal"
      min={min}
      step={step}
      placeholder={placeholder}
      value={text}
      onChange={(event) => {
        setText(event.target.value)
        onChange(event.target.value === '' ? min : Math.max(min, Number(event.target.value)))
      }}
    />
  )
}
