/**
 * Research.run (docs/PHASE2-PLAN.md 3.3): picks the adapter from the debate's
 * door and turns every way a request can end into a ResearchResult. Callers
 * never see a throw from here: a timeout is `partial`, a provider error is
 * `failed` with a sentence the room can be told, a cancel is `failed` too.
 *
 * The door is passed in (the runner's DebateRun.provider), not re-derived:
 * sdk.debateProvider() folds OpenAI and Codex into one capability family,
 * and research needs to know which of the two it is on.
 *
 * Before any search, the desk checks what the debate already knows (recall):
 * the architect's landscape and every brief that landed. On 28 Oct 2026 two
 * of six questions were narrower versions of a pre-session brief (an
 * Australian Sunday penalty rate inside "Sunday premium pay in four
 * countries"; a UK opt-out inside "Sunday working opt-outs") and each was
 * searched from scratch for ~$1.40.
 */
import type { Citation, ResearchResult } from '../../../shared/research.ts';
import { modelFor, type Provider } from '../../../shared/models.ts';
import { runJsonAgent } from '../agents/sdk.ts';
import { researchRecallPrompt, researchRecallSystem } from '../agents/prompts.ts';
import { ClaudeResearch } from './claude.ts';
import { OpenAIResearch } from './openai.ts';
import { CodexResearch } from './codex.ts';
import { clampWords, emptyResult, finalise, invariantBreaks, parseModelResearch, SUMMARY_WORDS } from './normalise.ts';
import { ResearchMeter, ResearchTokens, ownTokens } from './meter.ts';
import { gateQuestion } from './gate.ts';
import { terms } from './pages.ts';
import type { KnownBrief, ResearchProvider, ResearchRequest } from './types.ts';

/** The Claude API key door runs the same Claude CLI, so the same adapter. */
const ADAPTERS: Record<Provider, ResearchProvider> = { claude: ClaudeResearch, anthropic: ClaudeResearch, openai: OpenAIResearch, codex: CodexResearch };

let override: ResearchProvider | null = null;

/** MOCK=1 and tests route every door to one provider (the fake). Never set in the app's real path. */
export function wireResearch(p: ResearchProvider | null) {
  override = p;
}

export function adapterFor(door: Provider): ResearchProvider {
  return override ?? ADAPTERS[door];
}

/**
 * Identical questions, answered once per debate. Experts re-ask the same
 * thing across rounds (a RESEARCH: trailer repeated turn after turn); the
 * second asker gets the first answer, re-stamped with its own request id, at
 * no cost, instead of a second web search or a waste-guard refusal. A request
 * already in flight is shared the same way. Only a sound `ok` answer is kept.
 */
const ANSWER_TTL_MS = 6 * 3600_000;
const answered = new Map<string, { at: number; result: ResearchResult }>();
const inflightAsks = new Map<string, Promise<ResearchResult>>();

export function questionKey(door: Provider, req: ResearchRequest): string {
  const q = req.question.toLowerCase().replace(/[^\p{L}\p{N}%]+/gu, ' ').trim();
  return `${req.debateId}|${door}|${req.recencyDays ?? ''}|${req.maxSources}|${q}`;
}

/** Forget a debate's answered questions (deleted, or a test reset). */
export function forgetResearch(debateId: string) {
  for (const k of [...answered.keys()]) if (k.startsWith(`${debateId}|`)) answered.delete(k);
  ResearchTokens.drop(debateId);
}

const restamp = (r: ResearchResult, req: ResearchRequest): ResearchResult => ({ ...r, requestId: req.id, costUsd: 0, durationMs: 0, searches: 0 });

// ---- recall: reuse across the whole debate, not just identical strings ----

/** Words every research question uses, which say nothing about what it asks. */
const GENERIC = new Set('current currently typical typically show data compare compared versus must keep rely can e.g latest recent figure figures number numbers rate rates'.split(' '));

