import { useCallback, useMemo, useState } from 'react'
import { errorMessage, fetchJSON, isConflict, putJSON } from '@/lib/api'
import type { Draft } from '@/lib/forms'
import { useFlash } from '@/hooks/use-flash'

export const CONFLICT_MESSAGE =
  'This file changed since you opened it, perhaps by your agent. Discard to load the latest, then make your edits again.'

interface DocSpec<V> {
  url: string
  fromView: (view: V) => Draft
  body: (draft: Draft, original: Draft, view: V) => unknown
  saved: string
}

export interface DocForm<V> {
  view: V | null
  draft: Draft | null
  version: number
  loaded: boolean
  dirty: boolean
  setDraft: (draft: Draft) => void
  load: () => Promise<V | undefined>
  save: () => Promise<void>
  invalidate: () => void
}

export function useDocForm<V>(spec: DocSpec<V>): DocForm<V> {
  const flash = useFlash()
  const [state, setState] = useState<{ view: V; original: Draft; draft: Draft; version: number } | null>(null)
  const [loaded, setLoaded] = useState(false)
  const { url, fromView, body, saved } = spec

  const show = useCallback((view: V) => {
    const original = fromView(view)
    setState((prev) => ({ view, original, draft: structuredClone(original), version: (prev?.version ?? 0) + 1 }))
    setLoaded(true)
  }, [fromView])

  const load = useCallback(async () => {
    try {
      const view = await fetchJSON<V>(url)
      show(view)
      return view
    } catch (error) {
      flash(errorMessage(error), true)
      return undefined
    }
  }, [url, show, flash])

  const save = useCallback(async () => {
    if (!state) return
    try {
      show(await putJSON<V>(url, body(state.draft, state.original, state.view)))
      flash(saved)
    } catch (error) {
      flash(isConflict(error) ? CONFLICT_MESSAGE : errorMessage(error), true)
    }
  }, [state, url, body, show, flash, saved])

  const setDraft = useCallback((draft: Draft) => setState((prev) => (prev ? { ...prev, draft } : prev)), [])
  const invalidate = useCallback(() => setLoaded(false), [])

  const dirty = useMemo(
    () => loaded && state !== null && JSON.stringify(state.draft) !== JSON.stringify(state.original),
    [loaded, state],
  )

  return {
    view: state?.view ?? null,
    draft: state?.draft ?? null,
    version: state?.version ?? 0,
    loaded,
    dirty,
    setDraft,
    load,
    save,
    invalidate,
  }
}
