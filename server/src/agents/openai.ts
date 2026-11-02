import type { AgentTurnOpts, AgentTurnResult } from './sdk.ts';
import { MODEL_IDS, MODEL_INFO } from '../../../shared/models.ts';

/**
 * OpenAI Responses API client for debate agent turns.
 *
 * This is the OTHER half of the provider seam: sdk.ts spawns the Claude Code
 * CLI as a subprocess; this module speaks HTTPS to `POST /v1/responses` with
 * raw fetch and no dependency, matching the repo's zero-dep style (see the
 * hand-rolled .env loader in config.ts). It implements the SAME contract as
 * runAgent/runJsonAgent for the CONVERSATIONAL path: system+prompt in,
 * { text | value, sessionId } out, where sessionId is the OpenAI response id
 * and `resume` maps to `previous_response_id`.
 *
 * What it deliberately does NOT do: tools. An OpenAI session has no Claude
 * CLI, therefore no file tools, no python interpreter, no WebSearch. Callers
 * gate on the debate's provider; when a tool-expecting call lands here
 * anyway, an honest capability note is appended to the instructions so the
 * model says "I cannot verify this" instead of pretending it ran something.
 *
 * DEPENDENCY RULE: the only runtime import is shared/models.ts, which has no
 * side effects. sdk.ts wires the usage ledger and config in via wireOpenAI()
 * at boot. That keeps the selftest able to import this file without
 * triggering config.ts's side effects (data-dir creation, .env load), and
 * makes every request buildable against a mock fetch.
 */

// ---- provider identity ----

/** The OpenAI ids this app runs. The ids themselves live in shared/models.ts. */
export const OPENAI_MODEL_IDS = Object.values(MODEL_IDS.openai);

export function isOpenAIModel(model: string): boolean {
  return model.startsWith('gpt-') || model.startsWith('o3') || model.startsWith('o4');
}

// ---- pricing ----

/**
 * USD per million tokens, from shared/models.ts. Reasoning tokens are billed
 * AS OUTPUT and arrive inside usage.output_tokens. Long-context surcharges
 * are not modelled, so very long sessions can be under-reported.
 */
export function estimateCostUsd(model: string, usage: { input: number; cacheRead: number; output: number }): number {
  // Unknown model: price at the dearest so spend is never under-reported.
  const p = MODEL_INFO[model]?.inPerMTok !== undefined ? MODEL_INFO[model] : MODEL_INFO[MODEL_IDS.openai.flagship];
  return (
    (usage.input * (p.inPerMTok ?? 0) + usage.cacheRead * (p.cachedInPerMTok ?? 0) + usage.output * (p.outPerMTok ?? 0)) / 1_000_000
  );
}

// ---- wiring from sdk.ts (no runtime imports, see header) ----

interface UsageSink {
  bump(debateId: string, turn: {
    input?: number; output?: number; cacheWrite?: number; cacheRead?: number;
    webSearches?: number; costUsd?: number;
  }): void;
  role(debateId: string, label: string | undefined, usd: number): void;
}

const wiring: {
  usage: UsageSink | null;
  defaultTimeoutMs: number;
  maxConcurrent: number;
  fetchImpl: typeof fetch;
  /** OPENAI_API_KEY, handed in by sdk.ts from config. Never logged, never returned. */
  apiKey: string;
} = {
  usage: null,
  defaultTimeoutMs: 10 * 60_000,
  maxConcurrent: 3,
  fetchImpl: (...args) => fetch(...args),
  apiKey: '',
};

/** Called once from sdk.ts at boot; the selftest calls it with a mock fetch. */
export function wireOpenAI(w: Partial<typeof wiring>) {
  Object.assign(wiring, w);
}

/** Whether an API key is configured. Exposes nothing about the key itself. */
export const openAIConfigured = () => wiring.apiKey.trim().length > 0;

// ---- per-debate binding ----

/**
 * Which debates run on the OpenAI API. Resolved from debateId inside the
 * call, so a call site cannot route a debate to the wrong provider by
 * forgetting an argument. NOTHING in this file may log, return, or
 * serialise the key.
 */
const boundDebates = new Set<string>();

export const OpenAIKeys = {
  use(debateId: string) { boundDebates.add(debateId); },
  drop(debateId: string) { boundDebates.delete(debateId); },
  bound(debateId: string): boolean { return boundDebates.has(debateId); },
};

// ---- errors ----

/**
 * The OpenAI key was rejected (401/403) or is missing. Not retryable: the key
 * is wrong, not the moment. sdk.ts re-exports this so the driver can park the
 * session instead of marking it errored.
 */
