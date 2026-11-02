/**
 * Token accounting for the research desk.
 *
 * The real R1 run (26 Oct 2026) spent 3.97 USD on EACH of two research calls,
 * ~378,000 cache-write tokens apiece for ~1,800 tokens of answer, while the
 * whole rest of the debate cost under 1 USD. Nothing in the app could say
 * where those tokens went: the ledger only saw one total per turn. So every
 * research call now carries a meter. It records each step (search, repair,
 * verify) with its input, cache-write, cache-read and output tokens, its
 * reported cost and the model it ran on; it feeds the live tripwire that stops
 * the search loop; and it logs one line per call that says where the tokens
 * went and whether the call stayed inside its budget.
 *
 * No I/O beyond console.log, no engine imports, so the selftests can drive it.
 */
import type { Provider } from '../../../shared/models.ts';

/** One model request's tokens, the shape sdk.ts reports. */
export interface Tokens { input: number; output: number; cacheWrite: number; cacheRead: number }

/**
 * The research desk's limits. Engineering envelopes, not spend limits: a good
 * answer to one concrete question needs a handful of searches and a few
 * pages, and nothing a seat says can raise them.
 *
 *   searches     web searches per question: one, and a second only when the
 *                write-up names a gap the first left open (Claude: one
 *                WebSearch per search session, refused by hook beyond it;
 *                OpenAI: max_tool_calls; Codex: stated in the prompt and
 *                counted). The 28 Oct real run used 4 on every call.
 *   pages        pages the desk reads itself after each search
 *   pageChars    characters of extracted text per page that any model sees
 *   hits         search results (title, snippet, date) handed to the write-up
 *   notesChars   characters of the search tool's own notes handed to it
 *   writeChars   characters of question, sources, extracts, notes and draft
 *                one write-up may carry (~10,000 tokens). A raw search result
 *                is ~145,000 characters, so a write-up can never carry one.
 *
 * The envelope measures what RESEARCH ADDS, not the fixed baseline every
 * request carries. On 1 Nov 2026 (debate d_ntnoWyeC) the Claude CLI's own
 * prefix was ~1,400 tokens on most sessions but ~47,000 on others (tool
 * definitions the desk never asked for), so a search session's FIRST
 * request, before any search, carried ~49,300 tokens; the envelope read that
 * as a search result and stopped 4 of 10 calls before they searched. Each
 * session is now calibrated on its first request: the baseline is that
 * request less what the desk itself sent, and only growth above it and
 * output count. A first request never stops a session.
 *
 *   tripwire     tokens research added in one call after which a search
 *                session is stopped and the desk writes up what it has
 *   contextTripwire  the same, for one request's growth over its session's
 *                first request. On 28 Oct the request after four WebSearch
 *                results was ~145,000 tokens larger than the first. Growth
 *                past this means a search result entered a model's context,
 *                and the session is stopped as soon as that request starts
 *   gapReserve   tokens a second search round adds (a search session and a
 *                write-up); it runs only while the call can afford it
 *   tokenBudget  the stated budget for what one research call adds, every
 *                step and every token kind summed (input + cache write +
 *                cache read + output) above the fixed baseline. R1 spent
 *                ~384,800 per call, the 28 Oct run 161,000-304,000; the
 *                baseline is logged beside it and priced in the cost report.
 *   expectedBaseline  the CLI prefix per request the desk is built for. A
 *                larger one is logged as a warning: it costs money on every
 *                request even though the envelope no longer trips on it.
 */
export const RESEARCH_LIMITS = {
  searches: 2,
  pages: 3,
  pageChars: 4_000,
  hits: 8,
  notesChars: 1_500,
  writeChars: 36_000,
  tripwire: 60_000,
  contextTripwire: 30_000,
  gapReserve: 20_000,
  tokenBudget: 80_000,
  expectedBaseline: 12_000,
} as const;

export const tokensOf = (u: Partial<Tokens> | undefined): number =>
  (u?.input ?? 0) + (u?.output ?? 0) + (u?.cacheWrite ?? 0) + (u?.cacheRead ?? 0);

/** What one request read: everything but its output. */
export const inputOf = (u: Partial<Tokens> | undefined): number =>
  (u?.input ?? 0) + (u?.cacheWrite ?? 0) + (u?.cacheRead ?? 0);

/**
 * Tokens of text the desk itself sends, from its characters. Three
 * characters a token (English runs nearer four): an overestimate, so what
 * research adds is never understated.
 */
export const ownTokens = (...texts: string[]): number => Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 3);

