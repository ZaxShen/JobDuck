import { ApiError, errorMessage } from './api'

export const AGENT_STATUS_PATH = '/api/agent'
export const AUGMENT_PATH = '/api/agent/augment'
export const MAX_MESSAGE_CHARS = 8000

export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'done'; sessionId: string | null; denials: string[]; isError: boolean }
  | { type: 'error'; message: string }

export interface AgentStatus {
  available: boolean
  host: string
  label: string
}

export interface AugmentBody {
  message: string
  sessionId?: string | null
}

export const COPY_PROMPT =
  'Augment my profile: run the Job Duck augment skill. Read the Experience in my profile and propose atomic facts ' +
  '(one action each, with its outcome and metrics), then save them as proposed facts so I can review them in the dashboard.'

export const BUSY_MESSAGE = 'Your agent is still finishing the last message. Try again in a moment.'

export const TOOL_LABELS: Record<string, string> = {
  get_permissions: 'Checked Permissions',
  get_profile: 'Read Profile',
  list_profile_facts: 'Listed Profile Facts',
  save_profile_facts: 'Saved Proposed Facts',
  update_profile_fact: 'Updated Profile Fact',
}

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)

export function toolLabel(name: string): string {
  const bare = name.replace(/^mcp__.+?__/, '')
  const known = TOOL_LABELS[bare]
  if (known) return known
  const words = bare.split(/[_\s-]+/).filter(Boolean)
  return words.length > 0 ? words.map(capitalize).join(' ') : 'Unknown Tool'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

export function toAgentEvent(value: unknown): AgentEvent | null {
  if (!isRecord(value)) return null
  switch (value.type) {
    case 'session':
      return typeof value.sessionId === 'string' ? { type: 'session', sessionId: value.sessionId } : null
    case 'text':
      return typeof value.text === 'string' ? { type: 'text', text: value.text } : null
    case 'tool':
      return typeof value.name === 'string' ? { type: 'tool', name: value.name } : null
    case 'done':
      return (typeof value.sessionId === 'string' || value.sessionId === null) && isStringArray(value.denials)
        ? { type: 'done', sessionId: value.sessionId, denials: value.denials, isError: value.isError === true }
        : null
    case 'error':
      return typeof value.message === 'string' ? { type: 'error', message: value.message } : null
    default:
      return null
  }
}

function parseFrame(frame: string): AgentEvent | null {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))
  if (data.length === 0) return null
  try {
    return toAgentEvent(JSON.parse(data.join('\n')))
  } catch {
    return null
  }
}

export function parseSseFrames(buffer: string): { events: AgentEvent[]; rest: string } {
  const frames = buffer.split(/\r?\n\r?\n/)
  const rest = frames.pop() ?? ''
  const events = frames.flatMap((frame) => {
    const event = parseFrame(frame)
    return event ? [event] : []
  })
  return { events, rest }
}

export interface SseParser {
  push(chunk: Uint8Array | string): AgentEvent[]
  flush(): AgentEvent[]
}

export function createSseParser(): SseParser {
  const decoder = new TextDecoder()
  let buffer = ''
  const take = (text: string) => {
    const { events, rest } = parseSseFrames(buffer + text)
    buffer = rest
    return events
  }
  return {
    push: (chunk) => take(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })),
    flush: () => {
      const events = take(`${decoder.decode()}\n\n`)
      buffer = ''
      return events
    },
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

const defaultFetch: FetchLike = (input, init) => fetch(input, init)

export async function streamAugment(
  body: AugmentBody,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
  fetchImpl: FetchLike = defaultFetch,
): Promise<void> {
  const payload = body.sessionId ? { message: body.message, sessionId: body.sessionId } : { message: body.message }
  const init: RequestInit = {
    method: 'POST',
    headers: { 'X-JobDuck-Dashboard': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }
  if (signal) init.signal = signal
  const res = await fetchImpl(AUGMENT_PATH, init)
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => ({}))
    const message = isRecord(data) && typeof data.error === 'string' ? data.error : `${res.status} ${res.statusText}`
    throw new ApiError(res.status, message)
  }
  if (!res.body) throw new Error('Your agent sent no reply.')
  const parser = createSseParser()
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    for (const event of parser.push(value)) onEvent(event)
  }
  for (const event of parser.flush()) onEvent(event)
}

export function chatErrorMessage(error: unknown): string {
  return error instanceof ApiError && error.status === 409 ? BUSY_MESSAGE : errorMessage(error)
}

export interface UserMessage {
  role: 'user'
  text: string
}

export interface AgentMessage {
  role: 'agent'
  text: string
  tools: string[]
  denials: string[]
  isError: boolean
  error: string | null
  stopped: boolean
  pending: boolean
  afterTool: boolean
}

export type ChatMessage = UserMessage | AgentMessage

export interface ChatState {
  messages: ChatMessage[]
  sessionId: string | null
  running: boolean
}

export type ChatAction =
  | { type: 'send'; message: string }
  | { type: 'event'; event: AgentEvent }
  | { type: 'fail'; message: string }
  | { type: 'stopped' }
  | { type: 'end' }
  | { type: 'reset' }

export const initialChat: ChatState = { messages: [], sessionId: null, running: false }

const agentMessage = (): AgentMessage => ({
  role: 'agent', text: '', tools: [], denials: [], isError: false, error: null, stopped: false, pending: true, afterTool: false,
})

function updateAgent(state: ChatState, update: (message: AgentMessage) => AgentMessage): ChatState {
  const last = state.messages.at(-1)
  const current = last?.role === 'agent' ? last : agentMessage()
  const head = last?.role === 'agent' ? state.messages.slice(0, -1) : state.messages
  return { ...state, messages: [...head, update(current)] }
}

const unique = (items: string[]) => [...new Set(items)]

function applyEvent(state: ChatState, event: AgentEvent): ChatState {
  switch (event.type) {
    case 'session':
      return { ...state, sessionId: event.sessionId }
    case 'text':
      return updateAgent(state, (message) => ({
        ...message,
        text: message.afterTool && message.text !== '' && !/\s$/.test(message.text) ? `${message.text}\n\n${event.text}` : message.text + event.text,
        afterTool: false,
      }))
    case 'tool':
      return updateAgent(state, (message) => ({ ...message, tools: unique([...message.tools, toolLabel(event.name)]), afterTool: true }))
    case 'done':
      return {
        ...updateAgent(state, (message) => ({
          ...message, denials: unique(event.denials.map(toolLabel)), isError: event.isError, pending: false,
        })),
        sessionId: event.sessionId ?? state.sessionId,
        running: false,
      }
    case 'error':
      return { ...updateAgent(state, (message) => ({ ...message, error: event.message, pending: false })), running: false }
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'send':
      return { ...state, running: true, messages: [...state.messages, { role: 'user', text: action.message }, agentMessage()] }
    case 'event':
      return applyEvent(state, action.event)
    case 'fail':
      return { ...updateAgent(state, (message) => ({ ...message, error: action.message, pending: false })), running: false }
    case 'stopped':
      return { ...updateAgent(state, (message) => ({ ...message, stopped: message.pending, pending: false })), running: false }
    case 'end':
      return state.running ? { ...updateAgent(state, (message) => ({ ...message, pending: false })), running: false } : state
    case 'reset':
      return initialChat
  }
}
