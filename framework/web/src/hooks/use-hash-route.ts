import { useCallback, useEffect, useState } from 'react'
import { hashFor, routeFromHash, type Route, type View } from '@/lib/routing'

export type { Route, View } from '@/lib/routing'

const current = (): Route => routeFromHash(window.location.hash)

export function useHashRoute() {
  const [route, setRoute] = useState<Route>(current)

  const replace = useCallback((next: Route) => {
    window.history.replaceState(null, '', hashFor(next))
    setRoute(next)
  }, [])

  useEffect(() => {
    const onChange = () => {
      const next = current()
      if (window.location.hash === hashFor(next)) setRoute(next)
      else replace(next)
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [replace])

  return { route, replace }
}

export const go = (view: View, section: string | null = null) => {
  window.location.hash = hashFor({ view, section })
}
