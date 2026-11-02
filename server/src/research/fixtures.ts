/**
 * Research fixtures, hand-written (docs/PHASE2-PLAN.md 3.4). Fictional facts
 * on example domains: nothing here is a claim about the real world.
 *
 * GOLDEN is one set of sources and findings. The transports below express it
 * the way each provider would deliver it: a Claude Agent SDK message stream,
 * OpenAI Responses SSE streams, a Codex thread event stream, and the fake
 * provider's own draft. Golden equivalence demands that the Claude, OpenAI
 * and fake ones all normalise to the same ResearchResult. The owner-approved
 * probe (R2) records one real transport per door; those join the suite.
 */
import type { Draft } from './types.ts';

export const GOLDEN_QUESTION = 'What share of small bakeries open on Sundays, and when did Sunday trading rules last change?';

export const GOLDEN_SOURCES = [
  // As a search tool returns it, tracking parameter and all; normalisation strips it.
  { n: 1, url: 'https://www.example.org/bakery-survey-2025?utm_source=search', title: 'Small bakery trading survey 2025' },
  { n: 2, url: 'https://example.com/news/sunday-trading', title: 'Sunday trading hours: what changed' },
];

/** What the model writes, sources by number: identical on every door that writes JSON. */
export const GOLDEN_MODEL_JSON = {
  summary: 'Most small bakeries in the trade survey open on Sundays, 62 percent of respondents [1]. Sunday trading rules for small shops last changed in 2024, when the hours cap was lifted [2]. See https://example.com/news/sunday-trading for details.',
  spoken: 'Sixty-two percent of small bakeries in the trade survey open on Sundays [1], and the Sunday hours cap went in 2024 [2].',
  findings: [
    { claim: '62 percent of small bakeries surveyed open on Sundays', figure: { value: '62', unit: '%', as_of: '2025' }, sources: [1], confidence: 'high' },
    { claim: 'Sunday trading rules for small shops last changed in 2024, when the hours cap was lifted', figure: null, sources: [2], confidence: 'medium' },
  ],
};

/** The Claude door's JSON also lists the sources it used. */
export const GOLDEN_CLAUDE_JSON = {
  ...GOLDEN_MODEL_JSON,
  sources: GOLDEN_SOURCES.map((s) => ({ n: s.n, url: s.url.replace(/\?utm_source=search$/, ''), title: s.title, publisher: '', published: '' })),
};

const webSearchResult = (query: string, links: { title: string; url: string; snippet?: string }[]) =>
  `Web search results for query: "${query}"\n\nLinks: ${JSON.stringify(links)}\n\nThe search found a trade survey and a news report.`;

/**
 * Claude: an Agent SDK message stream. One WebSearch (tool_use, then the
 * tool_result in a user message), then the JSON answer and a result message.
 */
export function claudeGoldenStream(): any[] {
  const json = JSON.stringify(GOLDEN_CLAUDE_JSON);
  return [
    { type: 'system', subtype: 'init', session_id: 'sess_golden' },
    { type: 'assistant', session_id: 'sess_golden', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'WebSearch', input: { query: 'small bakeries open sundays survey' } }] } },
    { type: 'user', session_id: 'sess_golden', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: webSearchResult('small bakeries open sundays survey', GOLDEN_SOURCES.map(({ title, url }) => ({ title, url }))) }] } },
    { type: 'assistant', session_id: 'sess_golden', message: { content: [{ type: 'text', text: json }] } },
    { type: 'result', subtype: 'success', session_id: 'sess_golden', result: json, total_cost_usd: 0.041, usage: { input_tokens: 3000, output_tokens: 600, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 1 } } },
  ];
}

/**
 * Claude, the provenance cases: a WebFetch of source 1 (fetched), a search
 * snippet (the only allowed quote), and a third URL that no tool returned
 * (model_reported: no finding on this door, "[uncorroborated]" in the brief).
 */
