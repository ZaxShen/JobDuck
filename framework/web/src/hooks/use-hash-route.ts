import { useCallback, useEffect, useState } from 'react'

export const VIEWS = ['applications', 'profile', 'settings', 'welcome'] as const
export type View = (typeof VIEWS)[number]

const current = (): View => {
  const name = window.location.hash.slice(1)
  return (VIEWS as readonly string[]).includes(name) ? (name as View) : 'applications'
}

export function useHashRoute() {
  const [view, setView] = useState<View>(current)

  useEffect(() => {
    const onChange = () => setView(current())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const replace = useCallback((next: View) => {
    window.history.replaceState(null, '', `#${next}`)
    setView(next)
  }, [])

  return { view, replace }
}

export const go = (view: View) => {
  window.location.hash = view
}
