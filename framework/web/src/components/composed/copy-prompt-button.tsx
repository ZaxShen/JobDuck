import { useEffect, useState } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useFlash } from '@/hooks/use-flash'
import { errorMessage } from '@/lib/api'

const COPIED_MS = 2000

interface CopyPromptButtonProps {
  prompt: string
  label?: string
  context?: string
}

export function CopyPromptButton({ prompt, label = 'Copy Prompt', context }: CopyPromptButtonProps) {
  const flash = useFlash()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
    } catch (error) {
      flash(`Could not copy the prompt: ${errorMessage(error)}`, true)
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
      {copied ? <CheckIcon data-icon="inline-start" aria-hidden="true" /> : <CopyIcon data-icon="inline-start" aria-hidden="true" />}
      <span aria-live="polite">{copied ? 'Prompt Copied' : label}</span>
      {context && <span className="sr-only">{context}</span>}
    </Button>
  )
}