/** Content words cut to five letters, so "Australian" meets "Australia" and "penalties" meets "penalty". */
function stems(text: string): Set<string> {
  return new Set(terms(text)
    .filter((w) => !/^\d{1,3}$/.test(w) && !GENERIC.has(w))
    .map((w) => (w.length >= 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .map((w) => (w.length > 5 ? w.slice(0, 5) : w)));
}

/**
 * The briefs a new question may already be answered by, best first. Cheap
 * and deliberately generous: a candidate costs one small tool-free call that
 * decides, while a missed one costs a whole search.
 *   - the earlier question shares at least three words with the new one and
 *     covers at least 30% of it (four words and 25%), or
 *   - the earlier question and its summary together cover half of it.
 */
export function relatedBriefs(question: string, known: KnownBrief[], max = 3): KnownBrief[] {
  const q = stems(question);
  if (q.size < 3) return [];
  return known
    .filter((k) => k.status === 'ok' && k.citations.length && k.summary.trim())
    .map((k) => {
      const kq = stems(k.question);
      const all = new Set([...kq, ...stems(k.summary)]);
      let sq = 0;
      let sa = 0;
      for (const w of q) { if (kq.has(w)) sq++; if (all.has(w)) sa++; }
      const ok = (sq >= 3 && sq / q.size >= 0.3) || (sq >= 4 && sq / q.size >= 0.25) || sa / q.size >= 0.5;
      return { k, ok, score: sq / q.size + 0.5 * (sa / q.size) };
    })
    .filter((x) => x.ok)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.k);
}

interface Recalled {
  /** The earlier material's answer, normalised; may hold findings even when not complete. */
  result: ResearchResult;
  answered: boolean;
  gap: string | null;
}

/** One tool-free call: do the related briefs already answer the question, and if not, what is still open? */
async function recall(door: Provider, req: ResearchRequest, related: KnownBrief[], signal?: AbortSignal): Promise<Recalled | null> {
  const meter = new ResearchMeter({ id: req.id, debateId: req.debateId, purpose: 'recall' }, door);
  meter.reusedFrom = related.map((k) => k.id);
  const startedAt = Date.now();
  // The earlier sources, numbered once across the briefs; their markers rewritten to those numbers.
  const byId = new Map<string, { n: number; c: Citation }>();
  for (const k of related) for (const c of k.citations) if (!byId.has(c.id)) byId.set(c.id, { n: byId.size + 1, c });
  const renumber = (t: string) => t.replace(/\[(c_[a-z0-9]+)\]/g, (m, id: string) => (byId.has(id) ? `[${byId.get(id)!.n}]` : ''));
  const model = modelFor(door, 'research');
  const system = researchRecallSystem();
  const prompt = researchRecallPrompt(
    req.question,
    related.map((k) => ({ question: k.question, summary: renumber(k.summary) })),
    [...byId.values()].map(({ n, c }) => ({ n, title: c.title, ...(c.quote ? { quote: c.quote } : {}) })),
  );
  // The CLI's prefix around the desk's own text is baseline, as for every research step.
  meter.beginStep(ownTokens(system, prompt));
  try {
    const out = await runJsonAgent<any>({
      model,
      system,
      prompt,
      thinking: 1_000,
      timeoutMs: 120_000,
      debateId: req.debateId,
      label: 'research:recall',
      job: 'research',
      signal,
      onRequestUsage: (u) => meter.request(u),
    });
    meter.step('recall', model, out.usage, out.costUsd ?? 0);
    const v = out.value ?? {};
    const parsed = parseModelResearch({ ...v, sources: [] });
    const result = finalise(req, {
      summary: parsed.summary,
      spoken: parsed.spoken,
      findings: parsed.findings,
      sources: [...byId.values()].map(({ n, c }) => ({
        n, url: c.url, title: c.title,
        ...(c.publisher ? { publisher: c.publisher } : {}),
        ...(c.publishedAt ? { publishedAt: c.publishedAt } : {}),
        ...(c.quote ? { quote: c.quote } : {}),
        provenance: c.provenance,
      })),
      searches: 0,
      costUsd: out.costUsd ?? 0,
      model,
      provider: door,
    }, { startedAt });
    const gap = typeof v.gap === 'string' && v.gap.trim() ? v.gap.trim() : null;
    const done = v.answered === true && result.findings.length > 0 && !gap;
    if (!done) meter.reusedFrom = result.findings.length ? meter.reusedFrom : [];
    meter.finish();
    return { result, answered: done, gap };
  } catch (err) {
    // A failed check costs only the reuse: the question is searched as usual.
    meter.step('recall', model, undefined);
    meter.stop(`recall failed: ${String((err as any)?.message ?? err).split('\n')[0].slice(0, 120)}`);
    meter.finish();
    return null;
  }
}

/** The earlier material's partial answer plus the search for what it left open, as one result. */
export function mergeResults(req: ResearchRequest, known: ResearchResult, fresh: ResearchResult): ResearchResult {
  const citations = [...known.citations];
  for (const c of fresh.citations) if (!citations.some((x) => x.id === c.id)) citations.push(c);
  const findings = [...known.findings, ...fresh.findings].slice(0, 12);
  const usable = fresh.findings.length ? fresh : null;
  return {
    requestId: req.id,
    status: findings.length ? 'ok' : fresh.status,
    summary: clampWords(usable ? `${known.summary} ${fresh.summary}` : known.summary || fresh.summary, SUMMARY_WORDS),
    spoken: fresh.spoken || known.spoken,
    findings,
    citations,
    searches: fresh.searches,
    durationMs: known.durationMs + fresh.durationMs,
    costUsd: Math.round((known.costUsd + fresh.costUsd) * 10_000) / 10_000,
    provider: fresh.provider,
    model: fresh.model,
  };
}

export async function runResearch(
  door: Provider,
  req: ResearchRequest,
  opts: { goal: string; signal?: AbortSignal; onProgress?: (note: string) => void; known?: KnownBrief[] }
): Promise<ResearchResult> {
  const key = questionKey(door, req);
  const prior = answered.get(key);
  if (prior && Date.now() - prior.at < ANSWER_TTL_MS) {
    console.log(`[research] ${req.id} answered from ${prior.result.requestId}: the same question, asked again`);
    new ResearchMeter(req, door).finish({ cached: true });
    return restamp(prior.result, req);
  }
  const shared = inflightAsks.get(key);
  if (shared) {
    const r = await shared;
    if (r.status === 'ok') {
      new ResearchMeter(req, door).finish({ cached: true });
      return restamp(r, req);
    }
  }
  const run = runWithRecall(door, req, opts);
  inflightAsks.set(key, run);
  try {
    const r = await run;
    if (r.status === 'ok') {
      answered.set(key, { at: Date.now(), result: r });
      if (answered.size > 500) answered.delete(answered.keys().next().value!);
    }
    return r;
  } finally {
    if (inflightAsks.get(key) === run) inflightAsks.delete(key);
  }
}

async function runWithRecall(
  door: Provider,
  req: ResearchRequest,
  opts: { goal: string; signal?: AbortSignal; onProgress?: (note: string) => void; known?: KnownBrief[] }
): Promise<ResearchResult> {
  const related = relatedBriefs(req.question, opts.known ?? []);
  if (!related.length) return runResearchOnce(door, req, opts);
  opts.onProgress?.('checking what the desk already has');
  const r = await recall(door, req, related, opts.signal);
  if (!r) return runResearchOnce(door, req, opts);
  if (r.answered && !invariantBreaks(r.result).length) {
    console.log(`[research] ${req.id} answered from earlier research (${related.map((k) => k.id).join(', ')}), no search`);
    return r.result;
  }
  // Only the part still open is searched; with nothing usable recalled, the whole question is.
  const g = r.gap ? gateQuestion(r.gap) : null;
  if (!r.result.findings.length || !g?.ok) return runResearchOnce(door, req, opts);
  const fresh = await runResearchOnce(door, { ...req, id: `${req.id}-gap`, question: g.question }, opts);
  const merged = mergeResults(req, r.result, fresh);
  return invariantBreaks(merged).length ? r.result : merged;
}

async function runResearchOnce(
  door: Provider,
  req: ResearchRequest,
  opts: { goal: string; signal?: AbortSignal; onProgress?: (note: string) => void }
): Promise<ResearchResult> {
  const adapter = adapterFor(door);
  const startedAt = Date.now();
  const meta = { provider: door, model: modelFor(door, 'research'), startedAt };
  if (!adapter.available(req.debateId)) {
    return emptyResult(req, 'unavailable', 'The research desk is not available on this session.', meta);
  }
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, req.budget.timeoutMs);
  const onCancel = () => ctl.abort();
  if (opts.signal?.aborted) ctl.abort();
  else opts.signal?.addEventListener('abort', onCancel, { once: true });
  try {
    const result = await adapter.run(req, { signal: ctl.signal, goal: opts.goal, onProgress: opts.onProgress });
    const broken = invariantBreaks(result);
    if (broken.length) {
      // The normaliser guarantees these; a break here is a bug, and the room is not handed a malformed result.
      console.error(`[research] ${req.id} broke its invariants: ${broken.join('; ')}`);
      return emptyResult(req, 'failed', 'The research desk returned something it could not stand behind, so nothing from it is used.', meta);
    }
    return result;
  } catch (err) {
    if (timedOut) return emptyResult(req, 'partial', 'The research desk ran out of time before it could source an answer.', meta);
    if (opts.signal?.aborted) return emptyResult(req, 'failed', 'The research request was cancelled.', meta);
    console.error(`[research] ${req.id} failed:`, err);
    const why = String((err as any)?.message ?? err).split('\n')[0].slice(0, 160);
    return emptyResult(req, 'failed', `The research desk could not answer this (${why}).`, meta);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onCancel);
  }
}
