import type { FreehireJob } from '../freehire/client'
import { atsEndpoint } from './ats'
import { type AgentProposal, acceptAgentFields, type RejectedProposal } from './evidence'
import { FetchRefused, JSON_ACCEPT, PAGE_ACCEPT, type SafeFetchDeps, type SafeResponse, safeFetch } from './fetch'
import {
  type CoreField, type FieldSource, type FieldSources, fillFields, missingCore, type PostingFields,
} from './fields'
import { freehireFields } from './freehire'
import { type PageRead, pageRead } from './html'
import { MIN_TEXT, textFields } from './text'

export const MAX_FETCHES = 3

export interface KnownFields {
  fields: PostingFields
  sources: FieldSources
}

export interface ResolveInput {
  url: string
  freehire?: FreehireJob
  known?: KnownFields
  html?: string
  text?: string
  agent?: AgentProposal[]
}

export type ResolveDeps = SafeFetchDeps
export type Quality = 'ok' | 'thin' | 'blocked' | 'gone'
export type NextStep = 'done' | 'agent_fill' | 'agent_browser'

export interface Resolution {
  fields: PostingFields
  sources: FieldSources
  missing: CoreField[]
  pay_stated: boolean | null
  quality: Quality
  fetched: string[]
  next: NextStep
  rejected: RejectedProposal[]
}

const WALL_TEXT = /\b(?:captcha|are you (?:a )?(?:human|robot)|verify (?:that )?you are (?:a )?human|unusual traffic|access denied|enable javascript|javascript is (?:disabled|required)|please (?:sign|log) ?in|sign ?in to (?:view|continue|apply)|log ?in to (?:view|continue)|checking your browser|just a moment)\b/i
const WALL_MARKUP = /g-recaptcha|h-captcha|cf-turnstile|challenge-platform|cf-chl-|px-captcha|datadome/i
const WALL_TEXT_LIMIT = 2000

export const isBlockedStatus = (status: number) => status === 401 || status === 403 || status === 429 || status >= 500
export const isGoneStatus = (status: number) => status === 404 || status === 410

export function isWall(html: string, page: Pick<PageRead, 'text' | 'visible' | 'structured'>): boolean {
  if (page.text.length < MIN_TEXT) return true
  return !page.structured && page.visible.length < WALL_TEXT_LIMIT && (WALL_TEXT.test(page.visible) || WALL_MARKUP.test(html))
}

export async function resolvePosting(input: ResolveInput, deps: ResolveDeps = {}): Promise<Resolution> {
  const fields: PostingFields = {}
  const sources: FieldSources = {}
  const texts: string[] = []
  const fetched: string[] = []
  let searched = false
  let blocked = false
  let gone = false

  const apply = (layer: PostingFields, source: FieldSource) => {
    for (const field of fillFields(fields, layer)) sources[field] = source
  }
  const parseText = (text: string | undefined, trusted = true) => {
    if (!text || texts.includes(text)) return
    texts.push(text)
    apply(textFields(text, { title: fields.title, country: fields.country }), 'text')
    if (trusted && text.length >= MIN_TEXT) searched = true
  }
  const readPage = (html: string) => {
    const page = pageRead(input.url, html)
    const wall = isWall(html, page)
    blocked ||= wall
    apply(page.fields, 'page')
    parseText(page.text, !wall)
  }
  const attempt = async (url: string, accept: string): Promise<SafeResponse | undefined> => {
    if (fetched.length >= MAX_FETCHES) return undefined
    fetched.push(url)
    try {
      return await safeFetch(url, deps, accept)
    } catch (error) {
      if (error instanceof FetchRefused) return undefined
      throw error
    }
  }

  if (input.freehire) {
    const record = freehireFields(input.freehire)
    apply(record, 'freehire')
    parseText(record.description)
  }

  if (input.known) {
    const { fields: stored, sources: storedSources } = input.known
    for (const field of fillFields(fields, stored)) sources[field] = storedSources[field] ?? 'agent'
    parseText(stored.description)
  }

  if (input.html !== undefined || input.text !== undefined) {
    if (input.html) readPage(input.html)
    if (input.text) {
      const wall = input.text.trim().length < MIN_TEXT || (input.text.length < WALL_TEXT_LIMIT && WALL_TEXT.test(input.text))
      if (!input.html) blocked ||= wall
      parseText(input.text, !wall)
    }
    if (!input.html && !input.text) blocked = true
  } else if (missingCore(fields).length > 0) {
    const endpoint = atsEndpoint(input.url)
    let atsRead = false
    if (endpoint) {
      const response = await attempt(endpoint.apiUrl, JSON_ACCEPT)
      const read = response?.status === 200 ? endpoint.parse(parseJson(response.body)) : undefined
      if (read) {
        atsRead = true
        apply(read.fields, 'ats')
        parseText(read.text)
      }
    }
    if (!atsRead && missingCore(fields).length > 0) {
      const response = await attempt(input.url, PAGE_ACCEPT)
      if (response && isGoneStatus(response.status)) gone = true
      else if (!response || isBlockedStatus(response.status)) blocked = true
      else if (response.contentType.includes('html')) readPage(response.body)
      else if (response.contentType === 'text/plain') readPage(`<pre>${escapeHtml(response.body)}</pre>`)
      else blocked = true
    }
  }

  let rejected: RejectedProposal[] = []
  if (input.agent && input.agent.length > 0) {
    const evidence = acceptAgentFields(texts.join('\n\n'), input.agent, fields)
    for (const { field, value } of evidence.accepted) {
      Object.assign(fields, { [field]: value })
      sources[field] = 'agent'
    }
    rejected = evidence.rejected
  }

  const missing = missingCore(fields)
  const payKnown = fields.pay_min !== undefined || fields.pay_max !== undefined
  const longest = texts.reduce((max, text) => Math.max(max, text.length), 0)
  const quality: Quality = gone ? 'gone' : blocked ? 'blocked' : longest < MIN_TEXT ? 'thin' : 'ok'
  return {
    fields,
    sources,
    missing,
    pay_stated: payKnown ? true : searched ? false : null,
    quality,
    fetched,
    next: gone ? 'done' : blocked ? 'agent_browser' : missing.length > 0 ? 'agent_fill' : 'done',
    rejected,
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
