'use strict'

const POLL_MS = 30000
const VIEWS = ['applications', 'profile', 'settings', 'welcome']
const state = { statuses: [], terminal: [], filter: '', q: '', selected: null, rows: [], view: 'applications' }
const $ = (id) => document.getElementById(id)

function h(tag, props, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value)
    else if (key === 'className') el.className = value
    else el.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

const label = (status) => status.replace(/_/g, ' ')
const day = (iso) => (iso ? new Date(iso).toLocaleDateString() : '')
const stamp = (iso) => (iso ? new Date(iso).toLocaleString() : '')

function showMessage(text, isError) {
  const el = $('message')
  el.textContent = text
  el.className = isError ? 'message error' : 'message'
  el.hidden = false
  clearTimeout(showMessage.timer)
  showMessage.timer = setTimeout(() => { el.hidden = true }, isError ? 8000 : 2500)
}

async function api(path, options) {
  const init = { method: 'GET', headers: {}, ...options }
  if (init.method !== 'GET') {
    init.headers['X-JobDuck-Dashboard'] = '1'
    if (init.body !== undefined) {
      init.headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(init.body)
    }
  }
  const res = await fetch(path, init)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = new Error(data.error || `${res.status} ${res.statusText}`)
    error.status = res.status
    throw error
  }
  return data
}

async function guarded(fn) {
  try {
    return await fn()
  } catch (error) {
    showMessage(error.message, true)
    return undefined
  }
}

function renderChips(summary) {
  const total = Object.values(summary.counts).reduce((a, b) => a + b, 0)
  const chip = (value, text, n) => h('button', {
    type: 'button',
    className: state.filter === value ? 'chip active' : 'chip',
    onclick: () => { state.filter = value; refresh() },
  }, text, h('span', { className: 'n' }, n))
  $('chips').replaceChildren(
    chip('', 'All', total),
    ...state.statuses.map((status) => chip(status, label(status), summary.counts[status] || 0)),
  )
}

function renderRows() {
  $('rows').replaceChildren(...state.rows.map((row) => h('tr', {
    className: row.id === state.selected ? 'selected' : '',
    'data-id': row.id,
    onclick: () => openDrawer(row.id),
  },
  h('td', null, row.company),
  h('td', null, row.title),
  h('td', null, row.location || ''),
  h('td', null, h('span', { className: `badge ${row.status}` }, label(row.status))),
  h('td', null, day(row.applied_at)),
  h('td', null, day(row.updated_at)))))
  $('empty').hidden = state.rows.length > 0
}

function applicationQuery(params) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value)
  const text = query.toString()
  return `/api/applications${text ? `?${text}` : ''}`
}

async function loadBoard() {
  const [summary, rows] = await Promise.all([
    api('/api/summary'),
    api(applicationQuery({ status: state.filter, q: state.q })),
  ])
  state.rows = rows
  renderChips(summary)
  renderRows()
}

function renderPicker(outcome) {
  const search = h('input', { type: 'search', placeholder: 'Search by company or title' })
  const select = h('select', { 'aria-label': 'Application' })
  const fill = async (q) => {
    const rows = await guarded(() => api(applicationQuery({ q, limit: '50' })))
    if (!rows) return
    select.replaceChildren(
      h('option', { value: '' }, rows.length ? 'Choose an application' : 'No matching applications'),
      ...rows.map((row) => h('option', { value: row.id }, `${row.company} — ${row.title} (${label(row.status)})`)),
    )
  }
  let timer
  search.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(() => fill(search.value.trim()), 200)
  })
  search.value = outcome.company || ''
  fill(search.value)
  return { picker: h('div', { className: 'picker' }, search, select), select }
}

function renderOutcome(outcome) {
  const { picker, select } = renderPicker(outcome)
  const match = h('button', {
    type: 'button',
    className: 'primary',
    onclick: () => guarded(async () => {
      if (!select.value) throw new Error('Choose an application to match')
      await api(`/api/outcomes/${outcome.id}/match`, { method: 'POST', body: { application_id: Number(select.value) } })
      showMessage('Matched; application closed as deny by employer.')
      await refresh()
    }),
  }, 'Match')
  const dismiss = h('button', {
    type: 'button',
    onclick: () => guarded(async () => {
      await api(`/api/outcomes/${outcome.id}/dismiss`, { method: 'POST' })
      await refresh()
    }),
  }, 'Dismiss')
  return h('li', { className: 'outcome' },
    h('div', { className: 'what' },
      h('strong', null, outcome.company || 'Unknown company'),
      h('span', null, outcome.title || outcome.job_ref || ''),
      h('span', { className: 'when' }, `Received ${stamp(outcome.received_at)}`)),
    picker, match, dismiss)
}

async function loadOutcomes() {
  const outcomes = await api('/api/outcomes?status=needs_match')
  const list = $('outcome-list')
  const busy = list.contains(document.activeElement)
  if (busy) return
  list.replaceChildren(...outcomes.map(renderOutcome))
  $('outcomes').hidden = outcomes.length === 0
}

function renderTimeline(events) {
  $('timeline').replaceChildren(...events.slice().reverse().map((event) => h('li', null,
    h('div', null, event.from_status ? `${label(event.from_status)} → ${label(event.to_status)}` : `Created as ${label(event.to_status)}`),
    event.note ? h('div', null, event.note) : null,
    h('div', { className: 'meta' }, `${stamp(event.created_at)} · ${event.source}`))))
}

