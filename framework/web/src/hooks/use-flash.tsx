import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { CircleCheckIcon, OctagonXIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

type Flash = (text: string, isError?: boolean) => void

const FlashContext = createContext<Flash>(() => undefined)

export const useFlash = () => useContext(FlashContext)

export function FlashProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<{ text: string; isError: boolean; id: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const flash = useCallback<Flash>((text, isError = false) => {
    clearTimeout(timer.current)
    setMessage({ text, isError, id: Date.now() })
    timer.current = setTimeout(() => setMessage(null), isError ? 8000 : 2500)
  }, [])

  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <FlashContext.Provider value={flash}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-4 z-[60] flex justify-center px-4" role="status" aria-live="polite">
        {message && (
          <div
            key={message.id}
            className={cn(
              'pointer-events-auto flex max-w-md items-start gap-2 rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md animate-in fade-in slide-in-from-top-2 duration-300',
              message.isError && 'border-destructive/40 text-destructive',
            )}
          >
            {message.isError ? <OctagonXIcon className="mt-0.5 size-4 shrink-0" /> : <CircleCheckIcon className="mt-0.5 size-4 shrink-0" />}
            <span>{message.text}</span>
          </div>
        )}
      </div>
    </FlashContext.Provider>
  )
}
