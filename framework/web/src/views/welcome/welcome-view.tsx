import { useCallback, useEffect, useRef, useState } from 'react'
import { useFlash } from '@/hooks/use-flash'
import { errorMessage, fetchJSON, isConflict, postJSON, putJSON } from '@/lib/api'
import { MODULES } from '@/lib/forms'
import { clone } from '@/lib/paths'
import type { FrontMatter, InboxUpload, PermissionsView, ProfileView } from '@/lib/types'
import { base64Of, careerDna, companyStages, DEFAULT_QUIZ, WIZARD_STEPS, WORK_MODES, type Quiz } from '@/lib/wizard'
import { doneSummary, NOTHING_SAVED, type SavedSteps } from '@/lib/wizard-done'
import { cn } from '@/lib/utils'
import { DoneStep } from '@/views/welcome/done-step'
import { ModulesStep } from '@/views/welcome/modules-step'
import { QuizStep } from '@/views/welcome/quiz-step'
import { TargetsStep, type Targets } from '@/views/welcome/targets-step'
import { WelcomeStep } from '@/views/welcome/welcome-step'

interface WelcomeViewProps {
  active: boolean
  onProfileSaved: () => void
  onSettingsSaved: () => void
}

const LAST = WIZARD_STEPS.length - 1

const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])

const targetsOf = (front: FrontMatter): Targets => ({
  target_titles: list(front.target_titles),
  locations: list(front.locations),
  seniority: list(front.seniority),
  pay_floor: Number(front.pay_floor) || 0,
})

function Progress({ step }: { step: number }) {
  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-[11px] font-medium tracking-widest text-muted-foreground uppercase" aria-live="polite">
        {WIZARD_STEPS[step]}
      </p>
      <div className="flex items-center gap-1.5" aria-hidden="true">
        {WIZARD_STEPS.map((name, index) => (
          <span
            key={name}
            className={cn('h-0.5 rounded-full transition-all duration-500', index <= step ? 'w-14 bg-foreground' : 'w-10 bg-border')}
          />
        ))}
      </div>
    </div>
  )
}

export function WelcomeView({ active, onProfileSaved, onSettingsSaved }: WelcomeViewProps) {
  const flash = useFlash()
  const [step, setStep] = useState(0)
  const [file, setFile] = useState<File | null>(null)
  const [uploaded, setUploaded] = useState<InboxUpload | null>(null)
  const [noInbox, setNoInbox] = useState(false)
  const [quiz, setQuiz] = useState<Quiz>(DEFAULT_QUIZ)
  const [targets, setTargets] = useState<Targets | null>(null)
  const [modules, setModules] = useState<Record<string, boolean> | null>(null)
  const [saved, setSaved] = useState<SavedSteps>(NOTHING_SAVED)
  const [ready, setReady] = useState(false)
  const stepRef = useRef(0)

  const goTo = (next: number) => {
    stepRef.current = next
    setStep(next)
    window.scrollTo(0, 0)
  }

  const open = useCallback(async () => {
    try {
      const [profile, permissions] = await Promise.all([
        fetchJSON<ProfileView>('/api/profile'),
        fetchJSON<PermissionsView>('/api/permissions'),
      ])
      setTargets(targetsOf(profile.front_matter))
      setModules({ ...permissions.permissions.modules })
      if (stepRef.current === LAST) {
        stepRef.current = 0
        setStep(0)
        setFile(null)
        setUploaded(null)
        setSaved(NOTHING_SAVED)
      }
      const mode = list(profile.front_matter.work_modes)[0]
      if ((WORK_MODES as readonly string[]).includes(mode ?? '')) setQuiz((prev) => ({ ...prev, mode: mode! }))
      setReady(true)
    } catch (error) {
      flash(errorMessage(error), true)
    }
  }, [flash])

  useEffect(() => {
    if (active) void open()
  }, [active, open])

  const guarded = async (work: () => Promise<void>) => {
    try {
      await work()
    } catch (error) {
      flash(errorMessage(error), true)
    }
  }

  const saveProfile = async (frontMatter: FrontMatter, sections: Record<string, string>) => {
    const current = await fetchJSON<ProfileView>('/api/profile')
    const saved = await putJSON<ProfileView>('/api/profile', { front_matter: frontMatter, sections, revision: current.revision })
    onProfileSaved()
    return saved
  }

  const uploadAndContinue = async () => {
    if (!file || noInbox) return goTo(1)
    try {
      const data = await base64Of(file)
      const result = await postJSON<InboxUpload>('/api/inbox', { name: file.name, data })
      setUploaded(result)
      setFile(null)
      flash(`Saved to inbox/${result.name}.`)
      goTo(1)
    } catch (error) {
      if (!isConflict(error)) return flash(errorMessage(error), true)
      setNoInbox(true)
    }
  }

  const saveQuiz = () => guarded(async () => {
    const profile = await saveProfile(
      { work_modes: [quiz.mode], company_stages: companyStages(quiz.risk) },
      { 'Career DNA': careerDna(quiz) },
    )
    setTargets(targetsOf(profile.front_matter))
    setSaved((prev) => ({ ...prev, quiz: true }))
    goTo(2)
  })

  const saveTargets = () => guarded(async () => {
    if (targets) {
      await saveProfile({ ...targets }, {})
      setSaved((prev) => ({ ...prev, targets: true }))
    }
    goTo(3)
  })

  const saveModules = () => guarded(async () => {
    const current = await fetchJSON<PermissionsView>('/api/permissions')
    const permissions = clone(current.permissions)
    permissions.modules = { ...permissions.modules, ...modules }
    await putJSON<PermissionsView>('/api/permissions', { permissions, revision: current.revision })
    onSettingsSaved()
    setSaved((prev) => ({ ...prev, modules: true }))
    goTo(4)
  })

  return (
    <div className="relative min-h-svh overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--color-muted)_0%,transparent_60%)]"
      />
      <div className="relative mx-auto flex w-full max-w-lg flex-col gap-12 px-6 py-12 sm:py-16">
        <Progress step={step} />
        {ready && (
          <div key={step}>
            {step === 0 && (
              <WelcomeStep file={file} noInbox={noInbox} onFile={setFile} onSkip={() => goTo(1)} onContinue={uploadAndContinue} />
            )}
            {step === 1 && <QuizStep quiz={quiz} onChange={setQuiz} onSkip={() => goTo(2)} onContinue={saveQuiz} />}
            {step === 2 && targets && (
              <TargetsStep targets={targets} onChange={setTargets} onSkip={() => goTo(3)} onContinue={saveTargets} />
            )}
            {step === 3 && modules && (
              <ModulesStep modules={modules} onChange={setModules} onSkip={() => goTo(4)} onContinue={saveModules} />
            )}
            {step === 4 && (
              <DoneStep
                uploaded={uploaded}
                summary={doneSummary({
                  uploaded: uploaded !== null,
                  saved,
                  modulesOn: MODULES.filter(([key]) => modules?.[key]).length,
                })}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