function fillDrawer(application, events) {
  $('drawer-title').textContent = `${application.company} — ${application.title}`
  $('drawer-sub').textContent = [application.location, application.work_mode].filter(Boolean).join(' · ')
  const link = $('drawer-link')
  let safe = false
  try { safe = ['http:', 'https:'].includes(new URL(application.url).protocol) } catch { safe = false }
  link.hidden = !safe
  if (safe) link.href = application.url
  $('f-status').value = application.status
  $('f-note').value = application.note || ''
  for (const field of ['title', 'company', 'location']) {
    const input = $(`f-${field}_override`)
    input.value = application[`${field}_override`] || ''
    input.placeholder = application[`posting_${field}`] || ''
  }
  renderTimeline(events)
}

async function openDrawer(id) {
  const data = await guarded(() => api(`/api/applications/${id}`))
  if (!data) return
  state.selected = id
  fillDrawer(data.application, data.events)
  $('drawer').hidden = false
  renderRows()
}

function closeDrawer() {
  state.selected = null
  $('drawer').hidden = true
  renderRows()
}

async function patchSelected(body, message) {
  const id = state.selected
  if (id === null) return
  const saved = await guarded(() => api(`/api/applications/${id}`, { method: 'PATCH', body }))
  if (!saved) return
  const data = await guarded(() => api(`/api/applications/${id}`))
  if (data && state.selected === id) fillDrawer(data.application, data.events)
  showMessage(message)
  await refresh()
}

function bindDrawer() {
  $('f-status').replaceChildren(...state.statuses.map((status) => h('option', { value: status },
    state.terminal.includes(status) ? `${label(status)} (closed)` : label(status))))
  $('f-status').addEventListener('change', (event) => patchSelected({ status: event.target.value }, 'Status updated.'))
  $('f-note').addEventListener('blur', (event) => {
    const current = state.rows.find((row) => row.id === state.selected)
    if (current && (current.note || '') === event.target.value) return
    patchSelected({ note: event.target.value }, 'Note saved.')
  })
  for (const field of ['title_override', 'company_override', 'location_override']) {
    $(`f-${field}`).addEventListener('change', (event) => patchSelected({ [field]: event.target.value }, 'Saved.'))
  }
  $('drawer-close').addEventListener('click', closeDrawer)
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('drawer').hidden) closeDrawer() })
  $('delete').addEventListener('click', () => guarded(async () => {
    const id = state.selected
    if (id === null || !window.confirm('Delete this application? It disappears from the board.')) return
    await api(`/api/applications/${id}`, { method: 'DELETE' })
    closeDrawer()
    showMessage('Application deleted.')
    await refresh()
  }))
}

function refresh() {
  return guarded(() => Promise.all([loadBoard(), loadOutcomes()]))
}

const clone = (value) => JSON.parse(JSON.stringify(value))
const getPath = (obj, path) => path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), obj)

function setPath(obj, path, value) {
  const keys = path.split('.')
  const last = keys.pop()
  let node = obj
  for (const key of keys) {
    if (node[key] == null || typeof node[key] !== 'object') node[key] = {}
    node = node[key]
  }
  node[last] = value
}

const splitList = (text) => text.split(/[,\n]/).map((part) => part.trim()).filter(Boolean)

function tagInput(id, values, field, set) {
  const tags = [...values]
  const list = h('span', { className: 'tag-list' })
  const listId = field.suggest ? `${id}-options` : undefined
  const input = h('input', { type: 'text', id, list: listId, autocomplete: 'off', placeholder: field.placeholder || 'Type, then press Enter' })
  const commit = () => set([...tags])
  const draw = () => list.replaceChildren(...tags.map((tag, index) => h('span', { className: 'tag' }, tag,
    h('button', {
      type: 'button',
      className: 'tag-x',
      'aria-label': `Remove ${tag}`,
      onclick: (event) => { event.stopPropagation(); tags.splice(index, 1); draw(); commit() },
    }, '×'))))
  const add = (text) => {
    const fresh = splitList(text).filter((tag) => !tags.includes(tag))
    if (fresh.length === 0) return
    tags.push(...fresh)
    draw()
    commit()
  }
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      add(input.value)
      input.value = ''
    } else if (event.key === 'Backspace' && input.value === '' && tags.length > 0) {
      tags.pop()
      draw()
      commit()
    }
  })
  input.addEventListener('input', (event) => {
    if (event.inputType === undefined || event.inputType === 'insertReplacementText') {
      if (field.suggest && field.suggest.includes(input.value)) { add(input.value); input.value = '' }
    }
  })
  input.addEventListener('blur', () => { add(input.value); input.value = '' })
  draw()
  return h('div', { className: 'tags', onclick: () => input.focus() }, list, input,
    field.suggest ? h('datalist', { id: listId }, ...field.suggest.map((value) => h('option', { value }))) : null)
}

function checkGroup(id, values, options, set) {
  const known = options.map(([value]) => value)
  const chosen = new Set(values)
  return h('div', { className: 'checks', id, role: 'group' }, ...options.map(([value, text]) => {
    const box = h('input', { type: 'checkbox', value })
    box.checked = chosen.has(value)
    box.addEventListener('change', () => {
      if (box.checked) chosen.add(value)
      else chosen.delete(value)
      set([...known.filter((v) => chosen.has(v)), ...[...chosen].filter((v) => !known.includes(v))])
    })
    return h('label', { className: 'check' }, box, h('span', null, text))
  }))
}

