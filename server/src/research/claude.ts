/**
 * Research on the Claude door (docs/PHASE2-PLAN.md 3.2), on the balanced tier
 * (Sonnet 5.5) throughout. Each step gets a context built for it:
 *
 *   1. search   the CLI with WebSearch only, no extended thinking, the
 *               question and the goal as its whole prompt. ONE search: the
 *               search gate (meter.ts searchGate) refuses any other, and a
 *               PostToolUse hook ends the session the moment the result comes
 *               back (sdk.ts afterWebResult), so the model never reads it.
 *   2. read     the desk takes the result's links, snippets and notes itself,
 *               and fetches up to RESEARCH_LIMITS.pages of the most relevant
 *               pages (pages.ts: fetch rule on every hop, extraction, at most
 *               pageChars each).
 *   3. write    a fresh tool-free session gets the question, the numbered
 *               results and the fenced extracts, and writes findings each of
 *               which its source states. Writing from the extracts is the
 *               check, so there is no separate verify pass; a code check then
 *               marks any figure the cited source does not contain as low
 *               confidence.
 *   4. gap      only when the write-up names a gap, and only while the call
 *               can afford it: one more search on exactly that query, its
 *               pages read, and the write-up done again over everything.
 *
 * Why the session ends at the result: on 28 Oct 2026 every research call let
 * the model run four searches and read their results in the loop. The
 * request after the results carried ~145,000 tokens (~36,000 per search),
 * written to the cache at ~$1.30 a call, for an answer the verify step then
 * rewrote from 10,000 characters of page extracts anyway. Ending the session
 * at the result costs one ~3,000-token request instead.
 *
 * Why not the CLI's WebFetch: it reads up to 100,000 characters per call and
 * can put a page into the loop's context whole (R1, docs/COSTFIX-REPORT.md).
 *
 * Every step is metered (meter.ts) and the call is held to its envelope,
 * which counts what research adds over each session's fixed baseline (the
 * CLI's prefix, calibrated on the session's first request): once its search
 * has run, a search session whose request grows past contextTripwire, or
 * whose call passes the tripwire, is stopped where it stands and the desk
 * writes up what it has. A session is never stopped before its search. A call
 * left with no result says "Research incomplete" and why, never an empty "no
 * sources".
 *
 * Provenance comes from the tool RESULTS and the desk's own reads, never from
 * the model's text: every numbered source is a URL a WebSearch returned
 * (`search_result`), `fetched` when the desk read the page. A URL the model
 * wrote that no search returned is `model_reported` and, on this door, carries
 * no finding. A `quote` is a search result's own snippet, or failing that a
 * verbatim sentence from the page the desk read.
 */
import { GatedLoopExhausted, asUsageLimit, runAgent, runJsonAgent, extractJson, type ToolResult } from '../agents/sdk.ts';
import { researchSearchPrompt, researchSearchSystem, researchWritePrompt, researchWriteSystem } from '../agents/prompts.ts';
import { modelFor } from '../../../shared/models.ts';
import { finalise, normaliseUrl, parseModelResearch } from './normalise.ts';
import { RESEARCH_LIMITS, ResearchMeter, ownTokens, searchGate, tokensOf, type Tokens } from './meter.ts';
import { bestQuote, pagesOffline, readPage, relevantExcerpt, terms, type Page } from './pages.ts';
import { gateQuestion } from './gate.ts';
import type { Draft, ResearchCtx, ResearchProvider, ResearchRequest } from './types.ts';

interface Attested {
  title?: string;
  quote?: string;
  publishedAt?: string;
  fetched: boolean;
}