export interface StepRecord extends Tokens {
  step: string;
  model: string;
  /** As the provider reported it (Claude CLI) or priced from the table (OpenAI); 0 on Codex. */
  costUsd: number;
  /** Model requests inside the step, where the transport shows them (Claude CLI). */
  requests?: number;
  /** The single largest request in the step, in tokens. A runaway shows up here first. */
  largestRequest?: number;
  /** What each request of the step carried before any research: its first request less what the desk sent. */
  baseline?: number;
  /** The largest growth of one request over the baseline, in tokens. */
  largestGrowth?: number;
  /** Tokens the step added over its baseline (growth plus output); all of them where no baseline is measured. */
  added?: number;
}

export interface ResearchTokenReport {
  requestId: string;
  debateId: string;
  provider: Provider;
  steps: StepRecord[];
  /** `added`: tokens research added over the fixed baseline, what the budget holds; `baseline`: the rest. */
  totals: Tokens & { tokens: number; costUsd: number; added?: number; baseline?: number };
  searches: number;
  /** Searches the gate refused (over the allowance, a repeated query, past the tripwire). */
  refused: number;
  pages: number;
  pageChars: number;
  budget: number;
  withinBudget: boolean;
  /** Served from an earlier identical question in this debate: no model call at all. */
  cached?: boolean;
  /** Answered from earlier research in this debate (the request ids), with no search. */
  reusedFrom?: string[];
  /** Why a step was cut short to keep the call inside its envelope. */
  stopped?: string[];
  /** Figures the desk could not find in the cited source's text, so marked low confidence. */
  unconfirmed?: number;
  /** What the call was for, when it was not a room question (the architect's landscape, a crux match). */
  purpose?: string;
}

export class ResearchMeter {
  readonly steps: StepRecord[] = [];
  searches = 0;
  refused = 0;
  pages = 0;
  pageChars = 0;
  unconfirmed = 0;
  reusedFrom: string[] = [];
  readonly stopped: string[] = [];
  private live: Tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  private liveRequests = 0;
  private liveLargest = 0;
  private liveAdded = 0;
  private liveLargestGrowth = 0;
  /** The request that has started and not yet finished: counted once, and replaced when it finishes. */
  private current: Tokens | null = null;
  /** What the desk sends in the step in progress (beginStep); null: no baseline is measured. */
  private own: number | null = null;
  /** The step's baseline per request, set by its first request. */
  private base: number | null = null;

  constructor(
    readonly req: { id: string; debateId: string; purpose?: string },
    readonly provider: Provider,
    readonly budget: number = RESEARCH_LIMITS.tokenBudget,
  ) {}

  /** Record that a step was cut short, and why (shown in the log line). */
  stop(why: string) {
    if (!this.stopped.includes(why)) this.stopped.push(why);
  }

  /**
   * A model session is about to start, sending `own` tokens of the desk's
   * own text. Its first request calibrates the baseline: that request less
   * `own`, i.e. whatever the CLI put around it. Without this call nothing is
   * baseline and every token counts as added (OpenAI, Codex, the clerks).
   */
  beginStep(own: number) {
    this.own = Math.max(0, own);
    this.base = null;
  }

  private calibrate(u: Tokens) {
    if (this.base === null) this.base = this.own === null ? 0 : Math.max(0, inputOf(u) - this.own);
  }

  private growthOf(u: Tokens): number {
    return Math.max(0, inputOf(u) - (this.base ?? 0));
  }

  private commit(u: Tokens) {
    this.calibrate(u);
    this.live.input += u.input;
    this.live.output += u.output;
    this.live.cacheWrite += u.cacheWrite;
    this.live.cacheRead += u.cacheRead;
    this.liveRequests++;
    this.liveLargest = Math.max(this.liveLargest, tokensOf(u));
    const g = this.growthOf(u);
    this.liveLargestGrowth = Math.max(this.liveLargestGrowth, g);
    this.liveAdded += g + u.output;
  }

  /**
   * A request of the step in progress started (Claude CLI message_start). It
   * is billed from here, so it counts now; requestEnd replaces it, so a
   * request seen at both ends is counted once (on 1 Nov 2026 a stopped
   * request was counted twice, ~49,000 tokens extra on two calls).
   */
  requestStart(u: Tokens): { growth: number; first: boolean } {
    if (this.current) this.commit(this.current);
    this.calibrate(u);
    const first = this.liveRequests === 0;
    this.current = { ...u };
    return { growth: this.growthOf(u), first };
  }