function rowList(id, rows, columns, addLabel, write) {
  const body = h('div', { className: 'rows-list', id })
  const draw = () => body.replaceChildren(
    ...rows.map((row, index) => h('div', { className: 'pair' },
      ...columns.map((column) => {
        const input = h('input', { type: 'text', placeholder: column.placeholder, 'aria-label': column.label })
        input.value = row[column.name] || ''
        input.addEventListener('input', () => { row[column.name] = input.value; write(rows) })
        return input
      }),
      h('button', {
        type: 'button', className: 'ghost', 'aria-label': 'Remove row',
        onclick: () => { rows.splice(index, 1); draw(); write(rows) },
      }, 'Remove'))),
    h('button', {
      type: 'button', className: 'ghost add',
      onclick: () => { rows.push(Object.fromEntries(columns.map((column) => [column.name, '']))); draw() },
    }, addLabel))
  draw()
  return body
}

function control(form, field, id) {
  const value = getPath(form.draft, field.key)
  const set = (next) => {
    setPath(form.draft, field.key, next)
    if (field.after) field.after(form, next)
    changed(form)
  }
  switch (field.type) {
    case 'checkbox': {
      const input = h('input', { type: 'checkbox', id })
      input.checked = Boolean(value)
      input.addEventListener('change', () => set(input.checked))
      return input
    }
    case 'select': {
      const select = h('select', { id }, ...field.options.map(([v, text]) => h('option', { value: v }, text)))
      select.value = value
      select.addEventListener('change', () => set(select.value))
      return select
    }
    case 'number': {
      const min = field.min ?? 0
      const input = h('input', { type: 'number', id, min, step: field.step || 1, placeholder: field.placeholder })
      input.value = value ? String(value) : ''
      input.addEventListener('input', () => set(input.value === '' ? min : Number(input.value)))
      return input
    }
    case 'tags':
      return tagInput(id, value || [], field, set)
    case 'checks':
      return checkGroup(id, value || [], field.options, set)
    case 'record':
      return rowList(id, Object.entries(value || {}).map(([k, v]) => ({ key: k, value: v })), field.columns, field.addLabel,
        (rows) => set(Object.fromEntries(rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]))))
    case 'list':
      return rowList(id, (value || []).map((row) => ({ ...row })), field.columns, field.addLabel,
        (rows) => set(rows.filter((row) => field.columns.some((column) => row[column.name].trim())).map((row) => ({ ...row }))))
    case 'textarea': {
      const area = h('textarea', { id, rows: field.rows || 6, placeholder: field.placeholder })
      area.value = value || ''
      area.addEventListener('input', () => set(area.value))
      return area
    }
    default: {
      const input = h('input', {
        type: field.type || 'text', id, placeholder: field.placeholder, autocomplete: field.autocomplete || 'off',
      })
      input.value = value || ''
      input.addEventListener('input', () => set(input.value))
      return input
    }
  }
}

function fieldRow(form, field) {
  const id = `${form.name}-${field.key.replace(/[^A-Za-z0-9]+/g, '-')}`
  const input = control(form, field, id)
  const help = field.help ? h('small', null, field.help) : null
  const row = field.type === 'checkbox'
    ? h('div', { className: 'field check-field' }, h('label', { className: 'check' }, input, h('span', null, field.label)), help)
    : h('div', { className: field.wide ? 'field wide' : 'field' }, h('label', { for: id }, field.label), input, help)
  if (field.when) form.conditional.push([row, field.when])
  return row
}

function groupPanel(form, group) {
  const panel = h('section', { className: 'panel group' },
    h('h2', null, group.title),
    group.help ? h('p', { className: 'hint' }, group.help) : null,
    h('div', { className: 'grid' }, ...group.fields.map((field) => fieldRow(form, field))))
  if (group.when) form.conditional.push([panel, group.when])
  return panel
}

function updateVisibility(form) {
  for (const [el, when] of form.conditional) el.hidden = !when(form.draft)
}

const isDirty = (form) => form.loaded && JSON.stringify(form.draft) !== JSON.stringify(form.original)

function changed(form) {
  updateVisibility(form)
  updateSavebar()
}

function updateSavebar() {
  const form = forms[state.view]
  $('savebar').hidden = !(form && isDirty(form))
}

const fm = (key, label, extra) => ({ key: `front_matter.${key}`, label, ...extra })
const choices = (...pairs) => pairs

