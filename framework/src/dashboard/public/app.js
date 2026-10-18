'use strict'

const POLL_MS = 30000
const state = { statuses: [], terminal: [], filter: '', q: '', selected: null, rows: [] }
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
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`)
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

async function init() {
  const statuses = await guarded(() => api('/api/statuses'))
  if (!statuses) return
  state.statuses = statuses.statuses
  state.terminal = statuses.terminal
  bindDrawer()
  let timer
  $('search').addEventListener('input', (event) => {
    clearTimeout(timer)
    timer = setTimeout(() => { state.q = event.target.value.trim(); refresh() }, 200)
  })
  await refresh()
  setInterval(refresh, POLL_MS)
}

document.addEventListener('DOMContentLoaded', init)
