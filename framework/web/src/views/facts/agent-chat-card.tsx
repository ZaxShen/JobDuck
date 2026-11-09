import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { BotIcon, LoaderCircleIcon, MessageSquarePlusIcon, SendIcon, SquareIcon, WrenchIcon } from 'lucide-react'
import { CopyPromptButton } from '@/components/composed/copy-prompt-button'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  AGENT_STATUS_PATH,
  COPY_PROMPT,
  MAX_MESSAGE_CHARS,
  chatErrorMessage,
  chatReducer,
  initialChat,
  streamAugment,
  type AgentMessage,
  type AgentStatus,
  type ChatMessage,
} from '@/lib/agent-chat'
import { fetchJSON } from '@/lib/api'
import { cn } from '@/lib/utils'

const STICK_PX = 48

function AgentReply({ message }: { message: AgentMessage }) {
  const waiting = message.pending && message.text === ''
  return (
    <div className="flex max-w-[90%] flex-col gap-1.5 self-start">
      {message.tools.length > 0 && (
        <ul aria-label="Tools used" className="flex flex-wrap gap-1">
          {message.tools.map((label) => (
            <li key={label}>
              <Badge variant="secondary">
                <WrenchIcon aria-hidden="true" />
                {label}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {(message.text !== '' || waiting) && (
        <div className="rounded-lg bg-muted px-3 py-2 text-sm break-words whitespace-pre-wrap text-foreground">
          {waiting ? (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <LoaderCircleIcon className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
              Thinking…
            </span>
          ) : message.text}
        </div>
      )}
      {message.denials.length > 0 && (
        <p className="text-xs text-muted-foreground">Blocked in this chat: {message.denials.join(', ')}.</p>
      )}
      {message.error !== null ? (
        <p className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm break-words text-destructive">
          {message.error}
        </p>
      ) : message.isError && (
        <p className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Your agent stopped with an error. Send your message again or start a New Chat.
        </p>
      )}
      {message.stopped && <p className="text-xs text-muted-foreground">Stopped.</p>}
    </div>
  )
}

function Transcript({ messages, running }: { messages: ChatMessage[]; running: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useLayoutEffect(() => {
    const node = ref.current
    if (node && stick.current) node.scrollTop = node.scrollHeight
  }, [messages])

  const onScroll = () => {
    const node = ref.current
    if (node) stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_PX
  }

  return (
    <div
      ref={ref}
      role="log"
      aria-label="Conversation with your agent"
      aria-busy={running}
      tabIndex={0}
      onScroll={onScroll}
      className="flex max-h-96 flex-col gap-3 overflow-y-auto overscroll-contain rounded-lg border p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {messages.map((message, index) => message.role === 'user' ? (
        <p key={index} className="max-w-[90%] self-end rounded-lg bg-primary px-3 py-2 text-sm break-words whitespace-pre-wrap text-primary-foreground">
          <span className="sr-only">You: </span>
          {message.text}
        </p>
      ) : <AgentReply key={index} message={message} />)}
    </div>
  )
}

function Chat({ status, onDone }: { status: AgentStatus; onDone: () => void }) {
  const [state, dispatch] = useReducer(chatReducer, initialChat)
  const [draft, setDraft] = useState('')
  const controller = useRef<AbortController | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => () => controller.current?.abort(), [])

  const send = useCallback(async () => {
    const message = draft.trim()
    if (message === '' || state.running) return
    const abort = new AbortController()
    controller.current = abort
    setDraft('')
    dispatch({ type: 'send', message })
    input.current?.focus()
    try {
      await streamAugment({ message, sessionId: state.sessionId }, (event) => {
        dispatch({ type: 'event', event })
        if (event.type === 'done') onDone()
      }, abort.signal)
      dispatch({ type: 'end' })
    } catch (error) {
      dispatch(abort.signal.aborted ? { type: 'stopped' } : { type: 'fail', message: chatErrorMessage(error) })
    } finally {
      if (controller.current === abort) controller.current = null
      if (document.activeElement === document.body) input.current?.focus()
    }
  }, [draft, state.running, state.sessionId, onDone])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void send()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void send()
  }

  const reset = () => {
    dispatch({ type: 'reset' })
    setDraft('')
    input.current?.focus()
  }

  return (
    <div className="flex flex-col gap-3">
      {state.messages.length > 0 && <Transcript messages={state.messages} running={state.running} />}
      <form onSubmit={submit} className="flex flex-col gap-2">
        <label htmlFor="agent-chat-message" className="sr-only">Message to {status.label}</label>
        <Textarea
          ref={input}
          id="agent-chat-message"
          name="message"
          value={draft}
          maxLength={MAX_MESSAGE_CHARS}
          rows={2}
          autoComplete="off"
          placeholder="Augment my profile…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-48"
        />
        <div className="flex flex-wrap items-center gap-2">
          {state.running ? (
            <Button type="button" variant="outline" size="sm" onClick={() => controller.current?.abort()}>
              <SquareIcon data-icon="inline-start" aria-hidden="true" />
              Stop
            </Button>
          ) : (
            <Button type="submit" size="sm" disabled={draft.trim() === ''}>
              <SendIcon data-icon="inline-start" aria-hidden="true" />
              Send
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" disabled={state.running || state.messages.length === 0} onClick={reset}>
            <MessageSquarePlusIcon data-icon="inline-start" aria-hidden="true" />
            New Chat
          </Button>
          <CopyPromptButton prompt={COPY_PROMPT} />
          <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">Enter to send, Shift+Enter for a new line</span>
        </div>
      </form>
    </div>
  )
}

function Fallback() {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-muted-foreground">
        Open Claude Code, Codex or Gemini CLI in your Job Duck workspace folder and paste this prompt to have it propose facts here.
      </p>
      <CopyPromptButton prompt={COPY_PROMPT} />
    </div>
  )
}

export function AgentChatCard({ onDone }: { onDone: () => void }) {
  const [status, setStatus] = useState<AgentStatus | null>(null)

  useEffect(() => {
    let live = true
    fetchJSON<AgentStatus>(AGENT_STATUS_PATH)
      .then((next) => live && setStatus(next))
      .catch(() => live && setStatus({ available: false, host: '', label: '' }))
    return () => {
      live = false
    }
  }, [])

  const available = status?.available === true

  return (
    <Card className={cn('shadow-sm', !available && 'bg-muted/40')}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BotIcon className="size-4 text-primary" aria-hidden="true" />
          <h2>Ask Your Agent</h2>
        </CardTitle>
        <CardDescription>
          {available
            ? 'Chat with your agent to turn your Experience into facts. Facts it saves appear below as Proposed for you to review.'
            : 'Have your agent read your Experience and propose facts for you to review.'}
        </CardDescription>
        {available && (
          <CardAction>
            <Badge variant="outline">{status.label}</Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {status === null ? <Skeleton className="h-16 w-full" /> : available ? <Chat status={status} onDone={onDone} /> : <Fallback />}
      </CardContent>
    </Card>
  )
}
