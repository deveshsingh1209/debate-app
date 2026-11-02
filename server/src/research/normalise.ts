/**
 * One normaliser for every door (docs/PHASE2-PLAN.md 3.2-3.4).
 *
 * Each adapter turns its provider's transport into a Draft: the model's
 * findings with sources referenced by number, plus what the tools attested
 * about each source. Everything after that happens here, identically for
 * every door: citation ids, the provenance rule, dropping findings nothing
 * attests, marker rewriting, URL stripping and the word limits. That is what
 * lets the contract suite demand that the same sources normalise to the same
 * result whichever provider found them.
 *
 * Pure: no I/O, no engine.
 */
import crypto from 'node:crypto';
import type { Citation, Finding, ResearchResult } from '../../../shared/research.ts';
import type { Draft, ResearchRequest } from './types.ts';

export const SUMMARY_WORDS = 220;
export const SPOKEN_WORDS = 60;

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igshid)$/i;

/**
 * A URL as a citation shows it: no fragment, no credentials, no tracking
 * parameters, parameters in a stable order. Null for anything not http(s).
 */
export function cleanUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.username = '';
  u.password = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  let s = u.toString();
  // A trailing slash on a path is not a different page.
  if (u.pathname !== '/' && s.endsWith('/') && !u.search) s = s.slice(0, -1);
  return s;
}

/** The identity of a page: the clean URL with the scheme and a leading www. folded away. */
export function normaliseUrl(raw: string): string | null {
  const c = cleanUrl(raw);
  return c ? c.replace(/^https?:\/\/(www\.)?/, '') : null;
}

/** 'c_' + a short hash of the normalised URL: the same page gets the same id all session. */
export function citationId(url: string): string {
  const n = normaliseUrl(url) ?? url;
  return `c_${crypto.createHash('sha256').update(n).digest('hex').slice(0, 8)}`;
}

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean);

/** Cut to a word limit, at the last sentence end inside it when there is one. */
export function clampWords(text: string, max: number): string {
  const w = words(text);
  if (w.length <= max) return text.trim();
  const cut = w.slice(0, max).join(' ');
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > cut.length * 0.5 ? cut.slice(0, end + 1) : cut;
}

/** A written link: a scheme URL, or a www. address. A publisher's name ("revenue.ie") is left alone. */
const URL_RE = /\bhttps?:\/\/[^\s)\]>"']+|\bwww\.[a-z0-9-]+\.[^\s)\]>"']+/gi;

/**
 * Rewrite "[1]" / "[1, 3]" / "[1][2]" markers to citation ids, drop markers
 * that resolve to nothing, and strip any URL the model wrote into prose: the
 * only links in a result are its citations.
 */
export function rewriteMarkers(text: string, map: Map<number, string | 'uncorroborated'>): string {
  let out = text.replace(/\[(\s*\d+\s*(?:,\s*\d+\s*)*)\]/g, (_m, inner: string) => {
    const ids = inner.split(',').map((x) => map.get(Number(x.trim()))).filter(Boolean) as string[];
    const real = [...new Set(ids.filter((i) => i !== 'uncorroborated'))];
    if (real.length) return real.map((i) => `[${i}]`).join('');
    return ids.length ? '[uncorroborated]' : '';
  });
  // Markdown links keep their text; bare links go.
  out = out.replace(/\[([^\]]+)\]\((?:https?:\/\/|www\.)[^)]*\)/gi, '$1').replace(URL_RE, '');
  return out.replace(/\(\s*\)/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
}

const RANK: Record<Citation['provenance'], number> = { fetched: 3, search_result: 2, model_reported: 1 };

const str = (v: unknown, cap: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, cap);