export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

/**
 * Same name as sdk.ts's TurnTimeoutError ON PURPOSE: isTurnTimeout() and
 * abortedByUser() in sdk.ts duck-type on `err.name`, and a runtime import of
 * sdk.ts from here would drag config.ts's side effects into the selftest.
 */
class OpenAITurnTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`agent turn "${label}" exceeded its ${Math.round(ms / 1000)}s budget`);
    this.name = 'TurnTimeoutError';
  }
}

// ---- reasoning effort mapping ----

/**
 * Thinking-token budget -> reasoning.effort tier.
 *
 * The Claude path budgets thinking in TOKENS (CFG.*Thinking); the Responses
 * API budgets it in named effort tiers. The GPT-6 family supports
 * low/medium/high/xhigh/max, and Luna also `none`. The mapping keeps the
 * app's intent per seat:
 *
 *   tokens        effort    seats that land here
 *   <= 2_048   -> none      lint rewrites (0) and other fast-tier calls on Luna; `low` on any other model
 *   <= 12_000  -> low       steering (8_000)
 *   <= 32_000  -> medium    floor (24_000), referee/chair (32_000)
 *   <= 48_000  -> high      —
 *   >  48_000  -> xhigh     architect/planning/report (60_000)
 *
 * `max` is deliberately never emitted: reasoning bills as output tokens at
 * output rates, and `max` on every heavy seat would multiply the bill for
 * marginal depth. If you want it, it is one line here.
 */
export function effortFor(thinkingTokens: number | undefined, model = ''): 'none' | 'low' | 'medium' | 'high' | 'xhigh' {
  const t = thinkingTokens ?? 32_000;
  if (t <= 2_048) return model === MODEL_IDS.openai.fast ? 'none' : 'low';
  if (t <= 12_000) return 'low';
  if (t <= 32_000) return 'medium';
  if (t <= 48_000) return 'high';
  return 'xhigh';
}

// ---- request building ----

const ENDPOINT = 'https://api.openai.com/v1/responses';

/**
 * The output ceiling, mirroring CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000 in
 * sdk.ts's cleanEnv and for the same reason: reasoning counts against the
 * output cap, and the final report alone is ~30K tokens of JSON. 64K gives
 * reasoning and a full-length deliverable
 * room to coexist without doubling the worst-case spend.
 */
const MAX_OUTPUT_TOKENS = 64_000;

export interface JsonFormat {
  name: string;
  schema: Record<string, unknown>;
}

export function buildRequestBody(opts: AgentTurnOpts, format?: JsonFormat | 'json_object'): Record<string, unknown> {
  let instructions = opts.system;
  /**
   * Honest degradation, stated to the model rather than papered over: a call
   * built for the Claude toolchain (web research, dossier Read, python) may
   * still land here; the runner gates most of them off. The one thing worse than a seat without tools is a seat without tools
   * that writes as if it used them.
   */
  if ((opts.web || opts.tools?.length) && !opts.openaiTools?.length) {
    instructions +=
      '\n\nCAPABILITY NOTE: In this session you have NO web access, NO file tools and NO code interpreter. ' +
      'Say plainly when a figure or source cannot be verified without them. Never invent a citation, a file quote, or a computed number.';
  }

  const body: Record<string, unknown> = {
    model: opts.model,
    instructions,
    input: [{ role: 'user', content: opts.prompt }],
    // store:true is the API default and REQUIRED for previous_response_id
    // continuation — the whole persona-memory mechanism rides on it.
    store: true,
    stream: true,
    reasoning: { effort: effortFor(opts.thinking, opts.model), summary: 'auto' },
    max_output_tokens: MAX_OUTPUT_TOKENS,
    // temperature deliberately absent: reasoning models reject it.
  };
  if (opts.resume) body.previous_response_id = opts.resume;
  // The research desk's web_search tool, and the search sources it asks to see.
  if (opts.openaiTools?.length) body.tools = opts.openaiTools;
  if (opts.openaiInclude?.length) body.include = opts.openaiInclude;
  // Without it a web_search response may search as often as it likes, and every
  // search's retrieved text is billed as input.
  if (opts.openaiTools?.length && opts.openaiMaxToolCalls) body.max_tool_calls = opts.openaiMaxToolCalls;

  if (format === 'json_object') {
    body.text = { format: { type: 'json_object' } };
    // Chat Completions' JSON mode refused prompts that never said "JSON"; the
    // Responses docs do not promise otherwise, so guard the cheap way.
    if (!/json/i.test(opts.system) && !/json/i.test(opts.prompt)) {
      (body.input as any[]).push({ role: 'user', content: 'Respond with a single JSON object.' });
    }
  } else if (format) {
    body.text = {
      format: {
        type: 'json_schema',
        name: format.name,
        schema: format.schema,
        strict: true,
      },
    };
  }
  return body;
}