  /** A request of the step in progress finished, with its final usage. */
  requestEnd(u: Tokens) {
    this.current = null;
    this.commit(u);
  }

  /** One model request of the step in progress finished (Claude CLI stream). */
  request(u: Tokens) {
    this.requestEnd(u);
  }

  /** Tokens a step in progress was billed for when it was stopped before reporting its own total. */
  get liveTokens(): Tokens {
    const c = this.current;
    return c
      ? { input: this.live.input + c.input, output: this.live.output + c.output, cacheWrite: this.live.cacheWrite + c.cacheWrite, cacheRead: this.live.cacheRead + c.cacheRead }
      : { ...this.live };
  }

  /** The largest single request of the step in progress, in tokens. */
  get largestLive(): number {
    return Math.max(this.liveLargest, this.current ? tokensOf(this.current) : 0);
  }

  /** The largest growth of one request of the step in progress over its baseline. */
  get largestGrowthLive(): number {
    return Math.max(this.liveLargestGrowth, this.current ? this.growthOf(this.current) : 0);
  }

  /** Tokens processed so far in this call, baseline included: finished steps plus the step in progress. */
  get running(): number {
    return this.steps.reduce((n, s) => n + tokensOf(s), 0) + tokensOf(this.liveTokens);
  }

  /** Tokens research added so far in this call, over the baseline: what the envelope holds. */
  get added(): number {
    const c = this.current;
    return this.steps.reduce((n, s) => n + (s.added ?? tokensOf(s)), 0) + this.liveAdded + (c ? this.growthOf(c) + c.output : 0);
  }

  /**
   * A step finished. `usage` is the transport's own total for it and wins over
   * the live per-request sum (they agree when both exist).
   */
  step(step: string, model: string, usage: Partial<Tokens> | undefined, costUsd = 0) {
    // A request that started and never finished (a stopped session) was billed as it started.
    if (this.current) {
      const c = this.current;
      this.current = null;
      this.commit(c);
    }
    // A transport that reported nothing (a stopped session) reports zeros; the live requests are the truth then.
    if (usage && tokensOf(usage) === 0 && this.liveRequests) usage = undefined;
    if (usage || this.liveRequests) {
      const u = {
        input: usage?.input ?? this.live.input,
        output: usage?.output ?? this.live.output,
        cacheWrite: usage?.cacheWrite ?? this.live.cacheWrite,
        cacheRead: usage?.cacheRead ?? this.live.cacheRead,
      };
      // Tokens the transport billed that the stream never showed count as added: the envelope never undercounts.
      const added = this.liveRequests ? this.liveAdded + Math.max(0, tokensOf(u) - tokensOf(this.live)) : tokensOf(u);
      const base = this.liveRequests ? this.base ?? 0 : 0;
      this.steps.push({
        step, model, ...u, costUsd,
        ...(this.liveRequests ? { requests: this.liveRequests, largestRequest: this.liveLargest } : {}),
        ...(base ? { baseline: base, largestGrowth: this.liveLargestGrowth } : {}),
        added: Math.min(added, tokensOf(u)),
      });
    }
    this.live = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    this.liveRequests = 0;
    this.liveLargest = 0;
    this.liveAdded = 0;
    this.liveLargestGrowth = 0;
    this.own = null;
    this.base = null;
  }

