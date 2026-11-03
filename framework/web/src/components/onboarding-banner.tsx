import { useRef, useState } from 'react'
import { FileUpIcon, IdCardIcon, PencilLineIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useFlash } from '@/hooks/use-flash'
import { go } from '@/hooks/use-hash-route'
import { useOnboarding } from '@/hooks/use-onboarding'
import { errorMessage } from '@/lib/api'
import { RESUME_TYPES, inboxProblem } from '@/lib/wizard'
import { type BannerKind, type BannerPage, LINKEDIN_STEPS, bannerFor, dismissKey } from '@/lib/onboarding'
import { uploadToInbox } from '@/lib/upload'
import { cn } from '@/lib/utils'

export const PROFILE_FORM_ID = 'profile-form'

function wasDismissed(kind: BannerKind): boolean {
  try {
    return sessionStorage.getItem(dismissKey(kind)) === '1'
  } catch {
    return false
  }
}

function rememberDismissed(kind: BannerKind): void {
  try {
    sessionStorage.setItem(dismissKey(kind), '1')
  } catch {
    return
  }
}

export function focusProfileForm(): void {
  go('profile')
  window.setTimeout(() => {
    const field = document.getElementById(PROFILE_FORM_ID)?.querySelector<HTMLElement>('input, textarea, [role="combobox"]')
    field?.focus()
  }, 50)
}

interface OnboardingBannerProps {
  page: BannerPage
  active: boolean
  refreshKey?: unknown
  className?: string
}

export function OnboardingBanner({ page, active, refreshKey, className }: OnboardingBannerProps) {
  const flash = useFlash()
  const { status, refresh } = useOnboarding(active, refreshKey)
  const [dismissed, setDismissed] = useState<Set<BannerKind>>(
    () => new Set((['empty', 'pending'] as const).filter(wasDismissed)),
  )
  const [linkedIn, setLinkedIn] = useState(false)
  const [uploading, setUploading] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const banner = bannerFor(status, page)
  if (!banner || dismissed.has(banner.kind)) return null

  const dismiss = () => {
    rememberDismissed(banner.kind)
    setDismissed((current) => new Set([...current, banner.kind]))
  }

  const upload = async (file: File | undefined) => {
    if (input.current) input.current.value = ''
    if (!file) return
    const problem = inboxProblem(file)
    if (problem) return flash(problem, true)
    setUploading(true)
    try {
      const saved = await uploadToInbox(file)
      flash(`Saved to inbox/${saved.name}.`)
      refresh()
    } catch (error) {
      flash(errorMessage(error), true)
    } finally {
      setUploading(false)
    }
  }

  return (
    <Card role="status" className={cn('bg-muted/40 shadow-sm', className)}>
      <CardHeader>
        <CardTitle>{banner.title}</CardTitle>
        <CardDescription>{banner.body}</CardDescription>
        <CardAction>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={dismiss}>
            <XIcon aria-hidden="true" />
          </Button>
        </CardAction>
      </CardHeader>
      {banner.kind === 'empty' && (
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <input
              ref={input}
              type="file"
              accept={RESUME_TYPES.join(',')}
              className="hidden"
              onChange={(event) => void upload(event.target.files?.[0])}
            />
            <Button type="button" size="sm" disabled={uploading} onClick={() => input.current?.click()}>
              <FileUpIcon data-icon="inline-start" aria-hidden="true" />Upload A Resume
            </Button>
            <Button type="button" size="sm" variant="outline" aria-expanded={linkedIn} onClick={() => setLinkedIn((open) => !open)}>
              <IdCardIcon data-icon="inline-start" aria-hidden="true" />Import LinkedIn
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={focusProfileForm}>
              <PencilLineIcon data-icon="inline-start" aria-hidden="true" />Fill It In Yourself
            </Button>
          </div>
          {linkedIn && (
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              {LINKEDIN_STEPS.map((step) => <li key={step}>{step}</li>)}
            </ol>
          )}
        </CardContent>
      )}
    </Card>
  )
}