const PROFILE_GROUPS = [
  {
    title: 'Contact',
    help: 'Used on applications and at the top of your CV.',
    fields: [
      fm('name', 'Full name', { autocomplete: 'name', placeholder: 'As it should appear on applications' }),
      fm('email', 'Email', { type: 'email', autocomplete: 'email' }),
      fm('phone', 'Phone', { type: 'tel', autocomplete: 'tel' }),
      fm('location', 'Where you live', { placeholder: 'City, region, country' }),
      fm('links.linkedin', 'LinkedIn', { type: 'url', placeholder: 'https://www.linkedin.com/in/…' }),
      fm('links.github', 'GitHub', { type: 'url', placeholder: 'https://github.com/…' }),
      fm('links.portfolio', 'Portfolio or website', { type: 'url', placeholder: 'https://…' }),
    ],
  },
  {
    title: 'Work eligibility',
    fields: [
      fm('work_authorization', 'Work authorization', { placeholder: 'In plain words, e.g. citizen, permanent resident, work visa' }),
      fm('sponsorship_required', 'I need visa sponsorship', { type: 'checkbox' }),
      fm('relocation', 'Open to relocating', { type: 'select', options: choices(['ask', 'Ask me each time'], ['yes', 'Yes'], ['no', 'No']) }),
      fm('start_date', 'Earliest start', { placeholder: 'e.g. immediately, two weeks after an offer' }),
      fm('education_level', 'Highest education', { placeholder: "e.g. Bachelor's degree" }),
      fm('years_experience', 'Years of experience', { type: 'number', step: 0.5 }),
    ],
  },
  {
    title: "What you're looking for",
    help: 'The find and apply skills filter postings with these. Press Enter after each item.',
    fields: [
      fm('target_titles', 'Target titles', { type: 'tags', wide: true, placeholder: 'e.g. Software Engineer' }),
      fm('seniority', 'Seniority', { type: 'tags', suggest: ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director'] }),
      fm('work_modes', 'Work modes', { type: 'checks', options: choices(['remote', 'Remote'], ['hybrid', 'Hybrid'], ['onsite', 'On-site']) }),
      fm('countries', 'Countries', { type: 'tags', placeholder: 'ISO codes, e.g. US' }),
      fm('locations', 'Cities or regions', { type: 'tags' }),
      fm('pay_floor', 'Minimum yearly pay', { type: 'number', step: 1000, help: 'Postings below this are skipped. 0 means no floor.' }),
      fm('currency', 'Currency', { placeholder: 'e.g. USD' }),
      fm('company_stages', 'Company stages', { type: 'tags', suggest: ['seed', 'series_a', 'series_b', 'series_c', 'growth', 'public'] }),
      fm('deal_breakers', 'Deal-breakers', { type: 'tags', wide: true, placeholder: 'e.g. on-call rotation' }),
      fm('skip_companies', 'Companies to skip', { type: 'tags', wide: true }),
    ],
  },
]

const CV_FILES = {
  title: 'CV files',
  help: 'Stock CVs the apply skill uploads. The first whose pattern matches the job title is used.',
  fields: [{
    key: 'front_matter.cv_files', label: 'Files', type: 'list', wide: true, addLabel: 'Add a CV file',
    columns: [
      { name: 'match', label: 'Job title pattern', placeholder: 'Job title pattern, e.g. engineer' },
      { name: 'path', label: 'File path', placeholder: 'Absolute path to the PDF' },
    ],
  }],
}

const MODULES = [
  ['cv', 'CV', 'Write and tailor CVs from your profile.'],
  ['find', 'Find', 'Search for postings that fit you.'],
  ['track', 'Track', 'Keep applications in the local database and this dashboard.'],
  ['apply', 'Apply', 'Fill in and submit applications in your browser. Turns on Find and Track.'],
  ['interview', 'Interview', 'Prepare for interviews on tracked applications.'],
]

const applyOn = (draft) => draft.modules.apply

const SETTINGS_GROUPS = [
  {
    title: 'Modules',
    help: 'Nothing runs until its module is on.',
    fields: MODULES.map(([key, label, help]) => ({
      key: `modules.${key}`, label, help, type: 'checkbox',
      after: key === 'apply'
        ? (form, on) => {
          if (!on) return
          for (const other of ['find', 'track']) {
            form.draft.modules[other] = true
            const box = $(`settings-modules-${other}`)
            if (box) box.checked = true
          }
        }
        : undefined,
    })),
  },
  {
    title: 'Applying',
    when: applyOn,
    fields: [
      { key: 'apply.autonomy', label: 'Before submitting', type: 'select', options: choices(['confirm_each', 'Ask me before every submission'], ['confirm_batch', 'Ask me once per batch'], ['auto_after_approvals', 'Submit on its own after enough approvals']) },
      { key: 'apply.approvals_before_auto', label: 'Approvals before submitting on its own', type: 'number', min: 1, when: (d) => d.apply.autonomy === 'auto_after_approvals' },
      { key: 'apply.max_per_run', label: 'Most applications per run', type: 'number', min: 1 },
      { key: 'apply.uploads', label: 'Files it may upload', type: 'checks', options: choices(['cv', 'CV'], ['cover_letter', 'Cover letter'], ['portfolio', 'Portfolio'], ['transcript', 'Transcript']) },
      { key: 'apply.cover_letter', label: 'Cover letters', type: 'select', options: choices(['only_when_required', 'Only when required'], ['never', 'Never'], ['always', 'Always']) },
      { key: 'apply.tailor_cv', label: 'Tailor the CV', type: 'select', options: choices(['never', 'Never, use my stock CV'], ['when_bottleneck', 'Only when the stock CV hides a must-have'], ['always', 'Always']) },
      { key: 'apply.free_text', label: 'Free-text questions', type: 'select', options: choices(['draft_for_approval', 'Draft an answer for me to approve'], ['auto_from_profile', 'Answer from my profile'], ['never', 'Stop and ask me']) },
      { key: 'apply.eeo', label: 'Demographic questions', type: 'select', options: choices(['decline', 'Decline to self-identify'], ['from_profile', 'Answer from my saved answers']) },
      { key: 'apply.ats_accounts', label: 'Job-site accounts', type: 'select', options: choices(['never', 'Stop when a site needs an account'], ['reuse', 'I sign in to accounts I already have'], ['create', 'Create one with my email; I set the password']) },
      { key: 'apply.marker', label: 'Add a tracking line to an optional free-text field', type: 'checkbox', help: 'Lets a later email be matched to the application.' },
      { key: 'apply.skip_companies', label: 'Companies never to apply to', type: 'tags', wide: true },
    ],
  },
  {
    title: 'Salary questions',
    when: applyOn,
    fields: [
      { key: 'apply.salary_mode', label: 'How to answer', type: 'select', options: choices(['leave_blank', 'Leave blank; ask me when required'], ['posting_range_upper', "Upper part of the posting's range"], ['fixed', 'Fixed numbers']) },
      { key: 'apply.salary_floor', label: 'Never below', type: 'number', step: 1000, when: (d) => d.apply.salary_mode === 'posting_range_upper' },
      { key: 'apply.salary_fixed_total', label: 'Total compensation', type: 'number', step: 1000, when: (d) => d.apply.salary_mode !== 'leave_blank' },
      { key: 'apply.salary_fixed_base', label: 'Base salary', type: 'number', step: 1000, when: (d) => d.apply.salary_mode === 'fixed' },
    ],
  },
  {
    title: 'Consents it may give',
    help: 'Checked boxes are agreed to without asking. Unchecked means the agent stops and asks you each time.',
    when: applyOn,
    fields: [
      ['privacy_policy', 'Privacy policy'], ['terms', 'Terms of use'], ['arbitration', 'Arbitration agreements'],
      ['background_check', 'Background checks'], ['e_signature', 'Electronic signature'], ['marketing_opt_in', 'Marketing emails'],
    ].map(([key, label]) => ({ key: `apply.consents.${key}`, label, type: 'checkbox' })),
  },
  {
    title: 'Saved answers',
    help: 'Answers to questions forms ask often, such as "How did you hear about us?".',
    when: applyOn,
    fields: [{
      key: 'apply.answers', label: 'Answers', type: 'record', wide: true, addLabel: 'Add an answer',
      columns: [{ name: 'key', label: 'Question', placeholder: 'Question' }, { name: 'value', label: 'Answer', placeholder: 'Answer' }],
    }],
  },
  {
    title: 'Email sync',
    help: 'From the Apps Script web app you deploy for tracking. Ask your agent to "set up tracking" for the steps.',
    when: (d) => d.modules.track,
    fields: [
      { key: 'track.sync_url', label: 'Web app URL', type: 'url', wide: true, placeholder: 'https://script.google.com/macros/s/…/exec' },
      { key: 'track.sync_token', label: 'Token', type: 'password', autocomplete: 'new-password' },
    ],
  },
  {
    title: 'CVs',
    when: (d) => d.modules.cv,
    fields: [{ key: 'cv.page_limit', label: 'Page limit', type: 'number', min: 1 }],
  },
]

function sectionsPanel(form) {
  const list = h('div', { className: 'sections' })
  const draw = () => list.replaceChildren(...form.sectionMeta.map((section) => {
    const id = `profile-section-${section.title.replace(/[^A-Za-z0-9]+/g, '-')}`
    const area = h('textarea', { id, rows: 7, placeholder: section.hint || '' })
    area.value = form.draft.sections[section.title] || ''
    area.addEventListener('input', () => { form.draft.sections[section.title] = area.value; changed(form) })
    return h('div', { className: 'field wide' }, h('label', { for: id }, section.title), area)
  }))
  const title = h('input', { type: 'text', placeholder: 'New section title, e.g. Publications', 'aria-label': 'New section title' })
  const add = h('button', {
    type: 'button',
    className: 'ghost',
    onclick: () => {
      const name = title.value.trim().replace(/^#+\s*/, '')
      if (!name) return
      if (!form.sectionMeta.some((section) => section.title.toLowerCase() === name.toLowerCase())) {
        form.sectionMeta.push({ title: name, hint: '' })
        form.draft.sections[name] = ''
        draw()
        changed(form)
      }
      title.value = ''
    },
  }, 'Add section')
  draw()
  return h('section', { className: 'panel group' },
    h('h2', null, 'Background'),
    h('p', { className: 'hint' }, 'CVs, cover letters and answers are written only from what you put here. Real numbers beat adjectives.'),
    list,
    h('div', { className: 'add-section' }, title, add))
}

function profileEmpty(view) {
  const front = view.front_matter
  return !front.name && !front.email && view.sections.every((section) => !section.content.trim())
}

const forms = {
  profile: {
    name: 'profile',
    url: '/api/profile',
    loaded: false,
    conditional: [],
    fromView(view) {
      this.sectionMeta = view.sections.map((section) => ({ title: section.title, hint: section.hint }))
      return { front_matter: view.front_matter, sections: Object.fromEntries(view.sections.map((s) => [s.title, s.content])) }
    },
    body() {
      const sections = Object.fromEntries(Object.entries(this.draft.sections)
        .filter(([title, content]) => content !== (this.original.sections[title] ?? '')))
      return { front_matter: this.draft.front_matter, sections, revision: this.revision }
    },
    render(view) {
      $('intake').hidden = !profileEmpty(view)
      return [...PROFILE_GROUPS.map((group) => groupPanel(this, group)), sectionsPanel(this), groupPanel(this, CV_FILES)]
    },
    saved: 'Profile saved.',
  },
  settings: {
    name: 'settings',
    url: '/api/permissions',
    loaded: false,
    conditional: [],
    fromView: (view) => view.permissions,
    body() { return { permissions: this.draft, revision: this.revision } },
    render() { return SETTINGS_GROUPS.map((group) => groupPanel(this, group)) },
    saved: 'Settings saved.',
  },
}

function showForm(form, view) {
  form.original = form.fromView(view)
  form.draft = clone(form.original)
  form.revision = view.revision
  form.loaded = true
  form.conditional = []
  $(`${form.name}-form`).replaceChildren(...form.render(view), h('p', { className: 'hint path' }, `Stored in ${view.path}`))
  updateVisibility(form)
  updateSavebar()
}

async function loadForm(form) {
  const view = await guarded(() => api(form.url))
  if (view) showForm(form, view)
  return view
}

async function saveForm(form) {
  try {
    const view = await api(form.url, { method: 'PUT', body: form.body() })
    showForm(form, view)
    showMessage(form.saved)
  } catch (error) {
    showMessage(error.status === 409
      ? 'This file changed since you opened it, perhaps by your agent. Discard to load the latest, then make your edits again.'
      : error.message, true)
  }
}

const WIZARD_STEPS = ['Welcome', 'Career DNA', 'Targets', 'Modules', 'Done']
const INBOX_TYPES = ['.pdf', '.docx', '.doc', '.md', '.txt', '.zip', '.csv']
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024
const wizard = {
  step: 0,
  file: null,
  uploaded: null,
  noInbox: false,
  profile: null,
  permissions: null,
  targets: null,
  modules: null,
  quiz: { builder: 50, team: 'small', mode: 'remote', risk: 50, motivation: 50 },
}

const QUIZ = [
  { key: 'builder', title: 'Builder or Optimizer?', subtitle: 'Do you thrive creating from scratch, or perfecting what exists?', left: '0 → 1 Builder', right: '1 → 100 Optimizer' },
  { key: 'team', title: 'Team size', subtitle: 'Where do you do your best work?', options: [['small', 'Small teams'], ['large', 'Large orgs']] },
  { key: 'mode', title: 'Work mode', subtitle: 'How do you prefer to work?', options: [['remote', 'Remote'], ['hybrid', 'Hybrid'], ['onsite', 'On-site']] },
  { key: 'risk', title: 'Risk appetite', subtitle: 'What kind of environment fits you?', left: 'Startup energy', right: 'Enterprise stability' },
  { key: 'motivation', title: 'What drives you?', subtitle: 'What matters most in your next move?', left: 'Learning & growth', right: 'Compensation' },
]

const extension = (name) => { const dot = name.lastIndexOf('.'); return dot < 0 ? '' : name.slice(dot).toLowerCase() }
const companyStages = (risk) => (risk < 34 ? ['startup'] : risk > 66 ? ['enterprise'] : ['startup', 'enterprise'])

function careerDna(quiz) {
  return QUIZ.map((question) => {
    const title = question.title.replace(/\?$/, '')
    const value = quiz[question.key]
    if (question.options) return `- ${title}: ${question.options.find(([option]) => option === value)[1]}`
    const lean = value < 34 ? `leans ${question.left}` : value > 66 ? `leans ${question.right}` : 'balanced'
    return `- ${title}: ${value}/100, ${lean} (0 = ${question.left}, 100 = ${question.right})`
  }).join('\n')
}

function goTo(step) {
  wizard.step = step
  renderWizard()
  window.scrollTo(0, 0)
}

function stepActions(onSkip, onContinue) {
  const next = h('button', {
    type: 'button',
    className: 'primary',
    onclick: async () => {
      next.disabled = true
      try { await onContinue() } finally { next.disabled = false }
    },
  }, 'Continue')
  return h('div', { className: 'actions' },
    onSkip ? h('button', { type: 'button', className: 'ghost', onclick: onSkip }, 'Skip for now') : null, next)
}

const intro = (title, text) => h('div', { className: 'step-intro' }, h('h2', null, title), h('p', null, text))

function base64Of(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error || new Error('Could not read the file.'))
    reader.readAsDataURL(file)
  })
}

