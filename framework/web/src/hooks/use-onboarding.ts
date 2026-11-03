import { useCallback, useEffect, useState } from 'react'
import { useVisiblePoll } from '@/hooks/use-visible-poll'
import { fetchJSON } from '@/lib/api'
import type { OnboardingStatus } from '@/lib/types'

export function useOnboarding(active: boolean, refreshKey: unknown = null) {
  const [status, setStatus] = useState<OnboardingStatus | null>(null)

  const refresh = useCallback(() => {
    fetchJSON<OnboardingStatus>('/api/onboarding').then(setStatus, () => setStatus(null))
  }, [])

  useEffect(() => {
    if (active) refresh()
  }, [active, refresh, refreshKey])

  useEffect(() => {
    if (!active) return
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [active, refresh])

  useVisiblePoll(refresh, active)

  return { status, refresh }
}
