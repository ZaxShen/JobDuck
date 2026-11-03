import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { PlusIcon } from 'lucide-react'
import { SectionCard } from '@/components/composed/section-card'
import { FieldControl } from '@/components/fields/field-control'
import { LoadError, LoadSkeleton } from '@/components/load-states'
import { SaveBar } from '@/components/save-bar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { DocForm } from '@/hooks/use-doc-form'
import { go } from '@/hooks/use-hash-route'
import { profileEmpty } from '@/lib/docs'
import { CV_FILES, type Draft, type Group, visibleFields, withField } from '@/lib/forms'
import { getPath } from '@/lib/paths'
import { hashFor, profileSection } from '@/lib/routing'
import type { ProfileView as ProfileDoc } from '@/lib/types'
import { cn } from '@/lib/utils'
import { FactsView } from '@/views/facts/facts-view'
import { useProfileFacts, type ProfileFacts } from '@/views/facts/use-profile-facts'
import { FACTS_SLUG, profileSections, type SectionBody, type SectionGroup, type SectionItem } from '@/views/profile/profile-sections'

function Intake() {
  return (
    <SectionCard
      title="Fill In Your Profile"
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

const sectionsOf = (draft: Draft) => draft.sections as Record<string, string>
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function sectionDirty(body: SectionBody, draft: Draft, original: Draft): boolean {
  switch (body.kind) {
    case 'fields':
      return body.group.fields.some((field) => !same(getPath(draft, field.key), getPath(original, field.key)))
    case 'markdown':
      return (sectionsOf(draft)[body.name] ?? '') !== (sectionsOf(original)[body.name] ?? '')
    case 'documents':
      return CV_FILES.fields.some((field) => !same(getPath(draft, field.key), getPath(original, field.key)))
    default:
      return false
  }
}

interface NavProps {
  groups: SectionGroup[]
  active: string
  proposed: number
  dirty: Set<string>
}

function DirtyDot({ className }: { className: string }) {
  return (
    <>
      <span aria-hidden="true" className={cn('inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/70 align-middle', className)} />
      <span className="sr-only">, unsaved changes</span>
    </>
  )
}

function SectionLink({ item, active, proposed, dirty, className, dotClassName }: {
  item: SectionItem
  active: boolean
  proposed: number
  dirty: boolean
  className: string
  dotClassName: string
}) {
  return (
    <a
      href={hashFor({ view: 'profile', section: item.slug })}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'rounded-md text-sm outline-none transition-colors duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/50',
        className,
        active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      {item.label}
      {dirty && <DirtyDot className={dotClassName} />}
      {item.slug === FACTS_SLUG && proposed > 0 && (
        <Badge variant="secondary" className="ml-1.5 align-middle tabular-nums">
          {proposed}<span className="sr-only"> proposed</span>
        </Badge>
      )}
    </a>
  )
}

function SectionNav({ groups, active, proposed, dirty }: NavProps) {
  return (
    <nav aria-label="Profile sections" className="hidden lg:block w-48 shrink-0 space-y-4 lg:sticky lg:top-6 lg:self-start">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="mb-1.5 px-2 text-[11px] font-medium uppercase tracking-widest text-muted-foreground/50">{group.label}</p>
          <ul className="space-y-0.5">
            {group.items.map((item) => (
              <li key={item.slug}>
                <SectionLink
                  item={item}
                  active={item.slug === active}
                  proposed={proposed}
                  dirty={dirty.has(item.slug)}
                  className="block w-full px-2 py-1.5 text-left"
                  dotClassName="ml-1.5"
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}

function SectionPills({ groups, active, proposed, dirty }: NavProps) {
  return (
    <nav aria-label="Profile sections" className="relative overflow-x-auto lg:hidden">
      <div className="flex min-w-max items-center gap-1 pb-2">
        {groups.map((group, index) => (
          <Fragment key={group.label}>
            {index > 0 && <div aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />}
            {group.items.map((item) => (
              <SectionLink
                key={item.slug}
                item={item}
                active={item.slug === active}
                proposed={proposed}
                dirty={dirty.has(item.slug)}
                className="shrink-0 px-2.5 py-1"
                dotClassName="ml-1"
              />
            ))}
          </Fragment>
        ))}
      </div>
    </nav>
  )
}

function Section({ title, help, children }: { title: ReactNode; help?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{title}</h2>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
      {children}
    </section>
  )
}

function FieldsSection({ group, draft, onChange }: { group: Group; draft: Draft; onChange: (draft: Draft) => void }) {
  return (
    <Section title={group.title} help={group.help}>
      <div className="grid gap-3 sm:grid-cols-2">
        {visibleFields(group, draft).map((field) => (
          <FieldControl
            key={field.key}
            formName="profile"
            size="compact"
            field={field}
            value={getPath(draft, field.key)}
            onChange={(value) => onChange(withField(draft, field, value))}
          />
        ))}
      </div>
    </Section>
  )
}

function MarkdownSection({ name, hint, draft, onChange }: { name: string; hint: string; draft: Draft; onChange: (draft: Draft) => void }) {
  const sections = sectionsOf(draft)
  const id = `profile-section-${name.replace(/[^A-Za-z0-9]+/g, '-')}`
  return (
    <Section
      title={<label htmlFor={id}>{name}</label>}
      help="CVs, cover letters and answers are written only from what you put here. Real numbers beat adjectives."
    >
      <Textarea
        id={id}
        rows={12}
        placeholder={hint}
        value={sections[name] ?? ''}
        onChange={(event) => onChange({ ...draft, sections: { ...sections, [name]: event.target.value } })}
      />
    </Section>
  )
}

function AddSection({ draft, onChange }: { draft: Draft; onChange: (draft: Draft) => void }) {
  const [title, setTitle] = useState('')
  const sections = sectionsOf(draft)

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
    <Section title={<label htmlFor="profile-new-section">Add Section</label>} help="Add a section of your own to profile.md, e.g. Publications or Awards.">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          add()
        }}
      >
        <Input
          id="profile-new-section"
          placeholder="e.g. Publications…"
          autoComplete="off"
          className="max-w-xs"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" className="shrink-0 gap-1.5"><PlusIcon data-icon="inline-start" aria-hidden="true" />Add</Button>
      </form>
    </Section>
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
      return <FieldsSection group={body.group} draft={draft} onChange={onChange} />
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
      return <FieldsSection group={CV_FILES} draft={draft} onChange={onChange} />
  }
}

export function ProfileView({ form, active, section }: { form: DocForm<ProfileDoc>; active: boolean; section: string | null }) {
  const { loaded, load, view, draft, original, version, setDraft, loadError } = form

  useEffect(() => {
    if (active && !loaded) void load()
  }, [active, loaded, load])

  const names = useMemo(() => Object.keys((draft?.sections ?? {}) as Record<string, string>), [draft])
  const groups = useMemo(() => profileSections(names), [names])
  const items = useMemo(() => groups.flatMap((group) => group.items), [groups])
  const current = profileSection(section, items.map((item) => item.slug))
  const item = items.find((candidate) => candidate.slug === current)!
  const dirty = useMemo(
    () => new Set(draft && original ? items.filter((entry) => sectionDirty(entry.body, draft, original)).map((entry) => entry.slug) : []),
    [items, draft, original],
  )

  const facts = useProfileFacts(active, active && current === FACTS_SLUG)
  const proposed = facts.facts.filter((fact) => fact.status === 'proposed').length

  return (
    <div className="space-y-4 animate-in fade-in duration-500">
      <p className="max-w-2xl text-sm text-muted-foreground">
        Your career ground truth. Every skill reads this first, and your agent writes CVs and applications from it.
      </p>

      {loadError && <LoadError message={loadError} onRetry={() => void load()} />}

      {!view || !draft ? (!loadError && <LoadSkeleton />) : (
        <div key={version} className="space-y-4">
          {profileEmpty(view) && <Intake />}
          <div className="flex flex-col gap-6 lg:flex-row">
            <SectionNav groups={groups} active={current} proposed={proposed} dirty={dirty} />
            <SectionPills groups={groups} active={current} proposed={proposed} dirty={dirty} />
            <div className="min-w-0 flex-1 space-y-4">
              <SectionContent body={item.body} view={view} draft={draft} onChange={setDraft} facts={facts} />
              {item.body.kind !== 'facts' && (
                <SaveBar {...form} onSave={() => void form.save()} onDiscard={() => void load()} />
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Stored in {view.path}</p>
        </div>
      )}
    </div>
  )
}
