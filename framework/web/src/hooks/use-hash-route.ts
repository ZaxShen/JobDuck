import { useCallback, useEffect, useState } from 'react'
import { viewFromHash, type View } from '@/lib/routing'

export type { View } from '@/lib/routing'

const current = (): View => viewFromHash(window.location.hash)

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