  report(extra: { cached?: boolean } = {}): ResearchTokenReport {
    const t = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, costUsd: 0 };
    let added = 0;
    for (const s of this.steps) {
      t.input += s.input; t.output += s.output; t.cacheWrite += s.cacheWrite; t.cacheRead += s.cacheRead; t.costUsd += s.costUsd;
      added += s.added ?? tokensOf(s);
    }
    const tokens = tokensOf(t);
    return {
      requestId: this.req.id,
      debateId: this.req.debateId,
      provider: this.provider,
      steps: this.steps.map((s) => ({ ...s })),
      totals: { ...t, costUsd: Math.round(t.costUsd * 10_000) / 10_000, tokens, added, baseline: tokens - added },
      searches: this.searches,
      refused: this.refused,
      pages: this.pages,
      pageChars: this.pageChars,
      budget: this.budget,
      withinBudget: added <= this.budget,
      ...(extra.cached ? { cached: true } : {}),
      ...(this.reusedFrom.length ? { reusedFrom: [...this.reusedFrom] } : {}),
      ...(this.stopped.length ? { stopped: [...this.stopped] } : {}),
      ...(this.unconfirmed ? { unconfirmed: this.unconfirmed } : {}),
      // Room questions are the default and go unlabelled; the architect's landscape, pre-session briefs, recalls and crux matches say so.
      ...(this.req.purpose && !['crux', 'number', 'fact_check'].includes(this.req.purpose) ? { purpose: this.req.purpose } : {}),
    };
  }

  /** Record the call in the ledger and log its one line. */
  finish(extra: { cached?: boolean } = {}): ResearchTokenReport {
    const r = this.report(extra);
    ResearchTokens.record(r);
    console.log(formatReport(r, ResearchTokens.totals(r.debateId)));
    const added = r.totals.added ?? r.totals.tokens;
    if (!r.withinBudget) console.warn(`[research:tokens] ${r.requestId} went OVER its budget: research added ${k(added)} > ${k(r.budget)} tokens (${k(r.totals.tokens)} in all)`);
    const growth = (s: StepRecord) => s.largestGrowth ?? (s.baseline === undefined ? s.largestRequest ?? 0 : 0);
    const big = r.steps.find((s) => growth(s) >= RESEARCH_LIMITS.contextTripwire);
    if (big) console.warn(`[research:tokens] ${r.requestId} ${big.step}: one request carried ${k(growth(big))} tokens over its baseline (expected under ${k(RESEARCH_LIMITS.contextTripwire)})`);
    const heavy = r.steps.reduce((m, s) => Math.max(m, s.baseline ?? 0), 0);
    if (heavy > RESEARCH_LIMITS.expectedBaseline) console.warn(`[research:tokens] ${r.requestId}: the CLI's fixed prefix was ${k(heavy)} tokens a request (expected under ${k(RESEARCH_LIMITS.expectedBaseline)}); billed on every request, not counted against the envelope`);
    return r;
  }
}

const k = (n: number) => n.toLocaleString('en-US');

export interface DebateResearchTotals { calls: number; tokens: number; costUsd: number }

export function formatReport(r: ResearchTokenReport, debate?: DebateResearchTotals): string {
  const tail = debate ? ` || debate so far: ${debate.calls} call${debate.calls === 1 ? '' : 's'}, ${k(debate.tokens)} tokens, $${debate.costUsd.toFixed(3)}` : '';
  const what = r.purpose ? ` (${r.purpose})` : '';
  if (r.cached) return `[research:tokens] ${r.requestId} ${r.provider}${what}: answered from an identical earlier question, 0 tokens${tail}`;
  if (!r.steps.length) return `[research:tokens] ${r.requestId} ${r.provider}${what}: no model usage reported (the call ended before any step finished)${tail}`;
  const steps = r.steps.map((s) =>
    `${s.step}(${s.model}) in=${k(s.input)} cw=${k(s.cacheWrite)} cr=${k(s.cacheRead)} out=${k(s.output)}` +
    (s.requests ? ` req=${s.requests} max=${k(s.largestRequest ?? 0)}` : '') +
    (s.baseline ? ` base=${k(s.baseline)}` : '') +
    (s.costUsd ? ` $${s.costUsd.toFixed(3)}` : ''));
  // The envelope holds what research added; the fixed baseline is stated beside it, never hidden.
  const added = r.totals.added ?? r.totals.tokens;
  const total = added === r.totals.tokens
    ? `total ${k(r.totals.tokens)} of ${k(r.budget)} tokens`
    : `research added ${k(added)} of ${k(r.budget)} tokens (total ${k(r.totals.tokens)}, fixed baseline ${k(r.totals.tokens - added)})`;
  return `[research:tokens] ${r.requestId} ${r.provider}${what}: ${steps.join(' | ')} || ${total}` +
    `, ${r.searches} search${r.searches === 1 ? '' : 'es'}${r.refused ? ` (${r.refused} refused)` : ''}, ${r.pages} page${r.pages === 1 ? '' : 's'} (${k(r.pageChars)} chars)` +
    (r.reusedFrom?.length ? `, reused ${r.reusedFrom.join(' ')}` : '') +
    (r.unconfirmed ? `, ${r.unconfirmed} figure${r.unconfirmed === 1 ? '' : 's'} not found in the source` : '') +
    (r.stopped?.length ? `, stopped: ${r.stopped.join('; ')}` : '') +
    `, $${r.totals.costUsd.toFixed(3)}${r.totals.costUsd || r.provider === 'codex' ? '' : ' (not reported)'}` + tail;
}

