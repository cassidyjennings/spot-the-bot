// Thin LLM provider wrapper + queue. Only the question text and persona ever leave the server:
// no group names, session ids or instructor info.
import type { LlmRequest, LlmResult } from '../../shared/engine';

export interface LlmEnv {
  LLM_PROVIDER?: string; // 'gemini'
  LLM_MODEL?: string;
  LLM_MODE?: string; // 'mock' | 'live'
  LLM_API_KEY?: string;
}

type Attempt = LlmResult | { kind: 'ratelimit' };

const TIMEOUT_MS = 20_000;
const DECLINE = '[[DECLINE]]';
const BLOCK_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);

async function geminiOnce(env: LlmEnv, system: string, req: LlmRequest): Promise<Attempt> {
  const model = env.LLM_MODEL || 'gemini-3.1-flash-lite';
  const contents = [
    ...req.history.flatMap((h) => [
      { role: 'user', parts: [{ text: h.q }] },
      { role: 'model', parts: [{ text: h.a }] },
    ]),
    { role: 'user', parts: [{ text: req.question }] },
  ];
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.LLM_API_KEY ?? '' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature: 1, maxOutputTokens: 1024 },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 429) return { kind: 'ratelimit' };
  if (!res.ok) return { kind: 'error', msg: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const body: any = await res.json();
  if (body.promptFeedback?.blockReason) return { kind: 'decline' };
  const cand = body.candidates?.[0];
  if (!cand || BLOCK_REASONS.has(cand.finishReason)) return { kind: 'decline' };
  const text: string = (cand.content?.parts ?? [])
    .filter((p: any) => !p.thought)
    .map((p: any) => p.text ?? '')
    .join('')
    .trim();
  if (!text || text.includes(DECLINE)) return { kind: 'decline' };
  return { kind: 'ok', text: text.slice(0, 500) };
}

const MOCK = [
  "idk honestly, probably pizza? that's kind of a boring answer tho",
  'lol i was literally just thinking about that',
  "hmm i'd say summer bc no school but winter break is also goated",
  "not really sure, i've never thought about it tbh",
  'my friend would say basketball but i like soccer more',
  'ok that is a weird question but i respect it',
  "probably sleeping in. saturdays are for that",
  "wait what do you mean by that",
];

async function mockOnce(req: LlmRequest): Promise<Attempt> {
  await new Promise((r) => setTimeout(r, 800 + Math.random() * 2500));
  const q = req.question.toLowerCase();
  if (q.includes('mockdecline')) return { kind: 'decline' };
  if (q.includes('mockfail')) return { kind: 'error', msg: 'mock failure' };
  return { kind: 'ok', text: MOCK[Math.floor(Math.random() * MOCK.length)] };
}

/**
 * One normal retry for errors/timeouts; extra exponential-backoff retries for 429s.
 * onRateLimit(true) fires while we're backing off so instructors see a warning.
 */
export async function answerWithRetry(
  env: LlmEnv,
  system: string,
  req: LlmRequest,
  onRateLimit: (limited: boolean) => void,
): Promise<LlmResult> {
  const once = env.LLM_MODE === 'mock' ? () => mockOnce(req) : () => geminiOnce(env, system, req);
  let failures = 0;
  let limits = 0;
  for (;;) {
    let r: Attempt;
    try {
      r = await once();
    } catch (e: any) {
      r = { kind: 'error', msg: e?.name === 'TimeoutError' ? 'timed out after 20 s' : String(e?.message ?? e) };
    }
    if (r.kind === 'ratelimit') {
      onRateLimit(true);
      if (++limits > 4) return { kind: 'error', msg: 'rate limited (429) after retries' };
      await new Promise((res) => setTimeout(res, 2000 * 2 ** (limits - 1)));
      continue;
    }
    if (r.kind === 'error' && ++failures < 2) continue;
    if (r.kind === 'ok') onRateLimit(false);
    return r;
  }
}

/** Concurrency-limited FIFO queue. */
export class LlmQueue {
  private waiting: (() => void)[] = [];
  private running = 0;
  constructor(private concurrency: number, private onDepth: (queued: number) => void) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) {
      // The finishing job hands its slot straight to us, so `running` stays the same.
      await new Promise<void>((r) => {
        this.waiting.push(r);
        this.onDepth(this.waiting.length);
      });
    } else {
      this.running++;
    }
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
      this.onDepth(this.waiting.length);
    }
  }
}