export function claudeProvenanceStream(): any[] {
  const json = JSON.stringify({
    ...GOLDEN_CLAUDE_JSON,
    summary: `${GOLDEN_CLAUDE_JSON.summary} A trade blog puts it higher [3].`,
    findings: [...GOLDEN_MODEL_JSON.findings, { claim: 'A blog says 70 percent', figure: null, sources: [3], confidence: 'low' }],
    sources: [...GOLDEN_CLAUDE_JSON.sources, { n: 3, url: 'https://example.net/blog/sundays', title: 'A bakery blog', publisher: '', published: '' }],
  });
  return [
    { type: 'system', subtype: 'init', session_id: 'sess_prov' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_s', name: 'WebSearch', input: { query: 'bakeries sunday' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_s', content: [{ type: 'text', text: webSearchResult('bakeries sunday', [
      { title: GOLDEN_SOURCES[0].title, url: GOLDEN_SOURCES[0].url, snippet: 'Of 400 small bakeries surveyed, 62 percent now trade on Sundays.' },
      { title: GOLDEN_SOURCES[1].title, url: GOLDEN_SOURCES[1].url },
    ]) }] }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_f', name: 'WebFetch', input: { url: 'https://www.example.org/bakery-survey-2025', prompt: 'share open on Sundays' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_f', content: 'The survey reports that 62 percent open on Sundays.' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: json }] } },
    { type: 'result', subtype: 'success', result: json, total_cost_usd: 0.05, usage: { input_tokens: 4000, output_tokens: 700 } },
  ];
}

/** Server-sent events, the way the Responses API streams them. */
export function sse(events: any[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
      c.close();
    },
  });
}

/**
 * OpenAI step one: the brief, with url_citation annotations over the spans the
 * model rendered as links, plus the web_search_call and its source list.
 */
export function openaiBriefEvents(): any[] {
  const s1 = 'Most small bakeries in the trade survey open on Sundays, 62 percent of respondents ';
  const l1 = '([example.org](https://www.example.org/bakery-survey-2025?utm_source=openai))';
  const s2 = '. Sunday trading rules for small shops last changed in 2024, when the hours cap was lifted ';
  const l2 = '([example.com](https://example.com/news/sunday-trading))';
  const text = `${s1}${l1}${s2}${l2}.`;
  const a1 = { type: 'url_citation', url: GOLDEN_SOURCES[0].url, title: GOLDEN_SOURCES[0].title, start_index: s1.length, end_index: s1.length + l1.length };
  const a2Start = s1.length + l1.length + s2.length;
  const a2 = { type: 'url_citation', url: GOLDEN_SOURCES[1].url, title: GOLDEN_SOURCES[1].title, start_index: a2Start, end_index: a2Start + l2.length };
  const response = {
    id: 'resp_brief',
    status: 'completed',
    output: [
      { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'small bakeries sunday opening survey', sources: GOLDEN_SOURCES.map((s) => ({ type: 'url', url: s.url })) } },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [a1, a2] }] },
    ],
    usage: { input_tokens: 2500, output_tokens: 400, input_tokens_details: { cached_tokens: 0 } },
  };
  return [
    { type: 'response.created', response: { id: 'resp_brief' } },
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.completed', response },
  ];
}

/** OpenAI step two: the tool-free structuring call's strict JSON. */
export function openaiStructureEvents(json: unknown = GOLDEN_MODEL_JSON): any[] {
  const text = JSON.stringify(json);
  return [
    { type: 'response.created', response: { id: 'resp_struct' } },
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.completed', response: { id: 'resp_struct', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 900, output_tokens: 300 } } },
  ];
}

/** Codex: a research thread's events. The web_search item carries only the query. */
export function codexEvents(json: unknown = GOLDEN_CLAUDE_JSON): any[] {
  return [
    { type: 'thread.started', thread_id: 'th_research' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'i1', type: 'web_search', query: 'small bakeries sunday opening survey' } },
    { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: JSON.stringify(json) } },
    { type: 'turn.completed', usage: { input_tokens: 5000, cached_input_tokens: 1000, output_tokens: 500 } },
  ];
}

/** The fake provider's draft for the golden question: the same sources, already attested. */
export function fakeGoldenDraft(): Omit<Draft, 'provider' | 'model' | 'costUsd'> {
  return {
    summary: GOLDEN_MODEL_JSON.summary,
    spoken: GOLDEN_MODEL_JSON.spoken,
    findings: GOLDEN_MODEL_JSON.findings.map((f) => ({
      claim: f.claim,
      ...(f.figure ? { figure: { value: f.figure.value, unit: f.figure.unit, asOf: f.figure.as_of } } : {}),
      sources: f.sources,
      confidence: f.confidence as 'high' | 'medium',
    })),
    sources: GOLDEN_SOURCES.map((s) => ({ ...s, provenance: 'search_result' as const })),
    searches: 1,
  };
}
