import { useCallback, useMemo, useState } from 'react'
import { errorMessage, fetchJSON, isConflict, putJSON } from '@/lib/api'
import type { Draft } from '@/lib/forms'

export const CONFLICT_MESSAGE =
  'This file changed since you opened it, perhaps by your agent. Discard to load the latest, then make your edits again.'

interface DocSpec<V> {
  url: string
  fromView: (view: V) => Draft
  body: (draft: Draft, original: Draft, view: V) => unknown
}

export interface DocForm<V> {
  view: V | null
  draft: Draft | null
  original: Draft | null
  version: number
  loaded: boolean
  dirty: boolean
  saving: boolean
  saved: boolean
  error: string | null
  loadError: string | null
  setDraft: (draft: Draft) => void
  load: () => Promise<V | undefined>
  save: () => Promise<void>
  invalidate: () => void
}

interface Status {
  saving: boolean
  saved: boolean
  error: string | null
}

const IDLE: Status = { saving: false, saved: false, error: null }

export function useDocForm<V>(spec: DocSpec<V>): DocForm<V> {
  const [state, setState] = useState<{ view: V; original: Draft; draft: Draft; version: number } | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState<Status>(IDLE)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { url, fromView, body } = spec

  const show = useCallback((view: V) => {
    const original = fromView(view)
    setState((prev) => ({ view, original, draft: structuredClone(original), version: (prev?.version ?? 0) + 1 }))
    setLoaded(true)
    setLoadError(null)
  }, [fromView])

  const load = useCallback(async () => {
    try {
      const view = await fetchJSON<V>(url)
      setStatus((prev) => (prev.error ? IDLE : prev))
      show(view)
      return view
    } catch (error) {
      setLoadError(errorMessage(error))
      return undefined
    }
  }, [url, show])

  const save = useCallback(async () => {
    if (!state) return
    setStatus({ saving: true, saved: false, error: null })
    try {
      show(await putJSON<V>(url, body(state.draft, state.original, state.view)))
      setStatus({ saving: false, saved: true, error: null })
    } catch (error) {
      setStatus({ saving: false, saved: false, error: isConflict(error) ? CONFLICT_MESSAGE : errorMessage(error) })
    }
  }, [state, url, body, show])

  const setDraft = useCallback((draft: Draft) => {
    setState((prev) => (prev ? { ...prev, draft } : prev))
    setStatus((prev) => (prev.saved || prev.error ? { ...prev, saved: false, error: null } : prev))
  }, [])
  const invalidate = useCallback(() => setLoaded(false), [])

  const dirty = useMemo(
    () => loaded && state !== null && JSON.stringify(state.draft) !== JSON.stringify(state.original),
    [loaded, state],
  )

  return {
    view: state?.view ?? null,
    draft: state?.draft ?? null,
    original: state?.original ?? null,
    version: state?.version ?? 0,
    loaded,
    dirty,
    ...status,
    loadError,
    setDraft,
    load,
    save,
    invalidate,
  }
}