// ---- SSE parsing ----

interface StreamOutcome {
  responseId: string | null;
  text: string;
  usage: { input: number; output: number; cacheWrite: number; cacheRead: number };
  status: 'completed' | 'incomplete' | 'failed';
  errorMessage: string | null;
  /** The final response object (output items, annotations, search calls). */
  response: any;
}

/**
 * Consume a Responses SSE stream. Semantic events, one JSON object per
 * `data:` line, `type` inside the payload mirroring the `event:` line — so the
 * payload alone is parsed and the `event:` lines are ignored. No [DONE]
 * sentinel in this API; guarded anyway because it costs one comparison.
 */
export async function consumeSSE(
  bodyStream: ReadableStream<Uint8Array>,
  handlers: { onDelta?: (t: string) => void; onThinking?: (t: string) => void }
): Promise<StreamOutcome> {
  const out: StreamOutcome = {
    responseId: null,
    text: '',
    usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    status: 'failed',
    errorMessage: null,
    response: null,
  };
  let streamed = '';

  const decoder = new TextDecoder();
  const reader = bodyStream.getReader();
  let buf = '';

  const handleEvent = (ev: any) => {
    switch (ev?.type) {
      case 'response.created':
        out.responseId = ev.response?.id ?? out.responseId;
        break;
      case 'response.output_text.delta':
        if (typeof ev.delta === 'string' && ev.delta) {
          streamed += ev.delta;
          handlers.onDelta?.(ev.delta);
        }
        break;
      case 'response.reasoning_summary_text.delta':
        if (typeof ev.delta === 'string' && ev.delta) handlers.onThinking?.(ev.delta);
        break;
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        const r = ev.response ?? {};
        out.response = r;
        out.responseId = r.id ?? out.responseId;
        out.status = ev.type === 'response.completed' ? 'completed'
          : ev.type === 'response.incomplete' ? 'incomplete' : 'failed';
        // Prefer the final assembled output over our own concatenation.
        const finalText = Array.isArray(r.output)
          ? r.output
              .filter((item: any) => item?.type === 'message')
              .flatMap((item: any) => (Array.isArray(item.content) ? item.content : []))
              .filter((c: any) => c?.type === 'output_text' && typeof c.text === 'string')
              .map((c: any) => c.text)
              .join('')
          : '';
        out.text = finalText || streamed;
        const u = r.usage ?? {};
        const cached = u.input_tokens_details?.cached_tokens ?? 0;
        out.usage = {
          // The ledger's `input` means UNCACHED input, as on the Claude path.
          input: Math.max(0, (u.input_tokens ?? 0) - cached),
          output: u.output_tokens ?? 0, // includes reasoning tokens, billed as output
          cacheWrite: 0,                // OpenAI does not bill cache writes separately
          cacheRead: cached,
        };
        if (out.status === 'failed') out.errorMessage = r.error?.message ?? 'response failed';
        if (out.status === 'incomplete') {
          out.errorMessage = r.incomplete_details?.reason
            ? `response incomplete: ${r.incomplete_details.reason}`
            : 'response incomplete';
        }
        break;
      }
      case 'error':
        out.errorMessage = ev.message ?? 'stream error';
        break;
      default:
        break; // lifecycle noise (output_item.added, content_part.*, ...) is ignorable
    }
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          handleEvent(JSON.parse(data));
        } catch {
          /* partial or malformed frame: skip */
        }
      }
    }
  }
  if (!out.text) out.text = streamed;
  return out;
}

// ---- semaphore (own lane; these are fetches, not subprocesses) ----

let running = 0;
const waiters: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (running < wiring.maxConcurrent) { running++; return; }
  await new Promise<void>((resolve) => waiters.push(resolve));
  running++;
}
function release() {
  running--;
  waiters.shift()?.();
}

// ---- in-flight registry (so a stop request kills OpenAI turns too) ----

const inflight = new Map<string, Set<AbortController>>();

/** Called by sdk.abortDebate. Returns how many turns were killed. */
export function abortOpenAIDebate(debateId: string): number {
  const set = inflight.get(debateId);
  if (!set?.size) return 0;
  const n = set.size;
  for (const c of set) {
    try { c.abort(); } catch { /* already gone */ }
  }
  set.clear();
  return n;
}

