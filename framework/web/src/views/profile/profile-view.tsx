import { Fragment, useEffect, useMemo, useState } from 'react'
import { PlusIcon } from 'lucide-react'
import { SectionCard } from '@/components/composed/section-card'
import { FormGroups } from '@/components/form-groups'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import type { DocForm } from '@/hooks/use-doc-form'
import { go } from '@/hooks/use-hash-route'
import { profileEmpty } from '@/lib/docs'
import { CV_FILES, type Draft } from '@/lib/forms'
import { hashFor, profileSection } from '@/lib/routing'
import type { ProfileView as ProfileDoc } from '@/lib/types'
import { cn } from '@/lib/utils'
import { FactsView } from '@/views/facts/facts-view'
import { useProfileFacts, type ProfileFacts } from '@/views/facts/use-profile-facts'
import { FACTS_SLUG, profileSections, type SectionBody, type SectionGroup, type SectionItem } from '@/views/profile/profile-sections'

function Intake() {
  return (
    <SectionCard
      title="Fill in your profile"
      description="Pick whichever is quickest. For the first two, your agent fills this form and you review it here."
      className="bg-muted/40"
    >
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li><strong>Import a resume.</strong> Put your CV (PDF, Word or Markdown) in the <code className="rounded bg-muted px-1">inbox/</code> folder of your Job Duck workspace, then tell your agent "import my resume".</li>
        <li><strong>Import LinkedIn.</strong> On your LinkedIn profile, choose More, then Save to PDF. Put the file in <code className="rounded bg-muted px-1">inbox/</code> and tell your agent "import my LinkedIn".</li>
        <li><strong>Type it in.</strong> Fill in the form below and press Save.</li>
      </ol>
    </SectionCard>
  )
}

interface NavProps {
  groups: SectionGroup[]
  active: string
  proposed: number
}

function ProposedBadge({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <Badge variant="secondary" className="tabular-nums">
      {count}<span className="sr-only"> proposed</span>
    </Badge>
  )
}

function SectionLink({ item, active, proposed, className }: { item: SectionItem; active: boolean; proposed: number; className: string }) {
  return (
    <a
      href={hashFor({ view: 'profile', section: item.slug })}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2 rounded-md text-sm outline-none transition-colors duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/50',
        className,
        active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <span className="truncate">{item.label}</span>
      {item.slug === FACTS_SLUG && <ProposedBadge count={proposed} />}
    </a>
  )
}