/** Parse the model's JSON into the parts of a Draft it is responsible for. Defensive: models drift. */
export function parseModelResearch(v: any): Pick<Draft, 'summary' | 'spoken' | 'findings'> & { sources: { n: number; url: string; title: string; publisher?: string; publishedAt?: string }[] } {
  const findings = (Array.isArray(v?.findings) ? v.findings : []).slice(0, 12).map((f: any) => {
    const fig = f?.figure && typeof f.figure === 'object' && str(f.figure.value, 60)
      ? {
          value: str(f.figure.value, 60),
          ...(str(f.figure.unit, 30) ? { unit: str(f.figure.unit, 30) } : {}),
          ...(str(f.figure.as_of ?? f.figure.asOf, 40) ? { asOf: str(f.figure.as_of ?? f.figure.asOf, 40) } : {}),
        }
      : undefined;
    return {
      claim: str(f?.claim, 300),
      ...(fig ? { figure: fig } : {}),
      sources: (Array.isArray(f?.sources) ? f.sources : []).map(Number).filter((n: number) => Number.isInteger(n) && n > 0),
      confidence: (['high', 'medium', 'low'].includes(f?.confidence) ? f.confidence : 'low') as Finding['confidence'],
    };
  }).filter((f: { claim: string }) => f.claim);
  const sources = (Array.isArray(v?.sources) ? v.sources : []).slice(0, 20).map((s: any, i: number) => ({
    n: Number.isInteger(Number(s?.n)) && Number(s?.n) > 0 ? Number(s.n) : i + 1,
    url: str(s?.url, 2000),
    title: str(s?.title, 200),
    ...(str(s?.publisher, 100) ? { publisher: str(s.publisher, 100) } : {}),
    ...(str(s?.published ?? s?.publishedAt, 40) ? { publishedAt: str(s.published ?? s.publishedAt, 40) } : {}),
  })).filter((s: { url: string }) => s.url);
  return { summary: String(v?.summary ?? ''), spoken: String(v?.spoken ?? ''), findings, sources };
}

/**
 * Draft to result. The provenance rule: on the Claude and OpenAI doors a
 * source no tool attested is `model_reported` and cannot carry a finding; it
 * stays out of the citations, and the summary says "[uncorroborated]" where it
 * leaned on one. On the Codex door the SDK exposes no result URLs at all, so
 * every source is model_reported and kept, labelled as such, because dropping
 * them would leave that door with no research at all.
 */
export function finalise(
  req: ResearchRequest,
  draft: Draft,
  timing: { startedAt: number; now?: number },
  status: 'ok' | 'partial' = 'ok'
): ResearchResult {
  const now = timing.now ?? Date.now();
  const keepModelReported = draft.provider === 'codex';
  const byUrl = new Map<string, Citation>();
  const numToId = new Map<number, string | 'uncorroborated'>();

  for (const s of [...draft.sources].sort((a, b) => a.n - b.n)) {
    const norm = normaliseUrl(s.url);
    const clean = cleanUrl(s.url);
    if (!norm || !clean) continue;
    if (s.provenance === 'model_reported' && !keepModelReported) {
      if (!numToId.has(s.n)) numToId.set(s.n, 'uncorroborated');
      continue;
    }
    const id = citationId(norm);
    const prev = byUrl.get(norm);
    if (!prev || RANK[s.provenance] > RANK[prev.provenance]) {
      byUrl.set(norm, {
        id,
        url: prev?.url ?? clean,
        title: str(s.title, 200) || prev?.title || new URL(clean).hostname,
        ...(s.publisher ? { publisher: str(s.publisher, 100) } : {}),
        ...(s.publishedAt ? { publishedAt: str(s.publishedAt, 40) } : {}),
        retrievedAt: now,
        ...(s.quote ? { quote: str(s.quote, 300) } : prev?.quote ? { quote: prev.quote } : {}),
        provenance: s.provenance,
        provider: draft.provider,
      });
    }
    numToId.set(s.n, id);
  }
  const citations = [...byUrl.values()];

  const findings: Finding[] = [];
  for (const f of draft.findings) {
    const ids = [...new Set(f.sources.map((n) => numToId.get(n)).filter((x): x is string => !!x && x !== 'uncorroborated'))];
    if (!ids.length) continue;   // a finding nothing attests is not a finding
    findings.push({ claim: rewriteMarkers(f.claim, numToId) || f.claim, ...(f.figure ? { figure: f.figure } : {}), citationIds: ids, confidence: f.confidence });
  }
  // Only citations something actually uses, or that the desk listed as read, survive; order is stable.
  const used = new Set(findings.flatMap((f) => f.citationIds));
  const summary = clampWords(rewriteMarkers(draft.summary, numToId), SUMMARY_WORDS);
  for (const m of summary.matchAll(/\[(c_[a-z0-9]+)\]/g)) used.add(m[1]);
  let spoken = clampWords(rewriteMarkers(draft.spoken, numToId), SPOKEN_WORDS);
  if (!spoken && findings.length) {
    spoken = clampWords(`${findings[0].claim} ${findings[0].citationIds.map((i) => `[${i}]`).join('')}`, SPOKEN_WORDS);
  }
  for (const m of spoken.matchAll(/\[(c_[a-z0-9]+)\]/g)) used.add(m[1]);

  return {
    requestId: req.id,
    status: status === 'ok' && !findings.length ? 'partial' : status,
    summary,
    spoken,
    findings,
    citations: citations.filter((c) => used.has(c.id)),
    searches: draft.searches,
    durationMs: Math.max(0, now - timing.startedAt),
    costUsd: Math.round(draft.costUsd * 10_000) / 10_000,
    provider: draft.provider,
    model: draft.model,
  };
}