// ---- core turn ----

async function runOnceOpenAI(opts: AgentTurnOpts, format?: JsonFormat | 'json_object'): Promise<AgentTurnResult> {
  const key = opts.debateId && boundDebates.has(opts.debateId) ? wiring.apiKey.trim() : '';
  if (!key) {
    throw new CredentialError(
      'This session runs on the OpenAI API, and no OPENAI_API_KEY is configured. Add it to .env, press Re-check on the Connect screen, and resume the debate.'
    );
  }

  const abort = new AbortController();
  const budgetMs = opts.timeoutMs ?? wiring.defaultTimeoutMs;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, budgetMs);

  if (opts.debateId) {
    let set = inflight.get(opts.debateId);
    if (!set) inflight.set(opts.debateId, (set = new Set()));
    set.add(abort);
  }
  if (opts.signal) {
    if (opts.signal.aborted) abort.abort();
    else opts.signal.addEventListener('abort', () => abort.abort(), { once: true });
  }

  try {
    const res = await wiring.fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildRequestBody(opts, format)),
      signal: abort.signal,
    });

    if (!res.ok) {
      let detail = '';
      try {
        const body: any = await res.json();
        detail = String(body?.error?.message ?? '');
      } catch { /* non-JSON error body */ }
      if (res.status === 401 || res.status === 403) {
        /**
         * The one failure that must never be retried and never carry detail
         * that could echo the key. OpenAI's own 401 body quotes a redacted but
         * identifying fragment ("Incorrect API key provided: sk-proj-****xyz"),
         * and this message reaches nine console.error sites, so the fragment
         * would land in the server log on every revoked key. The generic
         * sentence already says everything actionable.
         */
        throw new CredentialError(
          `OpenAI rejected this session's API key (HTTP ${res.status}). The key may be revoked or out of credit.`
        );
      }
      if (res.status === 429) {
        // Worded so sdk.asUsageLimit() recognises it and the driver parks
        // instead of marking the session errored. Retry-After, when sent, is
        // carried in the wording so the pause wakes when OpenAI said to.
        const ra = res.headers?.get?.('retry-after');
        const secs = ra ? (/^\d+(?:\.\d+)?$/.test(ra.trim()) ? Number(ra) : Math.round((Date.parse(ra) - Date.now()) / 1000)) : NaN;
        const after = Number.isFinite(secs) && secs > 0 ? ` (retry after ${Math.ceil(secs)}s)` : '';
        throw new Error(`429 rate limit from OpenAI${after}: ${detail || 'too many requests'}`);
      }
      throw new Error(`OpenAI /v1/responses failed (HTTP ${res.status}): ${detail || res.statusText}`);
    }
    if (!res.body) throw new Error('OpenAI returned no response body for a streaming request');

    const outcome = await consumeSSE(res.body, { onDelta: opts.onDelta, onThinking: opts.onThinking });

    if (outcome.status === 'failed') {
      throw new Error(`OpenAI response failed: ${outcome.errorMessage ?? 'unknown error'}`);
    }
    // `incomplete` (hit max_output_tokens, or content filter) still carries
    // whatever text was produced; an empty incomplete is an error.
    if (!outcome.text.trim()) {
      throw new Error(
        `agent turn produced no text (${opts.label ?? 'unlabeled'})${outcome.errorMessage ? `: ${outcome.errorMessage}` : ''}`
      );
    }

    /**
     * Token cost only. A web_search call also carries a per-call charge that
     * is not in `usage`; where the API reports it is one of the things the
     * owner-approved probe (R2) settles, so searches are counted here and not
     * priced rather than priced from a guess.
     */
    const costUsd = estimateCostUsd(opts.model, outcome.usage);
    const searches = Array.isArray(outcome.response?.output)
      ? outcome.response.output.filter((o: any) => o?.type === 'web_search_call').length
      : 0;
    if (opts.debateId && wiring.usage) {
      wiring.usage.role(opts.debateId, opts.label, costUsd);
      wiring.usage.bump(opts.debateId, {
        input: outcome.usage.input,
        output: outcome.usage.output,
        cacheWrite: 0,
        cacheRead: outcome.usage.cacheRead,
        webSearches: searches,
        costUsd,
      });
    }

    return {
      text: outcome.text.trim(),
      sessionId: outcome.responseId,
      costUsd,
      usage: outcome.usage,
      // No local tools on this path (the audit gate reads this honestly); a
      // research turn's server-side web_search calls are in `raw`.
      toolCalls: [],
      ...(opts.openaiTools?.length ? { raw: outcome.response } : {}),
    };
  } catch (err) {
    if (timedOut) throw new OpenAITurnTimeoutError(opts.label ?? 'unlabeled', budgetMs);
    throw err;
  } finally {
    clearTimeout(timeout);
    if (opts.debateId) inflight.get(opts.debateId)?.delete(abort);
  }
}

