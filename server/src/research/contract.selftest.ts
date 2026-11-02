/**
 * The research contract suite (docs/PHASE2-PLAN.md 3.4). Every adapter is
 * driven by a recorded-style transport: a Claude Agent SDK message stream
 * through wireClaude({ queryImpl }), OpenAI Responses SSE through
 * wireOpenAI({ fetchImpl }), and a Codex event stream through
 * wireCodex({ codexFactory }). Nothing is spawned, nothing leaves the machine.
 *
 *   npx tsx src/research/contract.selftest.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-research-test-'));
process.env.DATA_DIR = dataDir;
process.env.MOCK = '';
process.env.AGENT_CLI_PATH = '/usr/bin/false';
delete process.env.OPENAI_API_KEY;

const { wireClaude, Usage, webFetchHook } = await import('../agents/sdk.ts');
const { wireOpenAI, OpenAIKeys } = await import('../agents/openai.ts');
const { wireCodex, CodexCreds, codexThreadOptions } = await import('../agents/codex.ts');
const { runResearch, wireResearch, forgetResearch } = await import('./index.ts');
// No page is ever fetched here: the transport reads nothing, so nothing leaves the machine.
(await import('./pages.ts')).wirePages({ transport: async () => null });
const { fakeResearch } = await import('./fake.ts');
const { Waste } = await import('../agents/waste.ts');
const { invariantBreaks, citationId, normaliseUrl, cleanUrl } = await import('./normalise.ts');
const { checkFetchUrl, nonPublic } = await import('./fetchguard.ts');
const F = await import('./fixtures.ts');
type ResearchResult = import('../../../shared/research.ts').ResearchResult;
type ResearchRequest = import('./types.ts').ResearchRequest;
type Provider = import('../../../shared/models.ts').Provider;

let fails = 0;
let passes = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) passes++;
  else fails++;
  console.log(`${cond ? '  ok  ' : '  FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};
const j = (v: unknown) => JSON.stringify(v);

const GOAL = 'Decide whether the bakery opens on Sundays.';
let n = 0;
const req = (debateId: string, over: Partial<ResearchRequest> = {}): ResearchRequest => ({
  id: `r_test_${++n}`, debateId, question: F.GOLDEN_QUESTION, askedBy: 'ana', purpose: 'crux',
  maxSources: 4, budget: { maxSearches: 4, timeoutMs: 20_000 }, ...over,
});

// ---------- transports ----------

type Mode = 'golden' | 'provenance' | 'hang' | 'error';
let claudeMode: Mode = 'golden';
const claudeSeen: any[] = [];
wireClaude({
  queryImpl: ((args: { prompt: string; options: any }) => {
    claudeSeen.push(args);
    const signal: AbortSignal = args.options.abortController.signal;
    return (async function* () {
      if (claudeMode === 'error') throw new Error('claude transport exploded');
      if (claudeMode === 'hang') {
        await new Promise((_r, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))));
      }
      for (const m of claudeMode === 'provenance' ? F.claudeProvenanceStream() : F.claudeGoldenStream()) yield m;
    })();
  }) as any,
});

let openaiMode: Mode = 'golden';
const openaiBodies: any[] = [];
OpenAIKeys.use('d_openai');
wireOpenAI({
  apiKey: 'sk-test-not-a-key',
  fetchImpl: (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    openaiBodies.push(body);
    if (openaiMode === 'error') return new Response(JSON.stringify({ error: { message: 'upstream unavailable' } }), { status: 500 });
    if (openaiMode === 'hang') {
      return await new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    const events = body.tools ? F.openaiBriefEvents() : F.openaiStructureEvents();
    return new Response(F.sse(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as any,
});

// A structurally real (fake, unsigned) Codex login.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (p: Record<string, unknown>) => `${b64({ alg: 'RS256' })}.${b64(p)}.FAKE`;
const CRED = JSON.stringify({
  auth_mode: 'chatgpt', OPENAI_API_KEY: null, last_refresh: '2026-10-26T10:00:00.000Z',
  tokens: {
    id_token: jwt({ sub: 'u', exp: 1, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test', chatgpt_plan_type: 'plus' } }),
    access_token: jwt({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: 'RT_TEST', account_id: 'acct-test',
  },
});
let codexMode: Mode = 'golden';
const codexSeen: { threadOptions: any; input: string; outputSchema: unknown }[] = [];
wireCodex({
  debateDir: (id: string) => { const d = path.join(dataDir, 'codex', id); fs.mkdirSync(d, { recursive: true }); return d; },
  codexFactory: async () => {
    const build = (threadOptions: any) => ({
      id: null,
      async runStreamed(input: string, turnOptions: any) {
        codexSeen.push({ threadOptions, input, outputSchema: turnOptions?.outputSchema });
        if (codexMode === 'error') {
          return { events: (async function* () { yield { type: 'turn.failed', error: { message: 'model overloaded' } } as any; })() };
        }
        if (codexMode === 'hang') {
          return { events: (async function* () {
            await new Promise((_r, reject) => turnOptions.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
          })() };
        }
        return { events: (async function* () { for (const e of F.codexEvents()) yield e as any; })() };
      },
    });
    return { startThread: (o: any) => build(o), resumeThread: (_id: string, o: any) => build(o) } as any;
  },
});
CodexCreds.use('d_codex', CRED, () => {});

const DEBATE: Record<Provider, string> = { claude: 'd_claude', anthropic: 'd_anthropic', openai: 'd_openai', codex: 'd_codex' };

/** Everything that may differ between doors: who, what model, what it cost, how long, when. */
function comparable(r: ResearchResult) {
  const { provider: _p, model: _m, costUsd: _c, durationMs: _d, requestId: _r, ...rest } = r;
  return { ...rest, citations: r.citations.map(({ retrievedAt: _t, provider: _pp, ...c }) => c) };
}

