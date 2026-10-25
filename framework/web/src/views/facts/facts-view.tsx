import { useCallback, useEffect, useMemo, useState } from 'react'
import { LightbulbIcon } from 'lucide-react'
import { SectionCard } from '@/components/composed/section-card'
import { Button } from '@/components/ui/button'
import { useFlash } from '@/hooks/use-flash'
import { useVisiblePoll } from '@/hooks/use-visible-poll'
import { type SaveResult, deleteJSON, errorMessage, fetchJSON, isConflict, patchJSON } from '@/lib/api'
import type { FactStatus, ProfileFact } from '@/lib/types'
import { cn } from '@/lib/utils'
import { FactCard } from '@/views/facts/fact-card'

const TABS: { status: FactStatus; label: string; empty: string }[] = [
  { status: 'proposed', label: 'Proposed', empty: 'Nothing waiting for review.' },
  { status: 'accepted', label: 'Accepted', empty: 'No accepted facts yet. Accept proposed facts to use them in your CV.' },
  { status: 'archived', label: 'Archived', empty: 'No archived facts.' },
]

const MOVED: Record<FactStatus, string> = {
  accepted: 'Fact accepted', archived: 'Fact archived', proposed: 'Fact restored to proposed',
}

const NO_COMPANY = 'No company'

type Groups = [string, [string, ProfileFact[]][]][]

function group(facts: ProfileFact[]): Groups {
  const companies = new Map<string, Map<string, ProfileFact[]>>()
  for (const fact of facts) {
    const company = fact.company ?? NO_COMPANY
    const projects = companies.get(company) ?? new Map<string, ProfileFact[]>()
    projects.set(fact.project, [...(projects.get(fact.project) ?? []), fact])
    companies.set(company, projects)
  }
  return [...companies].map(([company, projects]) => [company, [...projects]])
}

function EmptyState() {
  return (
    <SectionCard title="No experience facts yet" className="bg-muted/40">
      <p className="text-sm text-muted-foreground">
        Tell your agent "augment my profile". Its <code className="rounded bg-muted px-1">augment</code> skill reads the
        Experience in your profile and proposes atomic facts (one action each, with outcome and metrics) here. Accept the
        ones that are true: the <code className="rounded bg-muted px-1">cv</code> skill builds your CV bullets only from
        accepted facts.
      </p>
    </SectionCard>
  )
}

export function FactsView({ active }: { active: boolean }) {
  const flash = useFlash()
  const [facts, setFacts] = useState<ProfileFact[]>([])
  const [loaded, setLoaded] = useState(false)
  const [tab, setTab] = useState<FactStatus>('proposed')

  const refresh = useCallback(async () => {
    try {
      setFacts((await fetchJSON<{ facts: ProfileFact[] }>('/api/profile-facts')).facts)
      setLoaded(true)
    } catch (error) {
      flash(errorMessage(error), true)
    }
  }, [flash])

  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh])

  useEffect(() => {
    if (!active) return
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [active, refresh])

  useVisiblePoll(refresh, active)

  const mutate = useCallback(async (call: () => Promise<unknown>, done: string): Promise<SaveResult> => {
    try {
      await call()
      flash(done)
      await refresh()
      return 'saved'
    } catch (error) {
      flash(errorMessage(error), true)
      if (!isConflict(error)) return 'failed'
      await refresh()
      return 'reloaded'
    }
  }, [flash, refresh])

  const counts = useMemo(() => Object.fromEntries(TABS.map(({ status }) =>
    [status, facts.filter((fact) => fact.status === status).length])) as Record<FactStatus, number>, [facts])
  const groups = useMemo(() => group(facts.filter((fact) => fact.status === tab)), [facts, tab])
  const current = TABS.find((item) => item.status === tab)!

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <p className="text-sm text-muted-foreground">
        Atomic facts about your work, proposed by your agent. Your CV is written only from the ones you accept.
      </p>

      {loaded && facts.length === 0 ? <EmptyState /> : (
        <>
          <nav aria-label="Filter by status" className="flex flex-wrap gap-1.5">
            {TABS.map(({ status, label }) => (
              <Button
                key={status}
                type="button"
                size="sm"
                variant={tab === status ? 'default' : 'outline'}
                aria-pressed={tab === status}
                onClick={() => setTab(status)}
              >
                {label}
                <span className={cn('tabular-nums', tab === status ? 'opacity-80' : 'text-muted-foreground')}>{counts[status]}</span>
              </Button>
            ))}
          </nav>

          {loaded && groups.length === 0 && (
            <div className="flex flex-col items-center gap-2 rounded-xl px-6 py-12 text-center text-sm text-muted-foreground ring-1 ring-foreground/10">
              <LightbulbIcon className="size-5" />
              {current.empty}
            </div>
          )}

          {groups.map(([company, projects]) => (
            <SectionCard key={company} title={company}>
              <div className="space-y-5">
                {projects.map(([project, items]) => (
                  <section key={project} className="space-y-2">
                    <h3 className="text-sm font-medium text-muted-foreground">{project}</h3>
                    <ul className="space-y-2 text-sm">
                      {items.map((fact) => (
                        <FactCard
                          key={fact.id}
                          fact={fact}
                          onSave={(body) => mutate(
                            () => patchJSON(`/api/profile-facts/${fact.id}`, body),
                            typeof body.status === 'string' ? MOVED[body.status as FactStatus] : 'Fact saved',
                          )}
                          onDelete={() => mutate(
                            () => deleteJSON(`/api/profile-facts/${fact.id}`, { expected_updated_at: fact.updated_at }),
                            'Fact deleted',
                          )}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </SectionCard>
          ))}
        </>
      )}
    </div>
  )
}
