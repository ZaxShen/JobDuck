import { describe, expect, test } from 'bun:test'
import { AUGMENT_PATH as SERVER_AUGMENT_PATH, AUGMENT_TOOLS, MAX_MESSAGE_CHARS as SERVER_MAX, type AgentEvent as ServerAgentEvent } from '../src/dashboard/agent'
import { ApiError } from '../web/src/lib/api'
import {
  AUGMENT_PATH,
  BUSY_MESSAGE,
  COPY_PROMPT,
  MAX_MESSAGE_CHARS,
  TOOL_LABELS,
  chatErrorMessage,
  chatReducer,
  createSseParser,
  initialChat,
  parseSseFrames,
  streamAugment,
  toolLabel,
  type AgentEvent,
  type AgentMessage,
  type ChatAction,
  type ChatState,
  type FetchLike,
} from '../web/src/lib/agent-chat'

type Assert<T extends true> = T
export type ServerEventsFit = Assert<ServerAgentEvent extends AgentEvent ? true : false>
export type WebEventsFit = Assert<AgentEvent extends ServerAgentEvent ? true : false>

const SESSION = '123e4567-e89b-12d3-a456-426614174000'
const encoder = new TextEncoder()
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`

const EVENTS: AgentEvent[] = [
  { type: 'session', sessionId: SESSION },
  { type: 'text', text: 'Proposed 2 facts for Acme — café ✓' },
  { type: 'tool', name: 'save_profile_facts' },
  { type: 'done', sessionId: SESSION, denials: ['update_profile_fact'], isError: false },
  { type: 'error', message: 'Claude Code exited with code 1 without a result' },
]

describe('SSE parser', () => {
  test('returns complete frames and keeps the tail', () => {
    const text = EVENTS.map(frame).join('')
    const { events, rest } = parseSseFrames(text + 'data: {"type":"te')
    expect(events).toEqual(EVENTS)
    expect(rest).toBe('data: {"type":"te')
  })

  test('every byte split yields the same events, including inside multi-byte characters and mid-JSON', () => {
    const bytes = encoder.encode(EVENTS.map(frame).join(''))
    for (let cut = 1; cut < bytes.length; cut++) {
      const parser = createSseParser()
      const events = [...parser.push(bytes.slice(0, cut)), ...parser.push(bytes.slice(cut)), ...parser.flush()]
      expect(events).toEqual(EVENTS)
    }
  })

  test('one byte at a time', () => {
    const bytes = encoder.encode(EVENTS.map(frame).join(''))
    const parser = createSseParser()
    const events: AgentEvent[] = []
    for (const byte of bytes) events.push(...parser.push(new Uint8Array([byte])))
    expect([...events, ...parser.flush()]).toEqual(EVENTS)
  })

  test('ignores blank lines, comments, unparseable and unknown frames', () => {
    const text = [
      '\n\n',
      ': keep-alive\n\n',
      'data: not json\n\n',
      'data: {"type":"mystery"}\n\n',
      'data: {"type":"text"}\n\n',
      'event: ping\n\n',
      frame({ type: 'text', text: 'Hello' }),
      ': comment inside\r\ndata: {"type":"tool","name":"get_profile"}\r\n\r\n',
    ].join('')
    const { events, rest } = parseSseFrames(text)
    expect(events).toEqual([{ type: 'text', text: 'Hello' }, { type: 'tool', name: 'get_profile' }])
    expect(rest).toBe('')
  })

  test('flush parses a final frame without the closing blank line', () => {
    const parser = createSseParser()
    expect(parser.push('data: {"type":"text","text":"Hi"}')).toEqual([])
    expect(parser.flush()).toEqual([{ type: 'text', text: 'Hi' }])
  })
})

const run = (actions: ChatAction[], from: ChatState = initialChat) => actions.reduce(chatReducer, from)
const event = (value: AgentEvent): ChatAction => ({ type: 'event', event: value })
const lastAgent = (state: ChatState) => state.messages.at(-1) as AgentMessage

describe('transcript reducer', () => {
  test('consecutive text deltas build one agent message and the session is stored', () => {
    const state = run([
      { type: 'send', message: 'Augment my profile' },
      event({ type: 'session', sessionId: SESSION }),
      event({ type: 'text', text: 'Reading ' }),
      event({ type: 'text', text: 'your profile.' }),
    ])
    expect(state.running).toBe(true)
    expect(state.sessionId).toBe(SESSION)
    expect(state.messages).toHaveLength(2)
    expect(state.messages[0]).toEqual({ role: 'user', text: 'Augment my profile' })
    expect(lastAgent(state).text).toBe('Reading your profile.')
    expect(lastAgent(state).pending).toBe(true)
  })

  test('tool labels are recorded in order without duplicates, and text after a tool starts a new paragraph', () => {
    const state = run([
      { type: 'send', message: 'Go' },
      event({ type: 'tool', name: 'get_profile' }),
      event({ type: 'text', text: 'Found Acme.' }),
      event({ type: 'tool', name: 'save_profile_facts' }),
      event({ type: 'tool', name: 'get_profile' }),
      event({ type: 'tool', name: 'save_profile_facts' }),
      event({ type: 'text', text: 'Saved.' }),
    ])
    expect(lastAgent(state).tools).toEqual(['Read Profile', 'Saved Proposed Facts'])
    expect(lastAgent(state).text).toBe('Found Acme.\n\nSaved.')
  })

  test('done stores session, denials and isError and ends the turn', () => {
    const state = run([
      { type: 'send', message: 'Go' },
      event({ type: 'done', sessionId: SESSION, denials: ['update_profile_fact', 'Bash', 'Bash'], isError: true }),
    ])
    expect(state.running).toBe(false)
    expect(state.sessionId).toBe(SESSION)
    expect(lastAgent(state)).toMatchObject({ denials: ['Updated Profile Fact', 'Bash'], isError: true, pending: false })
  })

  test('done with a null session keeps the earlier one', () => {
    const state = run([{ type: 'send', message: 'Go' }, event({ type: 'done', sessionId: null, denials: [], isError: false })],
      { ...initialChat, sessionId: SESSION })
    expect(state.sessionId).toBe(SESSION)
  })

  test('error events and thrown errors are recorded', () => {
    const fromEvent = run([{ type: 'send', message: 'Go' }, event({ type: 'error', message: 'boom' })])
    expect(fromEvent.running).toBe(false)
    expect(lastAgent(fromEvent).error).toBe('boom')
    const fromThrow = run([{ type: 'send', message: 'Go' }, { type: 'fail', message: BUSY_MESSAGE }])
    expect(lastAgent(fromThrow).error).toBe(BUSY_MESSAGE)
  })

  test('stop marks a pending turn stopped, end after done changes nothing, reset clears all', () => {
    const stopped = run([{ type: 'send', message: 'Go' }, event({ type: 'text', text: 'Hal' }), { type: 'stopped' }])
    expect(stopped.running).toBe(false)
    expect(lastAgent(stopped)).toMatchObject({ stopped: true, pending: false, text: 'Hal' })
    const done = run([{ type: 'send', message: 'Go' }, event({ type: 'done', sessionId: SESSION, denials: [], isError: false })])
    expect(chatReducer(done, { type: 'end' })).toBe(done)
    expect(chatReducer(done, { type: 'reset' })).toEqual(initialChat)
  })

  test('tool label map covers every augment tool and falls back to Title Case', () => {
    for (const tool of AUGMENT_TOOLS) expect(TOOL_LABELS[tool]).toBeString()
    expect(toolLabel('save_profile_facts')).toBe('Saved Proposed Facts')
    expect(toolLabel('mcp__jobduck__get_profile')).toBe('Read Profile')
    expect(toolLabel('web_fetch')).toBe('Web Fetch')
    expect(toolLabel('Bash')).toBe('Bash')
    expect(toolLabel('')).toBe('Unknown Tool')
  })
})

interface Call {
  input: string
  init: RequestInit
}

function fakeFetch(response: () => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ input, init })
      return response()
    },
  }
}

const sseResponse = (chunks: string[]) => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
    controller.close()
  },
}), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })

describe('streamAugment', () => {
  test('matches the server contract constants', () => {
    expect(AUGMENT_PATH).toBe(SERVER_AUGMENT_PATH)
    expect(MAX_MESSAGE_CHARS).toBe(SERVER_MAX)
    expect(COPY_PROMPT).toStartWith('Augment my profile')
  })

  test('posts only the message on the first turn and streams events', async () => {
    const text = EVENTS.map(frame).join('')
    const { fetch, calls } = fakeFetch(() => sseResponse([text.slice(0, 17), text.slice(17, 90), text.slice(90)]))
    const seen: AgentEvent[] = []
    await streamAugment({ message: 'Augment my profile' }, (value) => seen.push(value), undefined, fetch)
    expect(seen).toEqual(EVENTS)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.input).toBe('/api/agent/augment')
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.headers).toEqual({ 'X-JobDuck-Dashboard': '1', 'Content-Type': 'application/json' })
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ message: 'Augment my profile' })
  })

  test('posts message and sessionId on a follow-up turn and passes the signal', async () => {
    const { fetch, calls } = fakeFetch(() => sseResponse([]))
    const controller = new AbortController()
    await streamAugment({ message: 'More', sessionId: SESSION }, () => undefined, controller.signal, fetch)
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ message: 'More', sessionId: SESSION })
    expect(calls[0]!.init.signal).toBe(controller.signal)
  })

  test('a null sessionId is not sent', async () => {
    const { fetch, calls } = fakeFetch(() => sseResponse([]))
    await streamAugment({ message: 'Hi', sessionId: null }, () => undefined, undefined, fetch)
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ message: 'Hi' })
  })

  test('a 409 throws ApiError with the server message', async () => {
    const { fetch } = fakeFetch(() => Response.json({ error: 'agent is busy' }, { status: 409 }))
    const error = await streamAugment({ message: 'Hi' }, () => undefined, undefined, fetch).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(409)
    expect((error as ApiError).message).toBe('agent is busy')
    expect(chatErrorMessage(error)).toBe(BUSY_MESSAGE)
  })

  test('other errors keep their message', async () => {
    const { fetch } = fakeFetch(() => new Response('nope', { status: 403, statusText: 'Forbidden' }))
    const error = await streamAugment({ message: 'Hi' }, () => undefined, undefined, fetch).catch((caught: unknown) => caught)
    expect((error as ApiError).status).toBe(403)
    expect(chatErrorMessage(error)).toBe('403 Forbidden')
  })
})