/** A result with nothing in it: a timeout, a failure, or a door that cannot research. */
export function emptyResult(
  req: ResearchRequest,
  status: 'partial' | 'failed' | 'unavailable',
  summary: string,
  meta: { provider: ResearchResult['provider']; model: string; startedAt: number }
): ResearchResult {
  return {
    requestId: req.id, status, summary, spoken: '', findings: [], citations: [],
    searches: 0, durationMs: Math.max(0, Date.now() - meta.startedAt), costUsd: 0, provider: meta.provider, model: meta.model,
  };
}

/**
 * The invariants every adapter's result must satisfy (3.4). Returns the
 * broken ones; empty means the result is sound. Run by the contract suite and
 * on every live result before it reaches the room.
 */
export function invariantBreaks(r: ResearchResult): string[] {
  const out: string[] = [];
  if (!['ok', 'partial', 'failed', 'unavailable'].includes(r.status)) out.push('status');
  if (typeof r.summary !== 'string' || typeof r.spoken !== 'string') out.push('text fields');
  if (words(r.summary).length > SUMMARY_WORDS) out.push('summary over 220 words');
  if (words(r.spoken).length > SPOKEN_WORDS) out.push('spoken over 60 words');
  const ids = new Set(r.citations.map((c) => c.id));
  if (ids.size !== r.citations.length) out.push('duplicate citation ids');
  for (const f of r.findings) {
    if (!f.citationIds.length) out.push(`finding without a citation: ${f.claim.slice(0, 40)}`);
    for (const id of f.citationIds) if (!ids.has(id)) out.push(`finding cites unknown ${id}`);
  }
  const hasUrl = new RegExp(URL_RE.source, 'i');
  for (const t of [r.summary, r.spoken]) {
    if (hasUrl.test(t)) out.push('a URL in summary or spoken');
    for (const m of t.matchAll(/\[(c_[a-z0-9]+)\]/g)) if (!ids.has(m[1])) out.push(`marker for unknown ${m[1]}`);
  }
  for (const c of r.citations) {
    if (c.id !== citationId(c.url)) out.push(`citation id does not match its URL: ${c.id}`);
    if (c.provenance === 'model_reported' && r.provider !== 'codex') out.push(`model_reported citation on the ${r.provider} door`);
    if (c.quote && c.quote.length > 300) out.push('quote over 300 chars');
    if (!/^https?:\/\//.test(c.url) || cleanUrl(c.url) !== c.url) out.push('citation URL not cleaned');
  }
  return out;
}