/** The research calls per debate, for tests and for anyone asking where research spend went. */
const ledger = new Map<string, ResearchTokenReport[]>();
const sums = new Map<string, DebateResearchTotals>();
export const ResearchTokens = {
  record(r: ResearchTokenReport) {
    const list = ledger.get(r.debateId) ?? [];
    list.push(r);
    ledger.set(r.debateId, list.slice(-50));
    // The running totals count every call, including those the 50-entry list has let go.
    const s = sums.get(r.debateId) ?? { calls: 0, tokens: 0, costUsd: 0 };
    sums.set(r.debateId, { calls: s.calls + 1, tokens: s.tokens + r.totals.tokens, costUsd: Math.round((s.costUsd + r.totals.costUsd) * 10_000) / 10_000 });
  },
  list(debateId: string): ResearchTokenReport[] {
    return ledger.get(debateId) ?? [];
  },
  totals(debateId: string): DebateResearchTotals {
    return sums.get(debateId) ?? { calls: 0, tokens: 0, costUsd: 0 };
  },
  drop(debateId: string) {
    ledger.delete(debateId);
    sums.delete(debateId);
  },
};

/** A search query's identity: case, punctuation and word order folded away. */
export function queryKey(q: unknown): string {
  return String(q ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
}

/** What a gate answers: run it (null), refuse it (a reason the model reads), or refuse it and end the loop. */
export type GateVerdict = string | null | { reason: string; stop: true };

/** Refusals in one call after which the loop is ended rather than told again. */
export const REFUSALS_BEFORE_STOP = 3;

/**
 * Web tool rules for a Claude CLI turn, as a toolGate for sdk.ts.
 *
 * Refused, with a sentence telling the model what to do instead: a query
 * already run in this call, a search past the allowance, and WebFetch (by
 * default: the research desk reads cited pages itself, capped and extracted;
 * `maxFetches` lets a seat that still holds it, the architect, use it a
 * bounded number of times).
 *
 * Refused AND the loop ended (unless `noStop`): any web call once the tokens
 * the call's research added pass the tripwire (only after its first search
 * ran), a second search past the allowance, and the
 * REFUSALS_BEFORE_STOP-th refusal of any kind. Telling a model that ignores
 * refusals once more costs a whole request at the full context, every time;
 * ending the loop costs nothing, and the desk asks for the write-up in one
 * tool-free turn.
 */
export function searchGate(
  meter: ResearchMeter,
  maxSearches: number,
  opts: { tripwire?: number; contextTripwire?: number; maxFetches?: number; writeUp?: string; noStop?: boolean; seen?: Set<string> } = {},
) {
  const tripwire = opts.tripwire ?? RESEARCH_LIMITS.tripwire;
  const contextTripwire = opts.contextTripwire ?? RESEARCH_LIMITS.contextTripwire;
  const writeUp = opts.writeUp ?? 'Write the research JSON now from what the searches returned.';
  // Shared across a call's search sessions, so a second round cannot rerun the first one's query.
  const seen = opts.seen ?? new Set<string>();
  const fetched = new Set<string>();
  let overAllowance = 0;
  let stopped = false;

  const refuse = (reason: string, hard = false): GateVerdict => {
    meter.refused++;
    if (!opts.noStop && (stopped || hard || meter.refused >= REFUSALS_BEFORE_STOP)) {
      stopped = true;
      return { reason, stop: true };
    }
    return reason;
  };

  return (tool: string, input: Record<string, unknown>): GateVerdict => {
    if (tool !== 'WebSearch' && tool !== 'WebFetch') return null;
    if (stopped) return refuse(writeUp, true);
    // What research added, never the fixed baseline; and a call that has not searched yet is never refused its first search.
    if (meter.searches > 0 && (meter.added >= tripwire || meter.largestGrowthLive >= contextTripwire)) return refuse(`This call has used its share of the web budget. ${writeUp}`, true);
    if (tool === 'WebFetch') {
      const url = String(input.url ?? '');
      if (!opts.maxFetches) return refuse('Do not fetch pages: the desk opens the pages you cite itself after you answer. Cite search results and write the research JSON.');
      if (fetched.has(url)) return refuse('You already opened that page. Use what it returned.');
      if (fetched.size >= opts.maxFetches) return refuse(`The page allowance (${opts.maxFetches}) is spent. ${writeUp}`);
      fetched.add(url);
      return null;
    }
    const key = queryKey(input.query);
    if (seen.has(key)) return refuse(`You already searched for "${String(input.query ?? '').slice(0, 120)}". Use that result or search for something different.`);
    if (meter.searches >= maxSearches) return refuse(`The search allowance (${maxSearches}) is spent. ${writeUp}`, ++overAllowance >= 2);
    seen.add(key);
    meter.searches++;
    return null;
  };
}

