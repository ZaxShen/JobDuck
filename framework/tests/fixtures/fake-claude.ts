import { appendFileSync } from 'node:fs'

const FAKE_SESSION_ID = '00000000-0000-4000-8000-000000000001'

const argv = process.argv.slice(2)
const fake: Record<string, string> = {}
let first = 0
while (argv[first]?.startsWith('--fake-')) {
  const [key, value = ''] = argv[first]!.slice('--fake-'.length).split(/=(.*)/s)
  fake[key!] = value
  first += 1
}
const args = argv.slice(first)
const mode = fake.mode ?? 'ok'

const chunks: Buffer[] = []
for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
const stdin = Buffer.concat(chunks).toString('utf8')
if (fake.out) appendFileSync(fake.out, `${JSON.stringify({ pid: process.pid, args, stdin })}\n`)

const emit = (line: unknown) => process.stdout.write(`${JSON.stringify(line)}\n`)

if (mode === 'crash') {
  process.stderr.write('fake-claude: boom while loading the session\n')
  process.exit(1)
}

const resume = args.indexOf('--resume')
const sessionId = resume === -1 ? FAKE_SESSION_ID : args[resume + 1]!

emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'opus', tools: [] })

if (mode === 'hang') {
  setInterval(() => undefined, 1000)
} else {
  emit({ type: 'stream_event', session_id: sessionId, event: { type: 'message_start' } })
  emit({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me look at ' } } })
  emit({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'your Acme role.' } } })
  emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: 'Let me look at your Acme role.' }] } })
  emit({
    type: 'assistant',
    session_id: sessionId,
    message: { content: [{ type: 'tool_use', id: 'toolu_fake_1', name: 'mcp__jobduck__save_profile_facts', input: { facts: [] } }] },
  })
  emit({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_fake_1' }] } })
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    result: 'Let me look at your Acme role.',
    permission_denials: [{ tool_name: 'mcp__jobduck__update_profile_fact', tool_use_id: 'toolu_fake_2', tool_input: {} }],
  })
  if (mode === 'linger') setInterval(() => undefined, 1000)
}
