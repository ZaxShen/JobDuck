import { useRef, useState, type DragEvent } from 'react'
import { FileTextIcon, FolderInputIcon, UploadIcon, XIcon } from 'lucide-react'
import { SectionCard } from '@/components/composed/section-card'
import { useFlash } from '@/hooks/use-flash'
import { inboxProblem, RESUME_TYPES } from '@/lib/wizard'
import { cn } from '@/lib/utils'
import { StepActions, StepIntro, stepMotion } from '@/views/welcome/step-parts'

interface WelcomeStepProps {
  file: File | null
  noInbox: boolean
  onFile: (file: File | null) => void
  onSkip: () => void
  onContinue: () => Promise<void>
}

function InboxHelp() {
  return (
    <SectionCard title={<span className="flex items-center gap-2"><FolderInputIcon className="size-4" />Put it in inbox/</span>}
      description="This dashboard is not running in a Job Duck workspace, so it cannot take the file here.">
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>Save your resume into the <code className="rounded bg-muted px-1">inbox/</code> folder of your Job Duck workspace.</li>
        <li>Back in your agent, say "import my resume".</li>
      </ol>
    </SectionCard>
  )
}

export function WelcomeStep({ file, noInbox, onFile, onSkip, onContinue }: WelcomeStepProps) {
  const flash = useFlash()
  const [dragOver, setDragOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const choose = (picked: File | undefined) => {
    if (!picked) return
    const problem = inboxProblem(picked)
    if (problem) return flash(problem, true)
    onFile(picked)
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragOver(false)
    choose(event.dataTransfer.files[0])
  }

  return (
    <div className={cn('flex flex-col items-center gap-10', stepMotion)}>
      <StepIntro title="Let's get you set up.">Tell Job Duck who you are. Every step is optional.</StepIntro>

      <div className="w-full">
        {noInbox ? <InboxHelp /> : (
          <div
            role="button"
            tabIndex={0}
            aria-label="Choose a resume file"
            className={cn(
              'group relative flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 transition-all duration-300 outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
              dragOver
                ? 'border-foreground/40 bg-muted/60'
                : file
                  ? 'border-foreground/20 bg-muted/30'
                  : 'border-border hover:border-foreground/20 hover:bg-muted/30',
            )}
            onDragOver={(event) => {
              event.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => input.current?.click()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                input.current?.click()
              }
            }}
          >
            <input
              ref={input}
              type="file"
              accept={RESUME_TYPES.join(',')}
              className="hidden"
              onChange={(event) => choose(event.target.files?.[0])}
            />
            {file ? (
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-lg bg-foreground/5">
                  <FileTextIcon className="size-5 text-foreground/60" />
                </div>
                <div className="min-w-0 text-left">
                  <p className="truncate text-sm font-medium">{file.name}</p>
                  <p className="text-xs text-muted-foreground">{Math.max(1, Math.round(file.size / 1024))} KB</p>
                </div>
                <button
                  type="button"
                  aria-label="Remove file"
                  className="ml-2 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
                  onClick={(event) => {
                    event.stopPropagation()
                    onFile(null)
                    if (input.current) input.current.value = ''
                  }}
                >
                  <XIcon className="size-4" />
                </button>
              </div>
            ) : (
              <>
                <div className="flex size-12 items-center justify-center rounded-xl bg-foreground/5 transition-colors group-hover:bg-foreground/10">
                  <UploadIcon className="size-5 text-muted-foreground" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-medium">
                    Drop your resume here, or{' '}
                    <span className="text-foreground underline underline-offset-4">browse</span>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    PDF, Word, Markdown or text.
                  </p>
                </div>
              </>
            )}
          </div>
        )}
        <p className="mt-3 text-center text-xs text-muted-foreground">
          No resume handy? Skip this, then tell your agent "import my LinkedIn". It reads your own LinkedIn profile, read-only.
        </p>
      </div>

      <StepActions onSkip={onSkip} onContinue={onContinue} />
    </div>
  )
}
