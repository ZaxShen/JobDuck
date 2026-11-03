import { useState } from 'react'
import { SegmentedToggle } from '@/components/fields/segmented-toggle'
import { SeniorityPicker } from '@/components/fields/seniority-picker'
import { inferTrack, pruneToTrack, TRACKS, type Track } from '@/lib/seniority'

interface CareerSeniorityProps {
  id: string
  value: string[]
  onChange: (next: string[]) => void
}

export function CareerSeniority({ id, value, onChange }: CareerSeniorityProps) {
  const [track, setTrack] = useState<Track>(() => inferTrack(value))
  const switchTrack = (next: Track) => {
    setTrack(next)
    onChange(pruneToTrack(value, next))
  }
  return (
    <div className="space-y-2">
      <SegmentedToggle label="Career Track" options={TRACKS} value={track} onChange={switchTrack} />
      <SeniorityPicker id={id} track={track} value={value} onChange={onChange} />
    </div>
  )
}