/** Every JSON array after a "Links:" in a WebSearch result, read with bracket matching. */
function linksArrays(content: string): any[] {
  const out: any[] = [];
  let from = 0;
  for (;;) {
    const at = content.indexOf('Links:', from);
    if (at < 0) return out;
    from = at + 6;
    const start = content.indexOf('[', at);
    if (start < 0) return out;
    let depth = 0;
    let inStr = false;
    for (let i = start; i < content.length; i++) {
      const ch = content[i];
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']' && --depth === 0) {
        try {
          const v = JSON.parse(content.slice(start, i + 1));
          if (Array.isArray(v)) out.push(...v);
        } catch { /* not a link list */ }
        from = i + 1;
        break;
      }
    }
  }
}

/**
 * What the tools attest, by normalised URL, in the order the results gave
 * them. Assumes Claude Code's WebSearch result format ("Links: [{title, url,
 * ...}]"); sdk.ts searchResponseText writes the same shape from the hook.
 */
export function attestFromTools(results: ToolResult[]): Map<string, Attested & { url: string }> {
  const out = new Map<string, Attested & { url: string }>();
  for (const r of results) {
    if (!r.ok) continue;
    if (r.name === 'WebSearch') {
      for (const l of linksArrays(r.content)) {
        const url = String(l?.url ?? '');
        const key = normaliseUrl(url);
        if (!key) continue;
        const snippet = String(l?.snippet ?? l?.description ?? '').trim();
        const prev = out.get(key);
        out.set(key, {
          url: prev?.url ?? url,
          fetched: prev?.fetched ?? false,
          title: prev?.title ?? (String(l?.title ?? '').trim() || undefined),
          quote: prev?.quote ?? (snippet ? snippet.slice(0, 300) : undefined),
          publishedAt: prev?.publishedAt ?? (String(l?.page_age ?? '').trim() || undefined),
        });
      }
    } else if (r.name === 'WebFetch') {
      const key = normaliseUrl(r.input);
      if (!key || !r.content.trim()) continue;
      const prev = out.get(key);
      out.set(key, { ...(prev ?? {}), url: prev?.url ?? r.input, fetched: true });
    }
  }
  return out;
}

