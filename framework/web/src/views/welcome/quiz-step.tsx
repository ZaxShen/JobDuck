import { isToggle, QUIZ, type Question, type Quiz } from '@/lib/wizard'
import { cn } from '@/lib/utils'
import { StepActions, StepIntro, stepMotion } from '@/views/welcome/step-parts'

interface QuizStepProps {
  quiz: Quiz
  onChange: (quiz: Quiz) => void
  onSkip: () => void
  onContinue: () => Promise<void>
}

function QuestionHead({ question }: { question: Question }) {
  return (
    <div>
      <h3 className="text-sm font-semibold">{question.title}</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">{question.subtitle}</p>
    </div>
  )
}

export function QuizStep({ quiz, onChange, onSkip, onContinue }: QuizStepProps) {
  return (
    <div className={cn('flex flex-col gap-10', stepMotion)}>
      <StepIntro title="Your Career DNA">Five questions. Thirty seconds. No wrong answers.</StepIntro>

      <div className="space-y-8">
        {QUIZ.map((question, index) => (
          <div
            key={question.key}
            className="space-y-4 animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-500"
            style={{ animationDelay: `${index * 80}ms` }}
          >
            <QuestionHead question={question} />
            {isToggle(question) ? (
              <div role="radiogroup" aria-label={question.title} className="flex gap-1.5 rounded-lg bg-muted p-1">
                {question.options.map(([value, label]) => {
                  const on = quiz[question.key] === value
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => onChange({ ...quiz, [question.key]: value })}
                      className={cn(
                        'flex-1 rounded-md px-3 py-2 text-xs font-medium transition-all duration-200',
                        on ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="relative flex h-10 items-center">
                  <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-foreground/80 transition-all duration-150 ease-out"
                      style={{ width: `${quiz[question.key]}%` }}
                    />
                  </div>
                  <input
                    id={`quiz-${question.key}`}
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    aria-label={question.title}
                    value={quiz[question.key]}
                    onChange={(event) => onChange({ ...quiz, [question.key]: Number(event.target.value) })}
                    className="peer absolute inset-0 w-full cursor-pointer opacity-0"
                  />
                  <div
                    className="pointer-events-none absolute top-1/2 size-[18px] -translate-y-1/2 rounded-full border-2 border-foreground bg-background shadow-sm transition-all duration-150 ease-out peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50"
                    style={{ left: `calc(${quiz[question.key]}% - 9px)` }}
                  />
                </div>
                <div className="flex justify-between gap-4">
                  <span className={cn('text-[11px] font-medium transition-colors duration-200', quiz[question.key] <= 50 ? 'text-foreground' : 'text-muted-foreground')}>
                    {question.left}
                  </span>
                  <span className={cn('text-right text-[11px] font-medium transition-colors duration-200', quiz[question.key] >= 50 ? 'text-foreground' : 'text-muted-foreground')}>
                    {question.right}
                  </span>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <StepActions onSkip={onSkip} onContinue={onContinue} />
    </div>
  )
}
