import { useMemo, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ChevronRightIcon, LightbulbIcon, SparklesIcon } from 'lucide-react'
import { SectionCard } from '@/components/composed/section-card'
import { Button } from '@/components/ui/button'
import { deleteJSON, patchJSON } from '@/lib/api'
import type { FactStatus, ProfileFact } from '@/lib/types'
import { cn } from '@/lib/utils'
import { FactRow } from '@/views/facts/fact-row'
import type { ProfileFacts } from '@/views/facts/use-profile-facts'

const TABS: { status: FactStatus; label: string; empty: string }[] = [
  { status: 'proposed', label: 'Proposed', empty: 'Nothing waiting for review.' },
  { status: 'accepted', label: 'Accepted', empty: 'No accepted facts yet. Accept proposed facts to use them in your CV.' },
  { status: 'archived', label: 'Archived', empty: 'No archived facts.' },
]

const MOVED: Record<FactStatus, string> = {
  accepted: 'Fact accepted', archived: 'Fact archived', proposed: 'Fact restored to proposed',
}

const NO_COMPANY = 'No Company'

const INSTRUCTIONS = {
  draggable:
    'To move this fact, press Space or Enter, use the up and down arrow keys, then press Space or Enter again to drop it or Escape to cancel.',
}

type Groups = [string, [string, ProfileFact[]][]][]

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
const short = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}…` : text)

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
    <SectionCard title="No Experience Facts Yet" className="bg-muted/40">
      <p className="text-sm text-muted-foreground">
        Tell your agent "augment my profile". Its <code className="rounded bg-muted px-1">augment</code> skill reads the
        Experience in your profile and proposes atomic facts (one action each, with outcome and metrics) here. Accept the
        ones that are true: the <code className="rounded bg-muted px-1">cv</code> skill builds your CV bullets only from
        accepted facts.
      </p>
    </SectionCard>
  )
}

interface ProjectGroupProps {
  project: string
  facts: ProfileFact[]
  defaultOpen: boolean
  onReorder: (ordered: ProfileFact[]) => void
  onSave: (fact: ProfileFact, body: Record<string, unknown>) => ReturnType<ProfileFacts['mutate']>
  onDelete: (fact: ProfileFact) => ReturnType<ProfileFacts['mutate']>
}

function ProjectGroup({ project, facts, defaultOpen, onReorder, onSave, onDelete }: ProjectGroupProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const ids = useMemo(() => facts.map((fact) => fact.id), [facts])
  const name = (id: string | number | undefined) => short(facts.find((fact) => fact.id === id)?.action ?? 'fact')
  const position = (id: string | number) => ids.indexOf(Number(id)) + 1

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const from = ids.indexOf(Number(active.id))
    const to = ids.indexOf(Number(over.id))
    if (from === -1 || to === -1) return
    onReorder(arrayMove(facts, from, to))
  }

  return (
    <details open={defaultOpen} className="group/project rounded-md border border-border/60 bg-muted/10 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-sm text-xs font-medium text-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground transition-transform group-open/project:rotate-90" />
        <span className="min-w-0 break-words">{project}</span>
        <span className="ml-0.5 shrink-0 font-normal text-muted-foreground">({plural(facts.length, 'fact', 'facts')})</span>
      </summary>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={handleDragEnd}
        accessibility={{
          screenReaderInstructions: INSTRUCTIONS,
          announcements: {
            onDragStart: ({ active }) => `Picked up fact ${position(active.id)} of ${facts.length}: ${name(active.id)}.`,
            onDragOver: ({ active, over }) => (over ? `${name(active.id)} is at position ${position(over.id)} of ${facts.length}.` : undefined),
            onDragEnd: ({ active, over }) => (over ? `${name(active.id)} dropped at position ${position(over.id)} of ${facts.length}.` : `${name(active.id)} dropped.`),
            onDragCancel: ({ active }) => `Moving ${name(active.id)} was cancelled.`,
          },
        }}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ul className="mt-2 space-y-1.5">
            {facts.map((fact) => (
              <FactRow
                key={fact.id}
                fact={fact}
                onSave={(body) => onSave(fact, body)}
                onDelete={() => onDelete(fact)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </details>
  )
}

export function FactsView({ facts, loaded, mutate, reorder }: ProfileFacts) {
  const [tab, setTab] = useState<FactStatus>('proposed')

  const counts = useMemo(() => Object.fromEntries(TABS.map(({ status }) =>
    [status, facts.filter((fact) => fact.status === status).length])) as Record<FactStatus, number>, [facts])
  const groups = useMemo(() => group(facts.filter((fact) => fact.status === tab)), [facts, tab])
  const projectCount = groups.reduce((total, [, projects]) => total + projects.length, 0)
  const current = TABS.find((item) => item.status === tab)!

  const save = (fact: ProfileFact, body: Record<string, unknown>) => mutate(
    () => patchJSON(`/api/profile-facts/${fact.id}`, body),
    typeof body.status === 'string' ? MOVED[body.status as FactStatus] : 'Fact saved',
  )
  const remove = (fact: ProfileFact) => mutate(
    () => deleteJSON(`/api/profile-facts/${fact.id}`, { expected_updated_at: fact.updated_at }),
    'Fact deleted',
  )

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted-foreground">
        Atomic facts about your work, proposed by your agent. Your CV is written only from the ones you accept. Drag the
        handle to reorder facts within a project.
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
            <div className="flex flex-col items-center gap-2 rounded-md border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">
              <LightbulbIcon className="size-5" aria-hidden="true" />
              {current.empty}
            </div>
          )}

          {groups.length > 0 && (
            <div className="space-y-4">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <SparklesIcon className="size-3 text-primary" aria-hidden="true" />
                {plural(counts[tab], 'fact', 'facts')} · {plural(projectCount, 'project', 'projects')}
              </p>
              {groups.map(([company, projects]) => (
                <section key={company} className="space-y-1.5">
                  <h2 className="text-sm font-medium">{company}</h2>
                  <div className="space-y-1.5">
                    {projects.map(([project, items]) => (
                      <ProjectGroup
                        key={project}
                        project={project}
                        facts={items}
                        defaultOpen={projectCount === 1}
                        onReorder={(ordered) => void reorder(ordered)}
                        onSave={save}
                        onDelete={remove}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
