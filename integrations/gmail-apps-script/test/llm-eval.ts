import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Truth = 'application' | 'rejection' | 'other';
type Message = { from: string; subject: string; date: string; body: string };
type Thread = { id: string; labels: unknown; messages: Message[] };
type Answer = { label: string; evidence: string };

const SKILL = join(import.meta.dirname, '..', '..', '..', 'framework', 'skills', 'sort-mail.md');
const MESSAGES_PER_THREAD = 3;
const BODY_CAP = 5000;
const MIN_EVIDENCE = 15;
const CALL_TIMEOUT_MS = 180_000;

function extractRubric(): string {
  const blocks = [...readFileSync(SKILL, 'utf8').matchAll(/^```text\n([\s\S]*?)\n```$/gm)];
  if (blocks.length !== 1) throw new Error(`expected one text block in ${SKILL}, found ${blocks.length}`);
  const rubric = blocks[0]![1]!;
  if (!rubric.includes('"label":"application|rejection|other"')) throw new Error('the text block is not the rubric');
  return rubric;
}

function truthOf(value: unknown): Truth {
  if (value === 'confirmation') return 'application';
  if (value === 'rejection') return 'rejection';
  return 'other';
}

function readTruths(corpus: string): Map<string, Truth> {
  const dir = join(corpus, 'labels');
  const truths = new Map<string, Truth>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const rows: { id: string; truth: unknown }[] = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    for (const row of rows) truths.set(String(row.id), truthOf(row.truth));
  }
  return truths;
}

const isMine = (message: Message, me: string) => message.from.toLowerCase().includes(me);

function buildInput(thread: Thread, me: string): string | null {
  const messages = thread.messages;
  if (messages.length === 0 || isMine(messages[messages.length - 1]!, me)) return null;
  return messages
    .filter((message) => !isMine(message, me))
    .slice(-MESSAGES_PER_THREAD)
    .map((m) => `<email>\nFrom: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\n\n${m.body.slice(0, BODY_CAP)}\n</email>`)
    .join('\n\n');
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

function parseAnswer(raw: string): Answer | null {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]);
    if (typeof value?.label !== 'string' || typeof value?.evidence !== 'string') return null;
    return { label: value.label, evidence: value.evidence };
  } catch {
    return null;
  }
}

const isMove = (label: string): label is 'application' | 'rejection' => label === 'application' || label === 'rejection';

function verified(answer: Answer, input: string): boolean {
  const evidence = collapse(answer.evidence);
  return evidence.length > MIN_EVIDENCE && collapse(input).includes(evidence);
}

function ask(model: string, rubric: string, input: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', '--model', model, '--setting-sources', '', '--strict-mcp-config', '--tools', '', '--system-prompt', rubric],
      { cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: CALL_TIMEOUT_MS },
    );
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}`))));
    child.stdin.end(input);
  });
}

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

async function evaluate(corpus: string, model: string, concurrency: number, me: string): Promise<number> {
  const rubric = extractRubric();
  const truths = readTruths(corpus);
  const cachePath = join(corpus, `llm-cache-${model}.json`);
  const cache: Record<string, string> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
  const cwd = mkdtempSync(join(tmpdir(), 'jobduck-llm-eval-'));

  const total = { application: 0, rejection: 0 };
  const moved = { application: 0, rejection: 0 };
  const wrong: string[] = [];
  let unverified = 0;
  let unparsed = 0;

  try {
    await pool([...truths.keys()], concurrency, async (id) => {
      const truth = truths.get(id)!;
      if (truth !== 'other') total[truth]++;
      const threadPath = join(corpus, 'threads', `${id}.json`);
      if (!existsSync(threadPath)) return;
      const input = buildInput(JSON.parse(readFileSync(threadPath, 'utf8')), me);
      if (input === null) return;

      const key = createHash('sha256').update(`${model}\0${rubric}\0${input}`).digest('hex');
      let raw = cache[key];
      if (raw === undefined) {
        try {
          raw = await ask(model, rubric, input, cwd);
        } catch {
          unparsed++;
          return;
        }
        cache[key] = raw;
        writeFileSync(cachePath, JSON.stringify(cache));
      }

      const answer = parseAnswer(raw);
      if (!answer) {
        unparsed++;
        return;
      }
      if (!isMove(answer.label)) return;
      if (!verified(answer, input)) {
        unverified++;
        return;
      }
      if (answer.label === truth) moved[truth]++;
      else wrong.push(id);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }

  console.log(`rejections moved: ${moved.rejection}/${total.rejection}`);
  console.log(`applications moved: ${moved.application}/${total.application}`);
  console.log(`wrong moves: ${wrong.length}${wrong.length ? ` (${wrong.sort().join(', ')})` : ''}`);
  console.log(`unverified: ${unverified}`);
  console.log(`unparsed: ${unparsed}`);
  return wrong.length ? 1 : 0;
}

async function main(args: string[]): Promise<number> {
  if (args[0] === '--check') {
    console.log(`rubric ok: ${extractRubric().length} characters from ${SKILL}`);
    return 0;
  }
  const [corpus, model = 'haiku', concurrencyArg = '6'] = args;
  const concurrency = Number(concurrencyArg);
  const me = process.env.JOBDUCK_ME?.trim().toLowerCase();
  if (!corpus || !Number.isInteger(concurrency) || concurrency < 1) {
    console.error('usage: node llm-eval.ts --check | node llm-eval.ts <corpusDir> [model=haiku] [concurrency=6]');
    return 2;
  }
  if (!me) {
    console.error('set JOBDUCK_ME to the mailbox owner address');
    return 2;
  }
  return evaluate(corpus, model, concurrency, me);
}

process.exitCode = await main(process.argv.slice(2));