/** The search tool's own notes: every result's text after its link list, bounded. */
function searchNotes(results: ToolResult[]): string {
  const notes = results
    .filter((r) => r.ok && r.name === 'WebSearch')
    .map((r) => r.content.replace(/^Web search results for query:[^\n]*\n*/, '').replace(/Links:\s*\[[\s\S]*?\}\]\s*/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
  return notes.slice(0, RESEARCH_LIMITS.notesChars);
}

const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** The source list the write-up sees, numbered 1..n in the order the searches returned them. */
export interface Hit { n: number; url: string; title: string; snippet?: string; publishedAt?: string; fetched: boolean; page?: Page; excerpt?: string | null }

function hitsFrom(attested: Map<string, Attested & { url: string }>, prior: Hit[]): Hit[] {
  const out = [...prior];
  const have = new Set(prior.map((h) => normaliseUrl(h.url)));
  for (const [key, a] of attested) {
    if (have.has(key)) continue;
    if (out.length - prior.length >= RESEARCH_LIMITS.hits) break;
    have.add(key);
    out.push({ n: out.length + 1, url: a.url, title: a.title ?? '', ...(a.quote ? { snippet: a.quote } : {}), ...(a.publishedAt ? { publishedAt: a.publishedAt } : {}), fetched: a.fetched });
  }
  return out;
}

/** How well a result's title and snippet match what is being looked for. */
function relevance(h: Hit, want: Set<string>): number {
  let s = 0;
  for (const w of terms(`${h.title} ${h.snippet ?? ''}`)) if (want.has(w)) s++;
  return s;
}

/**
 * Read the most relevant unread results, in parallel. Only URLs a search
 * returned are ever fetched, so a prompt-injected model cannot point the desk
 * at an address of its choosing.
 */
async function readBest(hits: Hit[], focus: string, figures: string[], meter: ResearchMeter, signal: AbortSignal, prefer?: Set<number>): Promise<void> {
  if (pagesOffline()) return;
  const want = new Set(terms(focus));
  const fresh = hits.filter((h) => h.page === undefined);
  // The search engine's own order is evidence too: the top results get up to 1.5 words' worth of credit.
  const pick = fresh
    .map((h, i) => ({ h, s: relevance(h, want) + 1.5 * (1 - i / fresh.length) + (prefer?.has(h.n) ? 100 : 0) }))
    .sort((a, b) => b.s - a.s || a.h.n - b.h.n)
    .slice(0, RESEARCH_LIMITS.pages);
  await Promise.all(pick.map(async ({ h }) => {
    const page = await readPage(h.url, signal);
    if (!page) return;
    h.page = page;
    h.excerpt = relevantExcerpt(page.text, focus, figures);
    meter.pages++;
    meter.pageChars += h.excerpt.length;
  }));
}

/** The digits of a figure, for finding it in a page whatever the formatting ("1,250" in "1250"). */
const digits = (s: string) => s.replace(/[^0-9.]/g, '').replace(/^\.+|\.+$/g, '');

/**
 * The lean check, in code: a figure must appear in the text of a source it
 * cites (snippet, or the page the desk read). One that does not is kept, at
 * low confidence, and counted in the log line. A finding whose sources the
 * desk holds no text for is left alone: there is nothing to check it against.
 */
function checkFigures(findings: Draft['findings'], hits: Hit[], meter: ResearchMeter): Draft['findings'] {
  return findings.map((f) => {
    const want = f.figure?.value ? digits(f.figure.value) : '';
    if (!want) return f;
    const texts = f.sources.map((n) => hits.find((h) => h.n === n)).filter(Boolean).map((h) => `${h!.snippet ?? ''} ${h!.page?.text ?? ''}`).filter((t) => t.trim());
    if (!texts.length) return f;
    if (texts.some((t) => digits(t.replace(/\s+/g, '')).includes(want) || t.replace(/,/g, '').includes(want))) return f;
    meter.unconfirmed++;
    return { ...f, confidence: 'low' as const };
  });
}

export const ClaudeResearch: ResearchProvider = {
  id: 'claude',
  available: () => true,
  async run(req, ctx) {
    const meter = new ResearchMeter(req, 'claude');
    try {
      return await runClaude(req, ctx, meter);
    } catch (err) {
      // A call that dies still spent what its requests spent; it is logged too.
      meter.step('failed', modelFor('claude', 'research'), undefined);
      meter.finish();
      throw err;
    }
  },
};

interface Round { results: ToolResult[]; text: string; costUsd: number }

/**
 * One search session: one WebSearch, ended as its result returns. Held to the
 * envelope while it runs: a request that starts past contextTripwire, or
 * tokens past the tripwire, stop it on the spot, and what the search returned
 * is still used.
 */
async function searchRound(req: ResearchRequest, ctx: ResearchCtx, meter: ResearchMeter, seen: Set<string>, query?: string): Promise<Round> {
  const model = modelFor('claude', 'research');
  const results: ToolResult[] = [];
  const local = new AbortController();
  let stoppedBy: string | null = null;
  const stop = (why: string) => {
    if (stoppedBy) return;
    stoppedBy = why;
    meter.stop(why);
    local.abort();
  };
  const allowance = meter.searches + 1;
  let text = '';
  let costUsd = 0;
  let usage: Partial<Tokens> | undefined;
  const system = researchSearchSystem();
  const prompt = researchSearchPrompt(req.question, ctx.goal, { recencyDays: req.recencyDays, ...(query ? { query } : {}) });
  // The session's first request sets its baseline; the envelope counts only what grows past it.
  meter.beginStep(ownTokens(system, prompt));
  /** The session's search has been let through (or has returned): only then may the envelope stop it. */
  const searched = () => meter.searches >= allowance || results.length > 0;
  try {
    const turn = await runAgent({
      model,
      system,
      prompt,
      web: true,
      webTools: ['WebSearch'],
      toolGate: searchGate(meter, allowance, { seen, writeUp: 'The search has run; stop here.' }),
      afterWebResult: (_tool, q, content) => {
        results.push({ name: 'WebSearch', input: q, ok: true, content });
        return true;
      },
      onRequestStart: (u) => {
        // Billed from here; counted once, and replaced by its final usage if it finishes.
        const { growth, first } = meter.requestStart(u);
        // A first request carries no research, whatever its size: it never stops a session (1 Nov 2026: 4 of 10 calls stopped there).
        if (!first && searched() && growth >= RESEARCH_LIMITS.contextTripwire) {
          stop(`a search request started at ${tokensOf(u).toLocaleString('en-US')} tokens, ${growth.toLocaleString('en-US')} over the session's first request`);
        }
      },
      onRequestUsage: (u) => {
        meter.requestEnd(u);
        if (searched() && meter.added >= RESEARCH_LIMITS.tripwire) stop(`the call's research passed ${RESEARCH_LIMITS.tripwire.toLocaleString('en-US')} tokens`);
      },
      /**
       * No extended thinking: choosing a query does not need it, and the CLI's
       * WebSearch runs as a nested request that inherits this budget.
       */
      thinking: 0,
      timeoutMs: req.budget.timeoutMs + 60_000,
      // The search, a refused extra call, and a stray answer.
      maxTurns: 3,
      debateId: req.debateId,
      label: 'research',
      job: 'research',
      signal: AbortSignal.any([ctx.signal, local.signal]),
    });
    text = turn.text;
    costUsd = turn.costUsd ?? 0;
    usage = turn.usage;
    for (const r of turn.toolResults ?? []) if (!results.some((x) => x.input === r.input && x.name === r.name)) results.push(r);
  } catch (err) {
    if (err instanceof GatedLoopExhausted) {
      // The usual end: the hook stopped the session at the result.
      costUsd = err.partial.costUsd ?? 0;
      usage = err.partial.usage;
      for (const r of err.partial.toolResults ?? []) if (!results.some((x) => x.input === r.input && x.name === r.name)) results.push(r);
    } else if (ctx.signal.aborted || asUsageLimit(err) || !(stoppedBy || results.length)) {
      throw err;
    } else {
      // Stopped by the envelope, or the CLI failed after the search returned: what the search found stands.
      if (!stoppedBy) meter.stop(`the search session failed after its result: ${String((err as any)?.message ?? err).split('\n')[0].slice(0, 120)}`);
    }
  }
  meter.step('search', model, usage, costUsd);
  // The gate counts the searches it lets through; a transport without hooks (a recorded stream) is counted by its results.
  meter.searches = Math.max(meter.searches, allowance - 1 + results.filter((r) => r.name === 'WebSearch' && r.ok).length);
  return { results, text, costUsd };
}

/**
 * The write-up's prompt, held to RESEARCH_LIMITS.writeChars whatever the
 * search and the pages returned: extracts are shortened first, then the
 * draft a search session wrote anyway is left out, then the notes, then the
 * last-ranked sources. A raw search result (~145,000 characters) can never
 * ride in here.
 */
export function writeInput(question: string, goal: string, hits: Hit[], notes: string, draft: { summary: string; findings: unknown[] } | null, cap: number = RESEARCH_LIMITS.writeChars) {
  let pageCap: number = RESEARCH_LIMITS.pageChars;
  let keepDraft = !!draft;
  let keepNotes = notes;
  let count = hits.length;
  const g = goal.slice(0, 1_500);
  for (;;) {
    const prompt = researchWritePrompt(question, g, hits.slice(0, count).map((h) => ({
      n: h.n, title: (h.title || h.page?.title || '').slice(0, 200), host: host(h.url), ...(h.publishedAt ? { date: h.publishedAt.slice(0, 40) } : {}),
      ...(h.snippet ? { snippet: h.snippet.slice(0, 300) } : {}), excerpt: h.excerpt ? h.excerpt.slice(0, pageCap) : null,
    })), keepNotes.slice(0, RESEARCH_LIMITS.notesChars), keepDraft ? draft : null);
    const trimmed = pageCap < RESEARCH_LIMITS.pageChars || (!!draft && !keepDraft) || keepNotes !== notes || count < hits.length;
    if (prompt.length <= cap) return { prompt, trimmed };
    if (pageCap > 1_000) pageCap -= 500;
    else if (keepDraft) keepDraft = false;
    else if (keepNotes) keepNotes = '';
    else if (count > 1) count--;
    else return { prompt: prompt.slice(0, cap), trimmed: true };
  }
}

/** The write-up: a fresh tool-free session over the numbered sources and their extracts. */
async function writeUp(req: ResearchRequest, ctx: ResearchCtx, meter: ResearchMeter, hits: Hit[], notes: string, allowGap: boolean, draft: { summary: string; findings: unknown[] } | null) {
  const model = modelFor('claude', 'research');
  const system = researchWriteSystem(allowGap);
  const { prompt, trimmed } = writeInput(req.question, ctx.goal, hits, notes, draft);
  if (trimmed) console.warn(`[research:tokens] ${req.id} write: sources trimmed to fit ${RESEARCH_LIMITS.writeChars.toLocaleString('en-US')} characters`);
  // Everything the write-up reads is the desk's own text; the CLI's prefix around it is the baseline.
  meter.beginStep(ownTokens(system, prompt));
  const out = await runJsonAgent<any>({
    model,
    system,
    prompt,
    thinking: 2_000,
    timeoutMs: 180_000,
    debateId: req.debateId,
    label: 'research:write',
    job: 'research',
    signal: ctx.signal,
    onRequestUsage: (u) => meter.request(u),
  });
  meter.step('write', model, out.usage, out.costUsd ?? 0);
  return { value: out.value, costUsd: out.costUsd ?? 0 };
}

async function runClaude(req: ResearchRequest, ctx: ResearchCtx, meter: ResearchMeter) {
  const startedAt = Date.now();
  const model = modelFor('claude', 'research');
  const maxSearches = Math.max(1, Math.min(req.budget.maxSearches, RESEARCH_LIMITS.searches));
  const seen = new Set<string>();
  ctx.onProgress?.('searching');
  const first = await searchRound(req, ctx, meter, seen);
  const results = [...first.results];
  let cost = first.costUsd;

  /**
   * A session that answered anyway (the stop did not take, or a recorded
   * stream): its draft is used, checked against the pages when any can be
   * read, and costs no second write-up when none can.
   */
  let loopDraft: any = null;
  if (first.text.trim()) {
    try { loopDraft = extractJson(first.text); } catch { loopDraft = null; }
  }
  const attested = attestFromTools(results);
  let hits = hitsFrom(attested, []);
  const loopParsed = loopDraft ? parseModelResearch(loopDraft) : null;
  // A draft's sources by our numbering: URLs no search returned are dropped here, as finalise would.
  const renumber = new Map<number, number>();
  if (loopParsed) {
    for (const s of loopParsed.sources) {
      const h = hits.find((x) => normaliseUrl(x.url) === normaliseUrl(s.url));
      if (h) renumber.set(s.n, h.n);
    }
  }

  ctx.onProgress?.('reading');
  const cited = new Set([...renumber.values()].filter((n) => loopParsed?.findings.some((f) => f.sources.some((s) => renumber.get(s) === n))));
  const figures = (loopParsed?.findings ?? []).map((f) => f.figure?.value ?? '').filter(Boolean);
  await readBest(hits, req.question, figures, meter, ctx.signal, cited.size ? cited : undefined);
  const anyPage = hits.some((h) => h.page);

  let parsed: ReturnType<typeof parseModelResearch>;
  let sourcesFromHits = true;
  if (!hits.length) {
    /**
     * Nothing to write from; a write-up would only say so at a price. Say
     * which: an empty search, or one that never ran (a session that answered
     * without searching wrote from memory, and that is not research).
     */
    const ran = results.some((r) => r.name === 'WebSearch' && r.ok);
    parsed = {
      summary: ran
        ? 'The search returned no sources for this question.'
        : `Research incomplete: no search result came back (${meter.stopped[0] ?? 'the search did not run'}). Nothing was found, so this question is still open.`,
      spoken: '',
      findings: [],
      sources: [],
    };
  } else if (loopParsed && !anyPage) {
    // Nothing to check the draft against: it stands as the search wrote it, as before the write-up existed.
    parsed = loopParsed;
    sourcesFromHits = false;
  } else {
    ctx.onProgress?.('checking');
    const notes = searchNotes(results);
    const draftForWrite = loopParsed
      ? { summary: loopParsed.summary, findings: loopParsed.findings.map((f) => ({ ...f, sources: f.sources.map((n) => renumber.get(n)).filter(Boolean) })) }
      : null;
    const canGap = () => meter.searches < maxSearches && !meter.stopped.length && meter.added + RESEARCH_LIMITS.gapReserve <= meter.budget;
    let w = await writeUp(req, ctx, meter, hits, notes, canGap(), draftForWrite);
    cost += w.costUsd;
    const gap = typeof w.value?.gap === 'string' ? w.value.gap.trim() : '';
    if (gap && canGap()) {
      const g = gateQuestion(gap);
      if (g.ok) {
        ctx.onProgress?.('searching');
        const second = await searchRound(req, ctx, meter, seen, g.question);
        cost += second.costUsd;
        results.push(...second.results);
        const before = hits.length;
        hits = hitsFrom(attestFromTools(results), hits);
        if (hits.length > before) {
          ctx.onProgress?.('reading');
          await readBest(hits.slice(before), g.question, [], meter, ctx.signal);
          ctx.onProgress?.('checking');
          const firstAnswer = parseModelResearch(w.value);
          w = await writeUp(req, ctx, meter, hits, searchNotes(results), false, { summary: firstAnswer.summary, findings: firstAnswer.findings });
          cost += w.costUsd;
        }
      } else {
        meter.stop(`the gap query was not sent (${g.reason})`);
      }
    } else if (gap) {
      meter.stop('a gap was named but the call could not afford a second search');
    }
    parsed = parseModelResearch({ ...w.value, sources: [] });
  }

  const findings = sourcesFromHits ? checkFigures(parsed.findings, hits, meter) : parsed.findings;
  const sources: Draft['sources'] = sourcesFromHits
    ? hits.map((h) => {
        const focus = parsed.findings.filter((f) => f.sources.includes(h.n)).map((f) => f.claim).join(' ');
        const quote = h.snippet ?? (h.page ? bestQuote(h.page.text, focus || req.question, parsed.findings.find((f) => f.sources.includes(h.n))?.figure?.value) : undefined);
        return {
          n: h.n, url: h.url, title: h.title || h.page?.title || '',
          ...(quote ? { quote } : {}),
          ...(h.publishedAt ? { publishedAt: h.publishedAt } : {}),
          provenance: h.fetched || h.page ? 'fetched' as const : 'search_result' as const,
        };
      })
    : parsed.sources.map((s) => {
        const a = attested.get(normaliseUrl(s.url) ?? '');
        return {
          ...s,
          title: s.title || a?.title || '',
          ...(a?.quote ? { quote: a.quote } : {}),
          ...(!s.publishedAt && a?.publishedAt ? { publishedAt: a.publishedAt } : {}),
          provenance: a ? (a.fetched ? 'fetched' as const : 'search_result' as const) : 'model_reported' as const,
        };
      });

  const draft: Draft = {
    summary: parsed.summary,
    spoken: parsed.spoken,
    findings,
    sources,
    // A refused search returns an error result; it was never run.
    searches: results.filter((r) => r.name === 'WebSearch' && r.ok).length,
    costUsd: cost,
    model,
    provider: 'claude',
  };
  meter.searches = Math.max(meter.searches, draft.searches);
  meter.finish();
  return finalise(req, draft, { startedAt });
}
