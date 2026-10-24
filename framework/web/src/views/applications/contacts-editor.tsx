import { PlusIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Contact } from '@/lib/types'

export const MAX_CONTACTS = 20
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const FIELDS = [
  ['title', 'Title (e.g. Recruiter)'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['linkedin', 'LinkedIn URL'],
] as const

export interface ContactRow {
  key: number
  name: string
  title: string
  email: string
  phone: string
  linkedin: string
}

let nextKey = 0

const blankRow = (): ContactRow => ({ key: nextKey++, name: '', title: '', email: '', phone: '', linkedin: '' })

export const toRows = (contacts: Contact[]): ContactRow[] => contacts.map((contact) => ({
  ...blankRow(),
  name: contact.name,
  title: contact.title ?? '',
  email: contact.email ?? '',
  phone: contact.phone ?? '',
  linkedin: contact.linkedin ?? '',
}))

export const toContacts = (rows: ContactRow[]): Contact[] =>
  rows.map(({ key: _key, ...contact }) => contact)

const emailInvalid = (row: ContactRow) => row.email.trim() !== '' && !EMAIL.test(row.email.trim())

export const contactsValid = (rows: ContactRow[]) =>
  rows.length <= MAX_CONTACTS && rows.every((row) => row.name.trim() !== '' && !emailInvalid(row))

interface ContactsEditorProps {
  id: string
  rows: ContactRow[]
  onChange: (rows: ContactRow[]) => void
}

export function ContactsEditor({ id, rows, onChange }: ContactsEditorProps) {
  const update = (index: number, patch: Partial<ContactRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Contacts</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={rows.length >= MAX_CONTACTS}
          onClick={() => onChange([...rows, blankRow()])}
        >
          <PlusIcon />
          Add contact
        </Button>
      </div>
      {rows.map((row, index) => (
        <div key={row.key} className="space-y-1.5 rounded-lg border p-2">
          <div className="flex items-center gap-2">
            <Input
              id={index === 0 ? id : undefined}
              aria-label="Name"
              aria-invalid={row.name.trim() === '' || undefined}
              placeholder="Name (required)"
              maxLength={200}
              value={row.name}
              onChange={(event) => update(index, { name: event.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Remove contact"
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              <Trash2Icon />
            </Button>
          </div>
          {FIELDS.map(([field, placeholder]) => (
            <Input
              key={field}
              aria-label={placeholder}
              aria-invalid={(field === 'email' && emailInvalid(row)) || undefined}
              placeholder={placeholder}
              type={field === 'email' ? 'email' : 'text'}
              value={row[field]}
              onChange={(event) => update(index, { [field]: event.target.value })}
            />
          ))}
          {emailInvalid(row) && <p className="text-xs text-destructive">Email is invalid</p>}
        </div>
      ))}
    </div>
  )
}