// ---------- 1: every door satisfies the invariants ----------

console.log('[1] the invariants, on every door');
const golden: Partial<Record<Provider | 'fake', ResearchResult>> = {};
for (const door of ['claude', 'openai', 'codex'] as Provider[]) {
  const r = await runResearch(door, req(DEBATE[door]), { goal: GOAL });
  golden[door] = r;
  ok(`${door}: status ok`, r.status === 'ok', `${r.status}: ${r.summary}`);
  ok(`${door}: no invariant broken`, invariantBreaks(r).length === 0, invariantBreaks(r).join('; '));
  ok(`${door}: two findings, each citing a citation that resolves`, r.findings.length === 2 && r.findings.every((f) => f.citationIds.length && f.citationIds.every((id) => r.citations.some((c) => c.id === id))), j(r.findings));
  ok(`${door}: the URL the model wrote into the summary is gone`, !/https?:\/\//.test(r.summary) && /\[c_[a-f0-9]{8}\]/.test(r.summary), r.summary);
  ok(`${door}: spoken is at most 60 words, with citation markers`, r.spoken.split(/\s+/).length <= 60 && /\[c_[a-f0-9]{8}\]/.test(r.spoken), r.spoken);
  ok(`${door}: one search counted`, r.searches === 1, String(r.searches));
  ok(`${door}: provider and model recorded`, r.provider === door && !!r.model);
}
wireResearch(fakeResearch('claude'));
golden.fake = await runResearch('claude', req('d_fake'), { goal: GOAL });
wireResearch(null);
ok('fake: no invariant broken', invariantBreaks(golden.fake).length === 0, invariantBreaks(golden.fake).join('; '));

console.log('[2] provenance, door by door');
ok('claude: search results are search_result', golden.claude!.citations.every((c) => c.provenance === 'search_result'), j(golden.claude!.citations));
ok('openai: annotations are search_result', golden.openai!.citations.every((c) => c.provenance === 'search_result'), j(golden.openai!.citations));
ok('codex: every source is model_reported, and kept', golden.codex!.citations.length === 2 && golden.codex!.citations.every((c) => c.provenance === 'model_reported'), j(golden.codex!.citations));
ok('citation ids are the short hash of the normalised URL', golden.claude!.citations.every((c) => c.id === citationId(c.url) && /^c_[a-f0-9]{8}$/.test(c.id)));
ok('the tracking parameter is gone from the citation URL', golden.openai!.citations[0].url === 'https://www.example.org/bakery-survey-2025', golden.openai!.citations[0].url);
claudeMode = 'provenance';
// The golden answer to this question is remembered for the debate; forget it so the provenance stream runs.
forgetResearch('d_claude');
const prov = await runResearch('claude', req('d_claude'), { goal: GOAL });
claudeMode = 'golden';
const survey = prov.citations.find((c) => c.url.includes('bakery-survey'));
const news = prov.citations.find((c) => c.url.includes('sunday-trading'));
ok('claude: a page WebFetch read is fetched', survey?.provenance === 'fetched', j(survey));
ok('claude: a search snippet is the quote, verbatim', survey?.quote === 'Of 400 small bakeries surveyed, 62 percent now trade on Sundays.', j(survey));
ok('claude: no quote where the tool gave no snippet', news?.provenance === 'search_result' && !news.quote, j(news));
ok('claude: a URL no tool returned carries no finding and no citation', !prov.citations.some((c) => c.url.includes('example.net')) && !prov.findings.some((f) => /blog/.test(f.claim)), j(prov));
ok('claude: the brief marks where it leaned on it', prov.summary.includes('[uncorroborated]'), prov.summary);
ok('claude: still sound', invariantBreaks(prov).length === 0, invariantBreaks(prov).join('; '));

// ---------- 3: golden equivalence ----------

console.log('[3] golden equivalence: the same sources, any door, the same result');
ok('Claude and OpenAI normalise to the same result', j(comparable(golden.claude!)) === j(comparable(golden.openai!)), `${j(comparable(golden.claude!))}\n   vs ${j(comparable(golden.openai!))}`);
ok('Claude and the fake normalise to the same result', j(comparable(golden.claude!)) === j(comparable(golden.fake!)), `${j(comparable(golden.claude!))}\n   vs ${j(comparable(golden.fake!))}`);
ok('Codex differs only where its provenance does (exempt, invariants only)',
  j({ ...comparable(golden.codex!), citations: comparable(golden.codex!).citations.map((c) => ({ ...c, provenance: 'search_result' })) }) === j(comparable(golden.claude!)));

// ---------- 4: the requests each door makes ----------

console.log('[4] what each door actually asks for');
{
  const opts = claudeSeen[0]?.options ?? {};
  ok('claude: WebSearch only (the desk reads pages itself), pre-approved under dontAsk', opts.permissionMode === 'dontAsk' && j(opts.tools) === j(['WebSearch']) && j(opts.allowedTools) === j(['WebSearch']), j({ m: opts.permissionMode, t: opts.tools, a: opts.allowedTools }));
  ok('claude: the fetch rule is a PreToolUse hook on WebFetch', opts.hooks?.PreToolUse?.[0]?.matcher === 'WebFetch' && typeof opts.hooks.PreToolUse[0].hooks[0] === 'function');
  ok('claude: the search allowance is a PreToolUse hook on the web tools', opts.hooks?.PreToolUse?.[1]?.matcher === 'WebSearch|WebFetch' && typeof opts.hooks.PreToolUse[1].hooks[0] === 'function');
  ok('claude: no extended thinking in the search loop', opts.maxThinkingTokens === 0, String(opts.maxThinkingTokens));
  ok('claude: the research seat (balanced tier)', opts.model === 'claude-sonnet-5-5', opts.model);
  ok('claude: the prompt is the question and the goal', claudeSeen[0]?.prompt.includes(F.GOLDEN_QUESTION) && claudeSeen[0].prompt.includes(GOAL));
  ok('claude: the search session asks for exactly one search', /exactly ONE WebSearch/.test(claudeSeen[0]?.options?.systemPrompt ?? '') && /Run the one search now/.test(claudeSeen[0]?.prompt ?? ''), claudeSeen[0]?.prompt);
  ok('claude: the search session ends at its result (a PostToolUse hook on WebSearch), with a short turn budget', typeof claudeSeen[0]?.options?.hooks?.PostToolUse?.[0]?.hooks?.[0] === 'function' && claudeSeen[0].options.hooks.PostToolUse[0].matcher === 'WebSearch' && claudeSeen[0].options.maxTurns === 3, String(claudeSeen[0]?.options?.maxTurns));
  const [brief, structure] = openaiBodies;
  ok('openai: step one asks for web_search and its source list', j(brief?.tools) === j([{ type: 'web_search' }]) && brief?.include?.includes('web_search_call.action.sources'), j({ t: brief?.tools, i: brief?.include }));
  ok('openai: step one caps its searches (max_tool_calls)', brief?.max_tool_calls === 2, String(brief?.max_tool_calls));
  ok('openai: step two holds no tool-call cap (it has no tools)', structure?.max_tool_calls === undefined);
  ok('openai: step one on the balanced tier, no "no web access" note', brief?.model === 'gpt-6.1-sol' && !/NO web access/.test(brief?.instructions ?? ''));
  ok('openai: step two on the fast tier, strict schema, no tools', structure?.model === 'gpt-6-luna' && structure?.text?.format?.type === 'json_schema' && structure.text.format.strict === true && !structure.tools, j(structure?.text));
  ok('openai: step two is handed only our numbered sources', /\[1\] Small bakery trading survey 2025/.test(structure?.input?.[0]?.content ?? ''));
  const cx = codexSeen[0];
  ok('codex: the research thread searches live', cx?.threadOptions?.webSearchMode === 'live' && cx.threadOptions.webSearchEnabled === true, j(cx?.threadOptions));
  ok('codex: the shell still has no network', cx?.threadOptions?.networkAccessEnabled === false);
  ok('codex: every other turn keeps web search off', codexThreadOptions('gpt-6-astra', 8_000, '/tmp/x').webSearchMode === 'disabled' && codexThreadOptions('gpt-6-astra', 8_000, '/tmp/x').webSearchEnabled === false);
  ok('codex: the research thread is told it has search and nothing else', /a web search tool and nothing else/.test(cx?.input ?? ''));
  ok('codex: a strict output schema', !!cx?.outputSchema);
  ok('codex: the prompt states the search allowance', /at most 2 searches/.test(cx?.input ?? '') && /second only if the first left/.test(cx?.input ?? ''));
}

console.log('[4b] the same question twice: answered once, every door');
for (const door of ['claude', 'openai', 'codex'] as Provider[]) {
  forgetResearch(DEBATE[door]);
  Waste.drop(DEBATE[door]);
  const before = { c: claudeSeen.length, o: openaiBodies.length, x: codexSeen.length };
  const first = await runResearch(door, req(DEBATE[door]), { goal: GOAL });
  const again = await runResearch(door, req(DEBATE[door], { question: `  ${F.GOLDEN_QUESTION.toUpperCase()}` }), { goal: GOAL });
  const calls = { c: claudeSeen.length - before.c, o: openaiBodies.length - before.o, x: codexSeen.length - before.x };
  ok(`${door}: one transport call for two identical asks`, calls[door === 'claude' ? 'c' : door === 'openai' ? 'o' : 'x'] === (door === 'openai' ? 2 : 1), j(calls));
  ok(`${door}: the repeat carries the first answer under its own request id, at no cost`,
    again.requestId !== first.requestId && again.costUsd === 0 && j(again.findings) === j(first.findings) && invariantBreaks(again).length === 0, j({ a: again.requestId, f: first.requestId, c: again.costUsd }));
}
{
  const { ResearchTokens } = await import('./meter.ts');
  const reports = ['d_claude', 'd_openai', 'd_codex'].flatMap((d) => ResearchTokens.list(d));
  ok('every door\'s research calls are metered, step by step', ['claude', 'openai', 'codex'].every((p) => reports.some((r) => r.provider === p && r.steps.length && r.totals.tokens > 0)), j(reports.map((r) => [r.provider, r.totals.tokens])));
  ok('a repeat is metered as answered from the earlier question', ['claude', 'openai', 'codex'].every((p) => reports.some((r) => r.provider === p && r.cached && r.totals.tokens === 0)));
}

// ---------- 5: abort, timeout, provider error ----------

console.log('[5] abort is honoured, a timeout is partial, an error is failed');
for (const door of ['claude', 'openai', 'codex'] as Provider[]) {
  const set = (m: Mode) => { claudeMode = m; openaiMode = m; codexMode = m; };
  set('hang');
  // Earlier sections already ran this exact question on this debate; without a
  // reset the waste guard (agents/waste.ts) would rightly refuse a third run.
  Waste.drop(DEBATE[door]);
  forgetResearch(DEBATE[door]);
  const ctl = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ctl.abort(), 60);
  const cancelled = await runResearch(door, req(DEBATE[door]), { goal: GOAL, signal: ctl.signal });
  ok(`${door}: a cancel stops it promptly, as failed`, cancelled.status === 'failed' && Date.now() - t0 < 3_000 && /cancelled/.test(cancelled.summary), `${cancelled.status} after ${Date.now() - t0}ms: ${cancelled.summary}`);
  const t1 = Date.now();
  const late = await runResearch(door, req(DEBATE[door], { budget: { maxSearches: 2, timeoutMs: 120 } }), { goal: GOAL });
  ok(`${door}: a timeout is partial, not a throw`, late.status === 'partial' && Date.now() - t1 < 3_000 && /ran out of time/.test(late.summary), `${late.status}: ${late.summary}`);
  set('error');
  const broke = await runResearch(door, req(DEBATE[door]), { goal: GOAL });
  ok(`${door}: a provider error is failed, with a sentence for the room`, broke.status === 'failed' && /could not answer/.test(broke.summary) && invariantBreaks(broke).length === 0, `${broke.status}: ${broke.summary}`);
  set('golden');
}

