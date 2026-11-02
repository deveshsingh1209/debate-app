/**
 * OpenAI Responses client selftest — runs WITHOUT an API key and WITHOUT
 * touching the network, the config, or the database.
 *
 *   npx tsx server/src/agents/openai.selftest.ts     (from the repo root)
 *
 * Live end-to-end testing would spend real money, so the bar is "provably
 * correct against the documented contract".
 * Every request this app can make is built here against a MOCK fetch and
 * asserted field by field: endpoint, headers, strict-schema JSON body,
 * previous_response_id continuation, SSE parsing (text deltas, reasoning
 * summary deltas, usage), cost arithmetic, and the 401 -> CredentialError
 * path. Imports ONLY openai.ts (whose one runtime import, shared/models.ts,
 * has no side effects), so this file
 * cannot trip config.ts's side effects (data dir creation, .env load).
 */

import {
  OpenAIKeys,
  CredentialError,
  wireOpenAI,
  runAgentOpenAI,
  runJsonAgentOpenAI,
  buildRequestBody,
  effortFor,
  estimateCostUsd,
  OPENAI_MODEL_IDS,
} from './openai.ts';
import type { AgentTurnOpts } from './sdk.ts';

// ---- tiny harness ----

let passed = 0;
let failed = 0;
const fails: string[] = [];

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    fails.push(name);
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(name, g === w, `got ${g}, want ${w}`);
}

// ---- fixtures ----

const KEY = 'sk-proj-SELFTEST_FAKE_KEY_0000000000';
const DEBATE = 'selftest-debate';

/** Encode a list of event payloads as a Responses-API SSE body. */
function sse(events: object[]): string {
  return events
    .map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('');
}

function completedEvent(id: string, text: string, usage?: object) {
  return {
    type: 'response.completed',
    response: {
      id,
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Weighing the options.' }] },
        { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text }] },
      ],
      usage: usage ?? {
        input_tokens: 1200,
        input_tokens_details: { cached_tokens: 200 },
        output_tokens: 350,
        output_tokens_details: { reasoning_tokens: 300 },
        total_tokens: 1550,
      },
    },
  };
}

const happyStream = (id: string, text: string) =>
  sse([
    { type: 'response.created', response: { id, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'Weighing the ', sequence_number: 3 },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'options.', sequence_number: 4 },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: text.slice(0, 4), sequence_number: 5 },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: text.slice(4), sequence_number: 6 },
    completedEvent(id, text),
  ]);

/** A scriptable fetch: each call shifts the next response off the queue. */
interface Call { url: string; init: RequestInit; body: any }
const calls: Call[] = [];
let queue: (() => Response)[] = [];

const mockFetch: typeof fetch = async (input: any, init?: any) => {
  calls.push({ url: String(input), init: init ?? {}, body: init?.body ? JSON.parse(String(init.body)) : null });
  const next = queue.shift();
  if (!next) throw new Error('mock fetch queue empty');
  return next();
};

const sseResponse = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

// ---- usage sink recorder ----

const bumps: any[] = [];
const roles: any[] = [];
wireOpenAI({
  fetchImpl: mockFetch,
  defaultTimeoutMs: 30_000,
  maxConcurrent: 3,
  usage: {
    bump: (id, turn) => bumps.push({ id, ...turn }),
    role: (id, label, usd) => roles.push({ id, label, usd }),
  },
});

OpenAIKeys.use(DEBATE);
wireOpenAI({ apiKey: KEY });

const baseOpts: AgentTurnOpts = {
  model: 'gpt-6.1-sol',
  system: 'You are a debate expert. Answer in JSON when asked.',
  prompt: 'State your position.',
  debateId: DEBATE,
  label: 'selftest:floor',
  thinking: 24_000,
};

// ---- tests ----