function dropZone() {
  const input = h('input', { type: 'file', accept: INBOX_TYPES.join(','), hidden: true })
  const zone = h('div', { role: 'button', tabindex: 0, 'aria-label': 'Choose a resume or LinkedIn file' })
  const draw = () => {
    zone.className = wizard.file ? 'drop has-file' : 'drop'
    zone.replaceChildren(wizard.file
      ? h('div', { className: 'file' },
        h('strong', null, wizard.file.name),
        h('span', null, `${Math.max(1, Math.round(wizard.file.size / 1024))} KB`),
        h('button', {
          type: 'button', className: 'ghost', 'aria-label': 'Remove file',
          onclick: (event) => { event.stopPropagation(); wizard.file = null; input.value = ''; draw() },
        }, 'Remove'))
      : h('div', { className: 'drop-text' },
        h('strong', null, 'Drop your resume or LinkedIn PDF here, or ', h('span', { className: 'link' }, 'browse')),
        h('small', null, 'PDF, Word, Markdown or text, or a LinkedIn export (ZIP or CSV). Completely optional.')))
  }
  const choose = (file) => {
    if (!file) return
    if (!INBOX_TYPES.includes(extension(file.name))) return showMessage(`Use one of ${INBOX_TYPES.join(', ')}.`, true)
    if (file.size > MAX_UPLOAD_BYTES) return showMessage('That file is over 15 MB. Put it in inbox/ yourself instead.', true)
    wizard.file = file
    draw()
  }
  zone.addEventListener('click', () => input.click())
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click() }
  })
  zone.addEventListener('dragover', (event) => { event.preventDefault(); zone.classList.add('over') })
  zone.addEventListener('dragleave', () => zone.classList.remove('over'))
  zone.addEventListener('drop', (event) => {
    event.preventDefault()
    zone.classList.remove('over')
    choose(event.dataTransfer.files[0])
  })
  input.addEventListener('change', () => choose(input.files[0]))
  draw()
  return h('div', null, zone, input)
}