// ---------- 6: the fetch rule ----------

console.log('[6] the fetch rule refuses this machine and its network');
const fakeDns = (map: Record<string, string[]>) => async (h: string) => { if (!map[h]) throw new Error('ENOTFOUND'); return map[h]; };
const lookup = fakeDns({ 'public.example': ['93.184.216.34'], 'sneaky.example': ['93.184.216.34', '10.0.0.7'], 'rebind.example': ['127.0.0.1'], 'v6.example': ['::1'] });
for (const [url, expect] of [
  ['https://public.example/page', true],
  ['http://127.0.0.1:8794/api/debates', false],
  ['http://localhost/', false],
  ['http://10.1.2.3/', false],
  ['http://192.168.1.1/', false],
  ['http://172.20.0.5/', false],
  ['http://169.254.169.254/latest/meta-data/', false],
  ['http://[::1]/', false],
  ['http://[::ffff:127.0.0.1]/', false],
  ['http://[fd00::1]/', false],
  ['https://rebind.example/', false],
  ['https://sneaky.example/', false],
  ['https://v6.example/', false],
  ['https://nowhere.example/', false],
  ['file:///etc/passwd', false],
  ['https://user:pass@public.example/', false],
  ['http://printer.local/', false],
] as [string, boolean][]) {
  const v = await checkFetchUrl(url, lookup);
  ok(`${expect ? 'allows' : 'refuses'} ${url}`, v.ok === expect, j(v));
}
ok('a public v6 address is public', nonPublic('2606:2800:220:1:248:1893:25c8:1946') === null);
const denied = await webFetchHook({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'http://127.0.0.1:8794/api/debates' } });
ok('the hook denies a loopback fetch', (denied as any).hookSpecificOutput?.permissionDecision === 'deny', j(denied));
const other = await webFetchHook({ hook_event_name: 'PreToolUse', tool_name: 'WebSearch', tool_input: { query: 'x' } });
ok('the hook leaves other tools alone', j(other) === '{}');

// ---------- 7: normalisation details ----------

console.log('[7] normalisation');
ok('scheme, www and tracking parameters do not make a different page',
  normaliseUrl('http://www.example.org/a/?utm_source=x#frag') === normaliseUrl('https://example.org/a'), `${normaliseUrl('http://www.example.org/a/?utm_source=x#frag')}`);
ok('cleaning keeps the scheme the source used', cleanUrl('http://example.org/a?utm_medium=y') === 'http://example.org/a');
ok('the ledger saw the research spend', (Usage.get('d_claude').turns ?? 0) > 0 && (Usage.get('d_openai').webSearches ?? 0) >= 1 && (Usage.get('d_codex').webSearches ?? 0) >= 1,
  j({ c: Usage.get('d_claude'), o: Usage.get('d_openai'), x: Usage.get('d_codex') }));

console.log(`\n${passes} passed, ${fails} failed`);
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