async function main() {
  console.log('\n[1] pure helpers');
  eq('ids come from shared/models.ts', OPENAI_MODEL_IDS, ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna']);
  eq('effort for a fast-tier call on luna', effortFor(1_024, 'gpt-6-luna'), 'none');
  eq('effort for a small budget elsewhere floors at low', effortFor(1_024, 'gpt-6-astra'), 'low');
  eq('a lint rewrite (no thinking) on luna', effortFor(0, 'gpt-6-luna'), 'none');
  eq('effort steer', effortFor(8_000), 'low');
  eq('effort floor', effortFor(24_000), 'medium');
  eq('effort heavy', effortFor(60_000), 'xhigh');
  // sol: 1000 uncached * $2 + 200 cached * $0.20 + 350 out * $10, per MTok
  check('cost arithmetic', Math.abs(estimateCostUsd('gpt-6.1-sol', { input: 1000, cacheRead: 200, output: 350 }) - 0.00554) < 1e-9);
  // astra: $10 / $1 / $50
  check('cost arithmetic astra', Math.abs(estimateCostUsd('gpt-6-astra', { input: 1000, cacheRead: 200, output: 350 }) - 0.0277) < 1e-9);

  console.log('\n[2] request shape: endpoint, headers, body');
  queue = [() => sseResponse(happyStream('resp_a1', 'Position: hold.'))];
  const thinking: string[] = [];
  const deltas: string[] = [];
  const r1 = await runAgentOpenAI({ ...baseOpts, onThinking: (t) => thinking.push(t), onDelta: (t) => deltas.push(t) });
  const c1 = calls.at(-1)!;
  eq('endpoint', c1.url, 'https://api.openai.com/v1/responses');
  eq('method', c1.init.method, 'POST');
  eq('auth header', (c1.init.headers as any).authorization, `Bearer ${KEY}`);
  eq('content-type', (c1.init.headers as any)['content-type'], 'application/json');
  eq('body.model', c1.body.model, 'gpt-6.1-sol');
  eq('body.instructions', c1.body.instructions, baseOpts.system);
  eq('body.input', c1.body.input, [{ role: 'user', content: baseOpts.prompt }]);
  eq('body.stream', c1.body.stream, true);
  eq('body.store', c1.body.store, true);
  eq('body.reasoning', c1.body.reasoning, { effort: 'medium', summary: 'auto' });
  check('no temperature sent', !('temperature' in c1.body));
  check('no previous_response_id on fresh turn', !('previous_response_id' in c1.body));

  console.log('\n[3] SSE parse: text, reasoning deltas, session id, usage, cost');
  eq('result text', r1.text, 'Position: hold.');
  eq('sessionId = response id', r1.sessionId, 'resp_a1');
  eq('onThinking fed from reasoning summary deltas', thinking.join(''), 'Weighing the options.');
  eq('onDelta fed from output_text deltas', deltas.join(''), 'Position: hold.');
  eq('usage split (uncached input)', r1.usage, { input: 1000, output: 350, cacheWrite: 0, cacheRead: 200 });
  check('costUsd', Math.abs(r1.costUsd - 0.00554) < 1e-9, String(r1.costUsd));
  eq('toolCalls empty (no tools on this path)', r1.toolCalls, []);
  const b1 = bumps.at(-1)!;
  eq('ledger bump', { input: b1.input, output: b1.output, cacheRead: b1.cacheRead, webSearches: b1.webSearches }, { input: 1000, output: 350, cacheRead: 200, webSearches: 0 });
  eq('role spend recorded', roles.at(-1)!.label, 'selftest:floor');

  console.log('\n[4] previous_response_id continuation');
  queue = [() => sseResponse(happyStream('resp_a2', 'Continued.'))];
  const r2 = await runAgentOpenAI({ ...baseOpts, resume: 'resp_a1' });
  eq('continuation body carries previous_response_id', calls.at(-1)!.body.previous_response_id, 'resp_a1');
  eq('instructions re-sent on continuation (not inherited)', calls.at(-1)!.body.instructions, baseOpts.system);
  eq('new session id', r2.sessionId, 'resp_a2');

  console.log('\n[5] strict JSON schema mode');
  const schema = {
    name: 'verdict',
    schema: {
      type: 'object',
      properties: { answer: { type: 'integer' } },
      required: ['answer'],
      additionalProperties: false,
    },
  };
  queue = [() => sseResponse(happyStream('resp_j1', '{"answer":42}'))];
  const j1 = await runJsonAgentOpenAI<{ answer: number }>({ ...baseOpts, schema }, (v) => {
    if (typeof v.answer !== 'number') throw new Error('bad answer');
    return v;
  });
  const cj = calls.at(-1)!;
  eq('text.format strict json_schema shape', cj.body.text, {
    format: { type: 'json_schema', name: 'verdict', schema: schema.schema, strict: true },
  });
  eq('json value', j1.value, { answer: 42 });
  eq('json sessionId', j1.sessionId, 'resp_j1');

  console.log('\n[6] schema-less JSON mode (json_object) + retry-on-invalid');
  queue = [
    () => sseResponse(happyStream('resp_j2', 'sorry, prose instead of JSON')),
    () => sseResponse(happyStream('resp_j3', '{"answer":7}')),
  ];
  const before = calls.length;
  const j2 = await runJsonAgentOpenAI<{ answer: number }>({ ...baseOpts });
  eq('json_object format used when no schema', calls[before].body.text, { format: { type: 'json_object' } });
  eq('retry ran exactly once more', calls.length - before, 2);
  eq('retry resumes the SAME response chain', calls.at(-1)!.body.previous_response_id, 'resp_j2');
  check('retry prompt states the parse error', String(calls.at(-1)!.body.input[0].content).includes('could not be used'));
  eq('repaired value', j2.value, { answer: 7 });

  console.log('\n[7] json_object guard when nobody says JSON');
  const bodyNoJson = buildRequestBody({ ...baseOpts, system: 'You are terse.', prompt: 'Answer.' }, 'json_object');
  check('JSON instruction appended', (bodyNoJson.input as any[]).some((m) => /json/i.test(m.content)));
  const bodyWithJson = buildRequestBody(baseOpts, 'json_object');
  eq('no extra line when prompt already says JSON', (bodyWithJson.input as any[]).length, 1);

  console.log('\n[8] capability honesty for tool-shaped calls');
  const bodyTools = buildRequestBody({ ...baseOpts, web: true });
  check('capability note appended when web/tools requested', String(bodyTools.instructions).includes('NO web access'));

  console.log('\n[9] 401 -> CredentialError (no retry, key never echoed)');
  queue = [() => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }), { status: 401 })];
  const callsBefore401 = calls.length;
  let got: unknown = null;
  try {
    await runAgentOpenAI(baseOpts);
  } catch (e) {
    got = e;
  }
  check('CredentialError instance', got instanceof CredentialError, String((got as any)?.name));
  eq('error name', (got as any)?.name, 'CredentialError');
  eq('401 not retried', calls.length - callsBefore401, 1);
  check('key not echoed in the error', !String((got as any)?.message ?? '').includes(KEY));

  console.log('\n[10] missing key -> CredentialError before any request');
  const noKeyBefore = calls.length;
  let got2: unknown = null;
  try {
    await runAgentOpenAI({ ...baseOpts, debateId: 'debate-with-no-key' });
  } catch (e) {
    got2 = e;
  }
  check('unbound debate is a CredentialError', got2 instanceof CredentialError);
  eq('no network call made', calls.length, noKeyBefore);

  wireOpenAI({ apiKey: '' });
  let got2b: unknown = null;
  try {
    await runAgentOpenAI(baseOpts);
  } catch (e) {
    got2b = e;
  }
  wireOpenAI({ apiKey: KEY });
  check('no OPENAI_API_KEY configured is a CredentialError', got2b instanceof CredentialError);
  check('that error names the env var, never a key', /OPENAI_API_KEY/.test(String((got2b as any)?.message)) && !String((got2b as any)?.message).includes(KEY));
  eq('still no network call made', calls.length, noKeyBefore);

  console.log('\n[11] 429 surfaces in usage-limit wording (driver parks, no retry)');
  queue = [() => new Response(JSON.stringify({ error: { message: 'Rate limit reached for gpt-6.1-sol', type: 'rate_limit_error' } }), { status: 429 })];
  const before429 = calls.length;
  let got3: unknown = null;
  try {
    await runAgentOpenAI(baseOpts);
  } catch (e) {
    got3 = e;
  }
  check('429 mentions rate limit + code', /429/.test(String((got3 as any)?.message)) && /rate limit/i.test(String((got3 as any)?.message)));
  eq('429 not retried', calls.length - before429, 1);

  // ---- summary ----
  console.log(`\n${passed} passed, ${failed} failed${failed ? `: ${fails.join(', ')}` : ''}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('selftest crashed:', e);
  process.exit(1);
});