function SectionNav({ groups, active, proposed }: NavProps) {
  return (
    <nav aria-label="Profile sections" className="hidden w-48 shrink-0 flex-col gap-4 lg:sticky lg:top-6 lg:flex lg:self-start">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="mb-1.5 px-2 text-[11px] font-medium uppercase tracking-widest text-muted-foreground/50">{group.label}</p>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => (
              <li key={item.slug}>
                <SectionLink item={item} active={item.slug === active} proposed={proposed} className="w-full justify-between px-2 py-1.5" />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}

function SectionPills({ groups, active, proposed }: NavProps) {
  return (
    <nav aria-label="Profile sections" className="overflow-x-auto lg:hidden">
      <div className="flex min-w-max items-center gap-1 pb-2">
        {groups.map((group, index) => (
          <Fragment key={group.label}>
            {index > 0 && <Separator orientation="vertical" className="mx-1 data-vertical:h-4 data-vertical:self-center" />}
            {group.items.map((item) => (
              <SectionLink key={item.slug} item={item} active={item.slug === active} proposed={proposed} className="shrink-0 px-2.5 py-1" />
            ))}
          </Fragment>
        ))}
      </div>
    </nav>
  )
}

function MarkdownSection({ name, hint, draft, onChange }: { name: string; hint: string; draft: Draft; onChange: (draft: Draft) => void }) {
  const sections = draft.sections as Record<string, string>
  const id = `profile-section-${name.replace(/[^A-Za-z0-9]+/g, '-')}`
  return (
    <SectionCard
      title={<Label htmlFor={id}>{name}</Label>}
      description="CVs, cover letters and answers are written only from what you put here. Real numbers beat adjectives."
    >
      <Textarea
        id={id}
        rows={12}
        placeholder={hint}
        value={sections[name] ?? ''}
        onChange={(event) => onChange({ ...draft, sections: { ...sections, [name]: event.target.value } })}
      />
    </SectionCard>
  )
}

function AddSection({ draft, onChange }: { draft: Draft; onChange: (draft: Draft) => void }) {
  const [title, setTitle] = useState('')
  const sections = draft.sections as Record<string, string>

  const add = () => {
    const name = title.trim().replace(/^#+\s*/, '')
    setTitle('')
    if (!name || Object.keys(sections).some((existing) => existing.toLowerCase() === name.toLowerCase())) return
    const next = { ...sections, [name]: '' }
    onChange({ ...draft, sections: next })
    const added = profileSections(Object.keys(next)).flatMap((group) => group.items)
      .find((item) => item.body.kind === 'markdown' && item.body.name === name)
    if (added) go('profile', added.slug)
  }

  return (
    <SectionCard title="Add section" description="Add a section of your own to profile.md, e.g. Publications or Awards.">
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault()
          add()
        }}
      >
        <Input
          placeholder="New section title, e.g. Publications"
          aria-label="New section title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Button type="submit" variant="outline"><PlusIcon data-icon="inline-start" />Add section</Button>
      </form>
    </SectionCard>
  )
}

interface BodyProps {
  body: SectionBody
  view: ProfileDoc
  draft: Draft
  onChange: (draft: Draft) => void
  facts: ProfileFacts
}

function SectionContent({ body, view, draft, onChange, facts }: BodyProps) {
  switch (body.kind) {
    case 'fields':
      return <FormGroups name="profile" groups={[body.group]} draft={draft} onChange={onChange} />
    case 'markdown':
      return (
        <MarkdownSection
          name={body.name}
          hint={view.sections.find((section) => section.title === body.name)?.hint ?? ''}
          draft={draft}
          onChange={onChange}
        />
      )
    case 'add':
      return <AddSection draft={draft} onChange={onChange} />
    case 'facts':
      return <FactsView {...facts} />
    case 'documents':
      return <FormGroups name="profile" groups={[CV_FILES]} draft={draft} onChange={onChange} />
  }
}

export function ProfileView({ form, active, section }: { form: DocForm<ProfileDoc>; active: boolean; section: string | null }) {
  const { loaded, load, view, draft, version, setDraft } = form

  useEffect(() => {
    if (active && !loaded) void load()
  }, [active, loaded, load])

  const names = useMemo(() => Object.keys((draft?.sections ?? {}) as Record<string, string>), [draft])
  const groups = useMemo(() => profileSections(names), [names])
  const items = useMemo(() => groups.flatMap((group) => group.items), [groups])
  const current = profileSection(section, items.map((item) => item.slug))
  const item = items.find((candidate) => candidate.slug === current)!

  const facts = useProfileFacts(active, active && current === FACTS_SLUG)
  const proposed = facts.facts.filter((fact) => fact.status === 'proposed').length

  return (
    <div className="flex flex-col gap-6 animate-in fade-in duration-500">
      <p className="text-sm text-muted-foreground">Who you are and what you want. Every skill reads this first.</p>
      {view && draft && (
        <div key={version} className="flex flex-col gap-6">
          {profileEmpty(view) && <Intake />}
          <div className="flex flex-col gap-6 lg:flex-row">
            <SectionNav groups={groups} active={current} proposed={proposed} />
            <SectionPills groups={groups} active={current} proposed={proposed} />
            <div className="flex min-w-0 flex-1 flex-col gap-6">
              <SectionContent body={item.body} view={view} draft={draft} onChange={setDraft} facts={facts} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Stored in {view.path}</p>
        </div>
      )}
    </div>
  )
}