function inboxHelp() {
  return h('section', { className: 'panel intake' },
    h('h2', null, 'Put it in inbox/'),
    h('p', { className: 'hint' }, 'This dashboard is not running in a Job Duck workspace, so it cannot take the file here.'),
    h('ol', { className: 'ways' },
      h('li', null, 'Save your resume or LinkedIn PDF into the ', h('code', null, 'inbox/'), ' folder of your Job Duck workspace.'),
      h('li', null, 'Back in your agent, say "import my resume".')))
}

async function uploadAndContinue() {
  if (!wizard.file || wizard.noInbox) return goTo(1)
  try {
    const data = await base64Of(wizard.file)
    wizard.uploaded = await api('/api/inbox', { method: 'POST', body: { name: wizard.file.name, data } })
    wizard.file = null
    showMessage(`Saved to inbox/${wizard.uploaded.name}.`)
    goTo(1)
  } catch (error) {
    if (error.status !== 409) return showMessage(error.message, true)
    wizard.noInbox = true
    renderWizard()
  }
}

function welcomeStep() {
  return [
    intro('We value your worth, just as your future employer does.', 'Tell Job Duck who you are. It takes about a minute.'),
    wizard.noInbox ? inboxHelp() : dropZone(),
    stepActions(() => goTo(1), uploadAndContinue),
  ]
}