// Timeouts were already converted to TurnTimeoutError in runOnceOpenAI, so a
// surviving AbortError can only be a user stop.
const abortedByUser = (err: unknown): boolean => (err as any)?.name === 'AbortError';

/**
 * runAgent, OpenAI edition. Same retry posture as sdk.runAgent: two attempts,
 * but never for a user stop, a bad credential, or a rate limit — retrying any
 * of those is at best useless and at worst hammers a cooldown on someone
 * else's bill.
 */
export async function runAgentOpenAI(opts: AgentTurnOpts, format?: JsonFormat | 'json_object'): Promise<AgentTurnResult> {
  await acquire();
  const started = Date.now();
  try {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await runOnceOpenAI(opts, format);
        const u = res.usage;
        console.log(
          `[agent:openai] ${opts.label ?? '?'} ok in ${Math.round((Date.now() - started) / 1000)}s` +
            (res.costUsd ? ` ($${res.costUsd.toFixed(3)})` : '') +
            ` [in=${u.input} out=${u.output} cr=${u.cacheRead}]`
        );
        return res;
      } catch (err) {
        lastErr = err;
        if ((err as any)?.name === 'TurnTimeoutError') throw err;
        if (abortedByUser(err)) {
          console.log(`[agent:openai] ${opts.label ?? '?'} aborted by stop request`);
          throw err;
        }
        if (err instanceof CredentialError) {
          console.log(`[agent:openai] ${opts.label ?? '?'} credential refused; not retrying`);
          throw err;
        }
        if (/\b429\b|rate limit/i.test(String((err as any)?.message ?? ''))) {
          console.log(`[agent:openai] ${opts.label ?? '?'} rate limited; not retrying`);
          throw err;
        }
        console.error(`[agent:openai] ${opts.label ?? '?'} attempt ${attempt} failed:`, err);
      }
    }
    throw lastErr;
  } finally {
    release();
  }
}

// ---- JSON turns ----

/** Local copy of sdk.extractJson (6 lines) — a runtime import would drag in config.ts. */
export function extractJsonLoose(text: string): any {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object found');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * runJsonAgent, OpenAI edition — same contract and the same retry-on-invalid
 * behavior as sdk.runJsonAgent: parse, validate, and on failure resume the
 * SAME response chain (previous_response_id) with the parse error so the
 * model corrects itself, three attempts.
 *
 * When the caller supplies `opts.schema`, the request uses the Responses API's
 * structured outputs (`text.format: { type: "json_schema", strict: true }`),
 * which makes malformed JSON near-impossible; the retry loop then only ever
 * fires on a `validate` rejection. Without a schema (today's callers pass
 * none — sdk.ts never needed one), JSON mode (`json_object`) plus the loose
 * extractor gives the same behavior the Claude path has.
 */
export async function runJsonAgentOpenAI<T>(
  opts: AgentTurnOpts,
  validate?: (v: any) => T
): Promise<{ value: T; sessionId: string | null; toolCalls: { name: string; command: string | null }[]; costUsd: number; usage: AgentTurnResult['usage'] }> {
  const format: JsonFormat | 'json_object' = opts.schema
    ? { name: opts.schema.name, schema: opts.schema.schema }
    : 'json_object';

  let turn = await runAgentOpenAI(opts, format);
  let costUsd = turn.costUsd;
  const usage = { ...turn.usage };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const value = extractJsonLoose(turn.text);
      return { value: validate ? validate(value) : (value as T), sessionId: turn.sessionId, toolCalls: [], costUsd, usage };
    } catch (err) {
      if (attempt === 2) throw new Error(`JSON agent failed after retries (${opts.label}): ${err}`);
      turn = await runAgentOpenAI(
        {
          ...opts,
          resume: turn.sessionId ?? opts.resume,
          prompt: `Your previous output could not be used: ${String(err).slice(0, 300)}\nOutput ONLY the corrected strict JSON. No prose, no code fences.`,
        },
        format
      );
      costUsd += turn.costUsd;
      usage.input += turn.usage.input;
      usage.output += turn.usage.output;
      usage.cacheWrite += turn.usage.cacheWrite;
      usage.cacheRead += turn.usage.cacheRead;
    }
  }
  throw new Error('unreachable');
}
