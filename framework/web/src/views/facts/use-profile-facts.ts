import { useCallback, useEffect, useState } from 'react'
import { useFlash } from '@/hooks/use-flash'
import { useVisiblePoll } from '@/hooks/use-visible-poll'
import { type SaveResult, errorMessage, fetchJSON, isConflict } from '@/lib/api'
import type { ProfileFact } from '@/lib/types'

export interface ProfileFacts {
  facts: ProfileFact[]
  loaded: boolean
  mutate: (call: () => Promise<unknown>, done: string) => Promise<SaveResult>
}

export function useProfileFacts(active: boolean, live: boolean): ProfileFacts {
  const flash = useFlash()
  const [facts, setFacts] = useState<ProfileFact[]>([])
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setFacts((await fetchJSON<{ facts: ProfileFact[] }>('/api/profile-facts')).facts)
      setLoaded(true)
    } catch (error) {
      flash(errorMessage(error), true)
    }
  }, [flash])

  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh])

  useEffect(() => {
    if (!active) return
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [active, refresh])

  useVisiblePoll(refresh, live)

  const mutate = useCallback(async (call: () => Promise<unknown>, done: string): Promise<SaveResult> => {
    try {
      await call()
      flash(done)
      await refresh()
      return 'saved'
    } catch (error) {
      flash(errorMessage(error), true)
      if (!isConflict(error)) return 'failed'
      await refresh()
      return 'reloaded'
    }
  }, [flash, refresh])

  return { facts, loaded, mutate }
}