function quizSlider(question) {
  const id = `quiz-${question.key}`
  const input = h('input', { type: 'range', id, min: 0, max: 100, step: 1, 'aria-label': question.title })
  input.value = String(wizard.quiz[question.key])
  const left = h('span', null, question.left)
  const right = h('span', null, question.right)
  const paint = () => {
    const value = Number(input.value)
    left.classList.toggle('lean', value <= 50)
    right.classList.toggle('lean', value >= 50)
  }
  input.addEventListener('input', () => { wizard.quiz[question.key] = Number(input.value); paint() })
  paint()
  return [input, h('div', { className: 'ends' }, left, right)]
}

function quizToggle(question) {
  const group = h('div', { className: 'segmented', role: 'radiogroup', 'aria-label': question.title })
  const draw = () => group.replaceChildren(...question.options.map(([value, text]) => {
    const on = wizard.quiz[question.key] === value
    return h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(on), className: on ? 'on' : '',
      onclick: () => { wizard.quiz[question.key] = value; draw() },
    }, text)
  }))
  draw()
  return [group]
}

async function saveProfile(frontMatter, sections) {
  const current = await api('/api/profile')
  wizard.profile = await api('/api/profile', {
    method: 'PUT', body: { front_matter: frontMatter, sections, revision: current.revision },
  })
  forms.profile.loaded = false
}

function careerDnaStep() {
  const save = () => guarded(async () => {
    await saveProfile(
      { work_modes: [wizard.quiz.mode], company_stages: companyStages(wizard.quiz.risk) },
      { 'Career DNA': careerDna(wizard.quiz) },
    )
    goTo(2)
  })
  return [
    intro('Your Career DNA', 'Five questions. Thirty seconds. No wrong answers.'),
    h('div', { className: 'questions' }, ...QUIZ.map((question) => h('div', { className: 'question' },
      h('h3', null, question.title),
      h('p', { className: 'hint' }, question.subtitle),
      ...(question.options ? quizToggle(question) : quizSlider(question))))),
    stepActions(() => goTo(2), save),
  ]
}

