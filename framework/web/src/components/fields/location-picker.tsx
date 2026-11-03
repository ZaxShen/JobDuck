import { useMemo, useState } from 'react'
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from '@/components/ui/combobox'
import { LOCATIONS, searchLocations } from '@/lib/locations'

interface LocationPickerProps {
  id: string
  value: string[]
  onChange: (next: string[]) => void
}

export function LocationPicker({ id, value, onChange }: LocationPickerProps) {
  const anchor = useComboboxAnchor()
  const [query, setQuery] = useState('')
  const matches = useMemo(() => searchLocations(query), [query])

  return (
    <Combobox
      multiple
      autoHighlight
      items={LOCATIONS}
      filteredItems={matches}
      value={value}
      onValueChange={onChange}
      inputValue={query}
      onInputValueChange={setQuery}
    >
      <ComboboxChips ref={anchor} className="w-full">
        <ComboboxValue>
          {(selected: string[]) => (
            <>
              {selected.map((location) => (
                <ComboboxChip key={location} removeLabel={`Remove ${location}`}>{location}</ComboboxChip>
              ))}
              <ComboboxChipsInput
                id={id}
                className="h-6 bg-transparent px-1 placeholder:text-muted-foreground"
                placeholder={selected.length > 0 ? '' : 'Search, e.g. Remote, London, California'}
              />
            </>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>No matching place.</ComboboxEmpty>
        <ComboboxList>
          {(location: string) => (
            <ComboboxItem key={location} value={location}>{location}</ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
