import { useEffect } from 'react'

export const POLL_MS = 15_000

export const isVisible = () => document.visibilityState === 'visible'

export function useVisiblePoll(poll: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => { if (isVisible()) poll() }, POLL_MS)
    return () => clearInterval(timer)
  }, [poll, enabled])
}