function targetsStep() {
  if (!wizard.targets) {
    const front = wizard.profile.front_matter
    wizard.targets = {
      target_titles: [...(front.target_titles || [])],
      locations: [...(front.locations || [])],
      seniority: [...(front.seniority || [])],
      pay_floor: front.pay_floor || 0,
    }
  }
  const draft = wizard.targets
  const tags = (key, label, field) => {
    const id = `wizard-${key}`
    return h('div', { className: 'field' }, h('label', { for: id }, label),
      tagInput(id, draft[key], field, (next) => { draft[key] = next }))
  }
  const pay = h('input', { type: 'number', id: 'wizard-pay_floor', min: 0, step: 1000, placeholder: '0 means no floor' })
  pay.value = draft.pay_floor ? String(draft.pay_floor) : ''
  pay.addEventListener('input', () => { draft.pay_floor = pay.value === '' ? 0 : Math.max(0, Number(pay.value)) })
  const save = () => guarded(async () => {
    await saveProfile({ ...draft }, {})
    goTo(3)
  })
  return [
    intro('What are you looking for?', 'The find and apply skills filter postings with these. Press Enter after each item.'),
    h('div', { className: 'fields' },
      tags('target_titles', 'Target titles', { placeholder: 'e.g. Software Engineer' }),
      tags('locations', 'Cities or regions', { placeholder: 'e.g. Remote, New York' }),
      tags('seniority', 'Seniority', { suggest: ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director'] }),
      h('div', { className: 'field' }, h('label', { for: 'wizard-pay_floor' }, 'Minimum yearly pay'), pay,
        h('small', null, 'Postings below this are skipped.'))),
    stepActions(() => goTo(3), save),
  ]
}

function modulesStep() {
  if (!wizard.modules) wizard.modules = { ...wizard.permissions.permissions.modules }
  const boxes = {}
  const list = h('div', { className: 'module-list' }, ...MODULES.map(([key, label, help]) => {
    const box = h('input', { type: 'checkbox', value: key })
    box.checked = Boolean(wizard.modules[key])
    boxes[key] = box
    box.addEventListener('change', () => {
      wizard.modules[key] = box.checked
      if (key !== 'apply' || !box.checked) return
      for (const other of ['find', 'track']) {
        wizard.modules[other] = true
        boxes[other].checked = true
      }
    })
    return h('label', { className: 'module' }, box, h('span', null, h('strong', null, label), h('small', null, help)))
  }))
  const save = () => guarded(async () => {
    const current = await api('/api/permissions')
    const permissions = clone(current.permissions)
    permissions.modules = { ...permissions.modules, ...wizard.modules }
    wizard.permissions = await api('/api/permissions', { method: 'PUT', body: { permissions, revision: current.revision } })
    forms.settings.loaded = false
    goTo(4)
  })
  return [
    intro('What should Job Duck do?', 'Nothing runs until its module is on. Change this any time in Settings.'),
    list,
    stepActions(() => goTo(4), save),
  ]
}

function doneStep() {
  const open = (hash, text, className) => h('button', { type: 'button', className, onclick: () => { location.hash = hash } }, text)
  return [
    intro("You're set up.", 'Your profile and settings are saved. Review or change them any time.'),
    wizard.uploaded
      ? h('section', { className: 'panel intake' },
        h('h2', null, 'Back in your agent, say: import my resume'),
        h('p', { className: 'hint' }, `It reads inbox/${wizard.uploaded.name} and fills in your profile for you to review.`))
      : null,
    h('div', { className: 'actions' }, open('#profile', 'Open Profile', ''), open('#applications', 'Open Applications', 'primary')),
  ]
}

const WIZARD_RENDERERS = [welcomeStep, careerDnaStep, targetsStep, modulesStep, doneStep]

function renderWizard() {
  $('wizard-label').textContent = WIZARD_STEPS[wizard.step]
  $('wizard-bars').replaceChildren(...WIZARD_STEPS.map((_, index) => h('span', { className: index <= wizard.step ? 'bar on' : 'bar' })))
  $('wizard-step').replaceWith(h('section', { id: 'wizard-step', className: 'step' }, ...WIZARD_RENDERERS[wizard.step]()))
}

async function openWizard() {
  const data = await guarded(() => Promise.all([api('/api/profile'), api('/api/permissions')]))
  if (!data) return
  wizard.profile = data[0]
  wizard.permissions = data[1]
  wizard.targets = null
  wizard.modules = null
  if (wizard.step === WIZARD_STEPS.length - 1) Object.assign(wizard, { step: 0, file: null, uploaded: null })
  const mode = (wizard.profile.front_matter.work_modes || [])[0]
  if (['remote', 'hybrid', 'onsite'].includes(mode)) wizard.quiz.mode = mode
  renderWizard()
}

function route() {
  const name = location.hash.slice(1)
  const view = VIEWS.includes(name) ? name : 'applications'
  state.view = view
  for (const each of VIEWS) $(`view-${each}`).hidden = each !== view
  for (const link of document.querySelectorAll('.tabs a')) {
    const active = link.dataset.view === view
    link.classList.toggle('active', active)
    if (active) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
  if (view === 'applications') refresh()
  else {
    if (!$('drawer').hidden) closeDrawer()
    if (view === 'welcome') openWizard()
    else if (!forms[view].loaded) loadForm(forms[view])
  }
  updateSavebar()
}

function bindForms() {
  for (const form of Object.values(forms)) $(`${form.name}-form`).addEventListener('submit', (event) => event.preventDefault())
  $('save').addEventListener('click', () => { const form = forms[state.view]; if (form) saveForm(form) })
  $('revert').addEventListener('click', () => { const form = forms[state.view]; if (form) loadForm(form) })
  window.addEventListener('beforeunload', (event) => {
    if (Object.values(forms).some(isDirty)) event.preventDefault()
  })
  window.addEventListener('focus', () => {
    const form = forms[state.view]
    if (form && form.loaded && !isDirty(form)) loadForm(form)
  })
  window.addEventListener('hashchange', route)
  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (event) => { if (state.view === 'welcome') event.preventDefault() })
  }
}

async function init() {
  const statuses = await guarded(() => api('/api/statuses'))
  if (!statuses) return
  state.statuses = statuses.statuses
  state.terminal = statuses.terminal
  bindDrawer()
  bindForms()
  let timer
  $('search').addEventListener('input', (event) => {
    clearTimeout(timer)
    timer = setTimeout(() => { state.q = event.target.value.trim(); refresh() }, 200)
  })
  if (!location.hash) {
    const profile = await loadForm(forms.profile)
    const front = profile && profile.front_matter
    if (front && !front.name && (front.target_titles || []).length === 0) history.replaceState(null, '', '#welcome')
  }
  route()
  setInterval(() => { if (state.view === 'applications' && !document.hidden) refresh() }, POLL_MS)
}

document.addEventListener('DOMContentLoaded', init)
