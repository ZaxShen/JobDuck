import { useEffect, useState } from 'react'
import { PlusIcon } from 'lucide-react'
import { SectionCard } from '@/components/composed/section-card'
import { FormGroups } from '@/components/form-groups'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { DocForm } from '@/hooks/use-doc-form'
import { profileEmpty } from '@/lib/docs'
import { CV_FILES, PROFILE_GROUPS, type Draft } from '@/lib/forms'
import type { ProfileView as ProfileDoc } from '@/lib/types'

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

function Sections({ view, draft, onChange }: { view: ProfileDoc; draft: Draft; onChange: (draft: Draft) => void }) {
  const [title, setTitle] = useState('')
  const sections = draft.sections as Record<string, string>
  const hints = Object.fromEntries(view.sections.map((section) => [section.title, section.hint]))

  const add = () => {
    const name = title.trim().replace(/^#+\s*/, '')
    setTitle('')
    if (!name || Object.keys(sections).some((existing) => existing.toLowerCase() === name.toLowerCase())) return
    onChange({ ...draft, sections: { ...sections, [name]: '' } })
  }

  return (
    <SectionCard
      title="Background"
      description="CVs, cover letters and answers are written only from what you put here. Real numbers beat adjectives."
    >
      <div className="space-y-4">
        {Object.entries(sections).map(([name, content]) => {
          const id = `profile-section-${name.replace(/[^A-Za-z0-9]+/g, '-')}`
          return (
            <div key={name} className="space-y-1.5">
              <Label htmlFor={id}>{name}</Label>
              <Textarea
                id={id}
                rows={7}
                placeholder={hints[name] ?? ''}
                value={content}
                onChange={(event) => onChange({ ...draft, sections: { ...sections, [name]: event.target.value } })}
              />
            </div>
          )
        })}
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
          <Button type="submit" variant="outline"><PlusIcon />Add section</Button>
        </form>
      </div>
    </SectionCard>
  )
}

export function ProfileView({ form, active }: { form: DocForm<ProfileDoc>; active: boolean }) {
  const { loaded, load, view, draft, version, setDraft } = form

  useEffect(() => {
    if (active && !loaded) void load()
  }, [active, loaded, load])

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <p className="text-sm text-muted-foreground">Who you are and what you want. Every skill reads this first.</p>
      {view && draft && (
        <div key={version} className="space-y-6">
          {profileEmpty(view) && <Intake />}
          <FormGroups name="profile" groups={PROFILE_GROUPS} draft={draft} onChange={setDraft} />
          <Sections view={view} draft={draft} onChange={setDraft} />
          <FormGroups name="profile" groups={[CV_FILES]} draft={draft} onChange={setDraft} />
          <p className="text-xs text-muted-foreground">Stored in {view.path}</p>
        </div>
      )}
    </div>
  )
}
