import { useCallback, useEffect, useRef, useState } from 'react'
import { useFlash } from '@/hooks/use-flash'
import { useVisiblePoll } from '@/hooks/use-visible-poll'
import { type SaveResult, errorMessage, fetchJSON, isConflict, patchJSON } from '@/lib/api'
import { reorderedFacts } from '@/lib/fact-order'
import type { ProfileFact } from '@/lib/types'

export interface ProfileFacts {
  facts: ProfileFact[]
  loaded: boolean
  mutate: (call: () => Promise<unknown>, done: string) => Promise<SaveResult>
  reorder: (ordered: ProfileFact[]) => Promise<void>
}

export function useProfileFacts(active: boolean, live: boolean): ProfileFacts {
  const flash = useFlash()
  const [facts, setFacts] = useState<ProfileFact[]>([])
  const [loaded, setLoaded] = useState(false)
  const reordering = useRef(0)

  const refresh = useCallback(async () => {
    try {
      const next = (await fetchJSON<{ facts: ProfileFact[] }>('/api/profile-facts')).facts
      if (reordering.current > 0) return
      setFacts(next)
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

  const reorder = useCallback(async (ordered: ProfileFact[]) => {
    const { next, moves } = reorderedFacts(facts, ordered)
    if (moves.length === 0) return
    const previous = facts
    setFacts(next)
    reordering.current += 1
    try {
      await Promise.all(moves.map(({ fact, sort_order }) =>
        patchJSON(`/api/profile-facts/${fact.id}`, { sort_order, expected_updated_at: fact.updated_at })))
    } catch (error) {
      setFacts(previous)
      flash(`Could not save the new order: ${errorMessage(error)}`, true)
    } finally {
      reordering.current -= 1
    }
    await refresh()
  }, [facts, flash, refresh])

  return { facts, loaded, mutate, reorder }
}
