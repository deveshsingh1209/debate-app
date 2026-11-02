/**
 * Evaluation kit: offline metrics, substance signals, the judge prompt and
 * schema, and the old-vs-new comparison. Pure functions. No model calls.
 * See docs/RUBRIC.md for the criteria this mirrors.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  computeMetrics, fromEvents, fromMarkdown, guardFalls, REALISM_TARGETS,
  type DebateInput, type Metrics,
} from '../transcript-metrics.ts';
import { anecdotes, regradeLog, type Provenance } from '../../server/src/realism/evidence.ts';

// ---------- rubric ----------

export const CRITERIA = [
  { id: 'A1', group: 'realism', name: 'Turn-shape variety' },
  { id: 'A2', group: 'realism', name: 'Interruptions and overlap' },
  { id: 'A3', group: 'realism', name: 'Concessions with cause' },
  { id: 'A4', group: 'realism', name: 'Persona consistency' },
  { id: 'A5', group: 'realism', name: 'No AI-sounding filler' },
  { id: 'B1', group: 'substance', name: 'Cruxes identified' },
  { id: 'B2', group: 'substance', name: 'Evidence quality and citations' },
  { id: 'B3', group: 'substance', name: 'Numbers checked' },
  { id: 'B4', group: 'substance', name: 'Dissent preserved' },
  { id: 'B5', group: 'substance', name: 'Decision usefulness' },
  { id: 'C1', group: 'fairness', name: 'No stacked panel' },
  { id: 'C2', group: 'fairness', name: 'Balanced airtime' },
  { id: 'C3', group: 'fairness', name: 'Steelmanning and chair neutrality' },
] as const;

// ---------- loading ----------

export interface Loaded {
  id: string;
  input: DebateInput;
  /** The raw event log; null when the source was a transcript.md. */
  events: any[] | null;
  source: string;
  /** What the evidence check may trace an observed claim to (P1). */
  provenance: Provenance;
  /** For a transcript.md: its `_Claims:` lines as claim-only message events. */
  mdClaims?: any[];
}

// ---------- provenance (what the founder and the research desk supplied) ----------

const CITE = /\bc_[A-Za-z0-9]{4,}\b/g;

/**
 * Built from the debate row when there is one (brief, clarify answers, the
 * dossier brief, research citations); from the event log alone otherwise
 * (answers, research messages' citation ids); a JSON source may carry
 * `topic`, `clarifyAnswers`, `contextBrief` and `citations` beside its events.
 */
export function provenanceOf(events: any[], extra: { topic?: string; clarifyAnswers?: Record<string, string>; contextBrief?: string | null; citations?: string[]; computations?: number } = {}): Provenance {
  const panel = events.flatMap((e) => (e?.type === 'panel' ? (e.personas ?? []).filter((p: any) => !p.isModerator && p.id !== 'marcus').map((p: any) => p.name) : e?.type === 'panel_amended' ? [e.persona?.name] : [])).filter(Boolean);
  const cited = events.flatMap((e) => (e?.type === 'message' && e.kind === 'research' ? String(e.text ?? '').match(CITE) ?? [] : e?.type === 'research_done' ? (e.result?.citations ?? []).map((c: any) => c.id) : []));
  return {
    founder: [extra.topic ?? '', ...Object.values(extra.clarifyAnswers ?? {}), extra.contextBrief ?? '', ...events.filter((e) => e?.type === 'answer').map((e) => String(e.answer ?? ''))],
    citations: [...new Set([...(extra.citations ?? []), ...cited])],
    measured: (extra.computations ?? 0) > 0 || events.some((e) => e?.type === 'compute_done' || (e?.type === 'message' && e.kind === 'quant')),
    panel: [...new Set(panel as string[])],
  };
}

/**
 * The claims a transcript.md carries: each `_Claims: [grade] text; ...` line
 * belongs to the speaker above it. Lets the kit re-grade a run that has no
 * event log, with only the citation ids the transcript lists as provenance.
 */
export function claimsFromMarkdown(md: string): any[] {
  const out: any[] = [];
  let speaker = '';
  let n = 0;
  for (const line of md.split('\n')) {
    const who = line.match(/^\*\*([^*]+?)(?: \([^)]*\))?:\*\*/);
    if (who) { speaker = who[1].trim().toLowerCase().replace(/[^a-z]/g, ''); continue; }
    const m = line.match(/^_Claims: (.*)_\s*$/);
    if (!m) continue;
    const claims = [...m[1].matchAll(/\[(measured|observed|assumed|mixed|persona)(?:; the speaker said (measured|observed|assumed|mixed|persona))?\]\s*([^[]*?)(?=;\s*\[|$)/g)]
      .map((x) => ({ text: x[3].trim(), grade: x[1], ...(x[2] ? { said: x[2] } : {}) }));
    if (claims.length) out.push({ type: 'message', id: `md${++n}`, speaker, kind: 'floor', text: '', claims });
  }
  return out;
}

/** A path to .json (event array or {events}) or .md, or a debate id looked up in the DB, then in data/debates/<id>/. */
export async function load(ref: string, dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data')): Promise<Loaded> {
  if (fs.existsSync(ref) && fs.statSync(ref).isFile()) {
    const text = fs.readFileSync(ref, 'utf8');
    const id = path.basename(ref).replace(/\.(json|md)$/, '');
    if (ref.endsWith('.md')) return mdLoaded(id, text, ref);
    const raw = JSON.parse(text);
    const events = Array.isArray(raw) ? raw : raw.events ?? [];
    return { id, input: fromEvents(id, id, events), events, source: ref, provenance: provenanceOf(events, Array.isArray(raw) ? {} : raw) };
  }
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(ref)) throw new Error(`"${ref}" is not a file, and is not a valid debate id.`);
  const dbPath = path.join(dataDir, 'debate.db');
  if (fs.existsSync(dbPath)) {
    const { openDb } = await import('../../server/src/sqlite.ts');
    const db = openDb(dbPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT id, title, topic, meta FROM debates WHERE id = ?').get(ref) as { id: string; title: string; topic: string; meta: string } | undefined;
      if (row) {
        const events = (db.prepare('SELECT payload FROM events WHERE debate_id = ? ORDER BY seq').all(ref) as { payload: string }[]).map((x) => JSON.parse(x.payload));
        const meta = JSON.parse(row.meta || '{}');
        const provenance = provenanceOf(events, {
          topic: row.topic,
          clarifyAnswers: meta.clarifyAnswers,
          contextBrief: meta.contextBrief,
          citations: (meta.researchBriefs ?? []).flatMap((b: any) => (b.citations ?? []).map((c: any) => c.id)),
          computations: (meta.computations ?? []).filter((c: any) => c.computable).length,
        });
        return { id: ref, input: fromEvents(ref, row.title, events), events, source: `${dbPath}#${ref}`, provenance };
      }
    } finally {
      db.close();
    }
  }
  const md = path.join(dataDir, 'debates', ref, 'transcript.md');
  if (fs.existsSync(md)) return mdLoaded(ref, fs.readFileSync(md, 'utf8'), md);
  throw new Error(`No debate "${ref}": not a file, not in ${dbPath}, no ${md}.`);
}

function mdLoaded(id: string, text: string, source: string): Loaded {
  const input = fromMarkdown(id, text);
  const topic = text.match(/^\*\*Topic:\*\* (.*)$/m)?.[1];
  const names = [...new Set(input.turns.filter((t) => t.kind !== 'marcus' && t.kind !== 'user').map((t) => t.name))];
  return {
    id, input, events: null, source, mdClaims: claimsFromMarkdown(text),
    provenance: { ...provenanceOf([], { topic, citations: [...new Set(text.match(CITE) ?? [])] }), panel: names, measured: /\*\*QUANT DESK/.test(text) },
  };
}

// ---------- evidence honesty (P1) ----------

export interface EvidenceAudit {
  /** Where the claims came from: the event log, or `_Claims:` lines in a transcript.md. */
  from: 'events' | 'markdown' | 'none';
  claims: number;
  /** Grade counts as the speakers gave them. */
  before: Record<string, number>;
  /** Grade counts under the evidence check. */
  after: Record<string, number>;
  /** Every claim the check moved, with why. */
  regraded: { speaker: string; text: string; from: string; to: string; reason: string }[];
  /** Expert turns that tell a first-person anecdote as fact (the lint's persona_anecdote flag). */
  anecdoteTurns: number;
  anecdotes: { speaker: string; sentence: string }[];
}

const tally = (xs: string[]) => xs.reduce<Record<string, number>>((m, g) => ({ ...m, [g]: (m[g] ?? 0) + 1 }), {});

export function evidenceAudit(l: Loaded): EvidenceAudit {
  const events = l.events ?? l.mdClaims ?? [];
  const log = regradeLog(events, l.provenance);
  const spoken = l.input.turns.filter((t) => ['floor', 'interjection', 'closing', 'reaction'].includes(t.kind));
  const stories = spoken.flatMap((t) => anecdotes(t.text).map((sentence) => ({ speaker: t.name, sentence })));
  return {
    from: !log.length ? 'none' : l.events ? 'events' : 'markdown',
    claims: log.length,
    before: tally(log.map((r) => r.before.grade)),
    after: tally(log.map((r) => r.after.grade)),
    regraded: log.filter((r) => r.reason).map((r) => ({ speaker: r.speaker, text: r.before.text, from: r.before.grade, to: r.after.grade, reason: r.reason })),
    anecdoteTurns: spoken.filter((t) => anecdotes(t.text).length).length,
    anecdotes: stories,
  };
}

export function renderEvidenceAudit(id: string, a: EvidenceAudit): string {
  const grades = ['measured', 'observed', 'mixed', 'assumed', 'persona'];
  const row = (g: string) => `| ${g} | ${a.before[g] ?? 0} | ${a.after[g] ?? 0} |`;
  return [
    `# Evidence honesty: ${id}`,
    '',
    `Claims re-graded with the P1 rules: ${a.claims} (from the ${a.from === 'markdown' ? 'transcript.md claim lines' : a.from === 'events' ? 'event log' : 'nothing: no graded claims found'}).`,
    '',
    '| grade | as the speakers gave it | under the evidence check |',
    '|---|---|---|',
    ...grades.map(row),
    '',
    `Claims moved: ${a.regraded.length}. Expert turns telling a first-person anecdote as fact: ${a.anecdoteTurns}.`,
    '',
    '## Claims the check moved',
    '',
    ...(a.regraded.length ? a.regraded.map((r) => `- ${r.speaker}: [${r.from} -> ${r.to}, ${r.reason}] ${r.text}`) : ['- none']),
    '',
    '## First-person anecdotes in speech',
    '',
    ...(a.anecdotes.length ? a.anecdotes.map((s) => `- ${s.speaker}: ${s.sentence}`) : ['- none']),
    '',
  ].join('\n');
}

// ---------- substance signals (offline proxies for group B) ----------

export interface Substance {
  hasEventLog: boolean;
  rulings: number;
  rulingsWithOwner: number;
  rulingsWithStopRule: number;
  evidenceMix: Record<string, number>;
  dissents: number;
  dissentsWithReasoning: number;
  undecidable: number;
  claims: Record<string, number>;
  /** Expert turns carrying a digit-bearing figure. */
  figureTurns: number;
  /** Of those, how many sit next to a derivation cue (because, per, x, =, so that). A proxy for "shown, not asserted". */
  figureTurnsWithDerivation: number;
  computeEvents: number;
  citations: number;
  panel: { id: string; name: string; role: string; biases: string }[];
  silentSeats: string[];
}

const STOP_RULE = /\b(stop|stops|halt|abandon|revisit|review at|if (it|we|the)|unless|trigger|kill)\b/i;
const FIGURE = /(\$|€|£|₹)\s?\d|\b\d[\d,]*(\.\d+)?\s?(%|k\b|m\b|x\b|times\b|per\b|weeks?|months?|days?|hours?)/i;
const DERIVATION = /(because|so that|therefore|\bper\b|\btimes\b|×|=|divided|multiplied|which gives|works out|that is)/i;
const CITATION = /(https?:\/\/\S+|\((observed|measured|assumed)[^)]*\)|\[\d+\])/gi;

export function substanceSignals(events: any[] | null, input: DebateInput): Substance {
  const s: Substance = {
    hasEventLog: !!events, rulings: 0, rulingsWithOwner: 0, rulingsWithStopRule: 0, evidenceMix: {},
    dissents: 0, dissentsWithReasoning: 0, undecidable: 0, claims: {}, figureTurns: 0, figureTurnsWithDerivation: 0,
    computeEvents: 0, citations: 0, panel: [], silentSeats: [],
  };
  const spoken = input.turns.filter((t) => ['floor', 'interjection', 'closing', 'reaction'].includes(t.kind));
  for (const t of spoken) {
    if (FIGURE.test(t.text)) {
      s.figureTurns++;
      if (DERIVATION.test(t.text)) s.figureTurnsWithDerivation++;
    }
    s.citations += (t.text.match(CITATION) ?? []).length;
  }
  if (!events) return s;

  const final = new Map<string, any>();
  for (const ev of events) {
    if (ev.type === 'panel') {
      for (const p of ev.personas ?? []) {
        if (p.isModerator || p.id === 'marcus') continue;
        if (!s.panel.some((x) => x.id === p.id)) s.panel.push({ id: p.id, name: p.name, role: p.role ?? '', biases: p.biases ?? '' });
      }
    } else if (ev.type === 'panel_amended' && ev.persona && !s.panel.some((x) => x.id === ev.persona.id)) {
      s.panel.push({ id: ev.persona.id, name: ev.persona.name, role: ev.persona.role ?? '', biases: ev.persona.biases ?? '' });
    } else if (ev.type === 'decision' && ev.decision?.motionId) final.set(ev.decision.motionId, ev.decision);
    else if (ev.type === 'motion_reopened') final.delete(ev.motionId);
    else if (ev.type === 'compute_done') s.computeEvents++;
    else if (ev.type === 'message') {
      for (const c of ev.claims ?? []) s.claims[c.grade] = (s.claims[c.grade] ?? 0) + 1;
    }
  }
  for (const d of final.values()) {
    s.rulings++;
    if (String(d.owner ?? '').trim()) s.rulingsWithOwner++;
    if (STOP_RULE.test(`${d.decision ?? ''} ${d.rationale ?? ''}`)) s.rulingsWithStopRule++;
    s.evidenceMix[d.evidence ?? 'none'] = (s.evidenceMix[d.evidence ?? 'none'] ?? 0) + 1;
    for (const x of d.dissents ?? []) {
      s.dissents++;
      if (String(x.reasoning ?? '').trim().length > 20) s.dissentsWithReasoning++;
    }
    if (d.undecidable?.question) s.undecidable++;
  }
  const speakers = new Set(spoken.map((t) => t.speaker));
  s.silentSeats = s.panel.filter((p) => !speakers.has(p.id)).map((p) => p.name);
  return s;
}

// ---------- the evaluation record ----------

export interface Evaluation {
  id: string;
  source: string;
  metrics: Metrics;
  substance: Substance;
  /** The claims re-graded under the P1 evidence rules. */
  evidence: EvidenceAudit;
}

export function evaluate(l: Loaded): Evaluation {
  const metrics = computeMetrics(l.input);
  return { id: l.id, source: l.source, metrics, substance: substanceSignals(l.events, l.input), evidence: evidenceAudit(l) };
}

// ---------- judge prompt and schema (never sent anywhere by this kit) ----------

const MAX_TRANSCRIPT_CHARS = 120_000;

export function judgeSchema() {
  const score = { anyOf: [{ type: 'integer', minimum: 1, maximum: 5 }, { type: 'null' }] };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'DebateJudgement',
    type: 'object',
    additionalProperties: false,
    required: ['criteria', 'groups', 'overall', 'blocking', 'metricOverrides', 'summary'],
    properties: {
      criteria: {
        type: 'array',
        minItems: CRITERIA.length,
        maxItems: CRITERIA.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'score', 'quote', 'reason'],
          properties: {
            id: { enum: CRITERIA.map((c) => c.id) },
            score,
            quote: { type: 'string', maxLength: 200, description: 'Verbatim, 25 words max, with speaker or turn id. Empty only when score is null.' },
            reason: { type: 'string', maxLength: 400 },
          },
        },
      },
      groups: {
        type: 'object',
        additionalProperties: false,
        required: ['realism', 'substance', 'fairness'],
        properties: { realism: { type: ['number', 'null'] }, substance: { type: ['number', 'null'] }, fairness: { type: ['number', 'null'] } },
      },
      overall: { type: ['number', 'null'] },
      blocking: { type: 'array', items: { enum: CRITERIA.map((c) => c.id) }, description: 'Criteria in substance or fairness scored 1.' },
      metricOverrides: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['metric', 'why'], properties: { metric: { type: 'string' }, why: { type: 'string' } } } },
      summary: { type: 'string', maxLength: 800 },
    },
  };
}

/** Light structural check of a judge's JSON output. Returns problems, empty when fine. */
export function checkJudgement(j: any): string[] {
  const bad: string[] = [];
  if (!j || typeof j !== 'object') return ['not an object'];
  const ids = new Set<string>();
  for (const c of j.criteria ?? []) {
    if (!CRITERIA.some((x) => x.id === c.id)) bad.push(`unknown criterion ${c.id}`);
    if (ids.has(c.id)) bad.push(`duplicate ${c.id}`);
    ids.add(c.id);
    if (c.score !== null && !(Number.isInteger(c.score) && c.score >= 1 && c.score <= 5)) bad.push(`${c.id}: score must be 1-5 or null`);
    if (c.score !== null && c.score > 3 && !String(c.quote ?? '').trim()) bad.push(`${c.id}: a score above 3 needs a quote`);
  }
  for (const c of CRITERIA) if (!ids.has(c.id)) bad.push(`missing ${c.id}`);
  return bad;
}

function renderTranscript(input: DebateInput): string {
  const out = input.turns.map((t, i) => {
    const tag = t.kind === 'marcus' ? 'CHAIR' : t.kind === 'user' ? 'FOUNDER' : t.kind.toUpperCase();
    const flags = `${t.cutOff ? ' [cut off]' : ''}${t.overlap ? ' [overlap]' : ''}`;
    return `[${i + 1}] ${t.name} (${tag}${flags}): ${t.text}`;
  });
  let text = out.join('\n\n');
  if (text.length > MAX_TRANSCRIPT_CHARS) text = `${text.slice(0, MAX_TRANSCRIPT_CHARS)}\n\n[transcript truncated at ${MAX_TRANSCRIPT_CHARS} characters; score only what you can see and use null otherwise]`;
  return text;
}

function renderRulings(events: any[] | null): string {
  if (!events) return '(no event log: rulings are not available for a transcript.md; score B4 and B5 from the transcript or use null)';
  const final = new Map<string, any>();
  for (const ev of events) {
    if (ev.type === 'decision' && ev.decision?.motionId) final.set(ev.decision.motionId, ev.decision);
    else if (ev.type === 'motion_reopened') final.delete(ev.motionId);
  }
  if (!final.size) return '(no rulings in the log)';
  return JSON.stringify([...final.values()], null, 2);
}

export function judgePrompt(l: Loaded, e: Evaluation): string {
  const rubric = fs.readFileSync(path.resolve(import.meta.dirname ?? '.', '../../docs/RUBRIC.md'), 'utf8');
  const m = e.metrics;
  const proxies = {
    realismIndex: m.realismIndex, expertTurns: m.expertTurns, wordsCv: m.words.cv, shortTurnShare: m.shortTurnShare,
    interruptionRate: m.interruptionRate, overlapRate: m.overlapRate, concessionPer100: m.concessionPer100,
    fillerTurnShare: m.fillerTurnShare, tics: m.tics, openerRepeatShare: m.openerRepeatShare,
    giniTurns: m.giniTurns, chairWordShare: m.chairWordShare, guards: m.guards, substance: { ...e.substance, panel: undefined },
  };
  const panel = e.substance.panel.length
    ? e.substance.panel.map((p) => `- ${p.name}: ${p.role}. Biases: ${p.biases || 'n/a'}`).join('\n')
    : '(panel not available)';
  return [
    'You are an independent judge of a recorded boardroom debate. Score it against the rubric below.',
    'Respond with one JSON object that matches the JSON schema at the end, and nothing else.',
    '',
    '=== RUBRIC ===',
    rubric,
    '',
    '=== OFFLINE METRICS (proxies; override them when the text disagrees, and list each override) ===',
    JSON.stringify(proxies, null, 2),
    '',
    '=== PANEL ===',
    panel,
    '',
    '=== FINAL RULINGS ===',
    renderRulings(l.events),
    '',
    `=== TRANSCRIPT (debate ${e.id}; ${l.input.turns.length} turns; flags in brackets) ===`,
    renderTranscript(l.input),
    '',
    '=== JSON SCHEMA FOR YOUR ANSWER ===',
    JSON.stringify(judgeSchema(), null, 2),
  ].join('\n');
}

// ---------- model-call gate ----------

export const ALLOW_ENV = 'EVAL_ALLOW_MODEL_CALLS';

/** Returns a refusal message, or null when the explicit opt-in is present. */
export function modelCallRefusal(env: Record<string, string | undefined> = process.env): string | null {
  if (env[ALLOW_ENV] === '1') return null;
  return `--judge-with refused. It would send the whole transcript to a model and use your quota. Set ${ALLOW_ENV}=1 to allow it. Nothing was sent.`;
}

// ---------- rendering one evaluation ----------

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function renderEvaluation(e: Evaluation): string {
  const m = e.metrics, s = e.substance;
  const lines = [
    `# Evaluation: ${e.id}`,
    '',
    `Source: ${e.source}`,
    `Realism index: **${m.realismIndex}/100** (${m.expertTurns} expert turns, ${m.chairTurns} chair turns, ${m.founderAnswers} founder answers)`,
    '',
    '## Weakest realism metrics',
    '',
    ...weakest(m).map((w) => `- ${w.key}: value ${w.value}, score ${w.score} (target ${w.lo}..${w.hi})`),
    '',
    '## Substance signals (offline proxies)',
    '',
    s.hasEventLog
      ? `- rulings ${s.rulings} (owner ${s.rulingsWithOwner}, stop/revisit rule ${s.rulingsWithStopRule}); evidence mix ${JSON.stringify(s.evidenceMix)}`
      : '- no event log: ruling signals unavailable',
    s.hasEventLog ? `- dissents ${s.dissents} (with reasoning ${s.dissentsWithReasoning}); undecidable questions ${s.undecidable}` : '',
    `- turns with a figure ${s.figureTurns}, of which show a derivation ${s.figureTurnsWithDerivation}; compute events ${s.computeEvents}; citations/tags ${s.citations}`,
    s.hasEventLog ? `- graded claims ${JSON.stringify(s.claims)}` : '',
    '',
    '## Evidence honesty (P1 rules)',
    '',
    e.evidence.claims
      ? `- claims as graded ${JSON.stringify(e.evidence.before)}; under the evidence check ${JSON.stringify(e.evidence.after)}; moved ${e.evidence.regraded.length}`
      : '- no graded claims to check',
    `- expert turns telling a first-person anecdote as fact: ${e.evidence.anecdoteTurns}${e.evidence.claims ? ' (`--evidence` lists them)' : ''}`,
    '',
    '## Fairness signals',
    '',
    `- speaker balance Gini (turns) ${m.giniTurns}, (words) ${m.giniWords}; chair share of words ${pct(m.chairWordShare)}`,
    s.silentSeats.length ? `- silent seats: ${s.silentSeats.join(', ')}` : '- no silent seats',
    m.guards ? `- guards: ${JSON.stringify(m.guards)}` : '- guards unavailable (transcript.md)',
  ];
  return lines.filter((x) => x !== '').join('\n').replace(/\n(##)/g, '\n\n$1') + '\n';
}

function weakest(m: Metrics) {
  return REALISM_TARGETS
    .map((t) => ({ key: t.key, value: round(t.get(m)), score: m.realismParts[t.key] ?? 0, lo: t.lo, hi: t.hi }))
    .filter((x) => x.score < 1)
    .sort((a, b) => a.score - b.score)
    .slice(0, 6);
}
const round = (x: number, p = 2) => Math.round(x * 10 ** p) / 10 ** p;

// ---------- comparison ----------

export interface Comparison { markdown: string; verdict: 'improved' | 'regressed' | 'mixed' | 'unchanged'; guardFalls: string[]; }

const COMPARE_ROWS: [string, (e: Evaluation) => number | null, 'up' | 'down' | 'none'][] = [
  ['Realism index', (e) => e.metrics.realismIndex, 'up'],
  ['Words per turn CV', (e) => e.metrics.words.cv, 'up'],
  ['Turns under 40 words (share)', (e) => e.metrics.shortTurnShare, 'none'],
  ['Turns over 150 words (share)', (e) => e.metrics.memoTurnShare, 'down'],
  ['Interruptions per 100 turns', (e) => e.metrics.interruptionRate, 'none'],
  ['Overlap per 100 turns', (e) => e.metrics.overlapRate, 'none'],
  ['Questions (share of turns)', (e) => e.metrics.questionShare, 'up'],
  ['A-B-A exchange rate', (e) => e.metrics.pingPongRate, 'none'],
  ['Concessions per 100 turns', (e) => e.metrics.concessionPer100, 'none'],
  ['Filler turns (share)', (e) => e.metrics.fillerTurnShare, 'down'],
  ['Summary endings (share)', (e) => e.metrics.summaryEndingShare, 'down'],
  ['Repeated openers (share)', (e) => e.metrics.openerRepeatShare, 'down'],
  ['Recycled 4-grams (share)', (e) => e.metrics.recycled4gramShare, 'down'],
  ['Speaker Gini (turns)', (e) => e.metrics.giniTurns, 'none'],
  ['Rulings', (e) => (e.substance.hasEventLog ? e.substance.rulings : null), 'up'],
  ['Dissents on rulings', (e) => (e.substance.hasEventLog ? e.substance.dissents : null), 'up'],
  ['Rulings with a stop/revisit rule', (e) => (e.substance.hasEventLog ? e.substance.rulingsWithStopRule : null), 'up'],
  ['Figure turns showing a derivation', (e) => e.substance.figureTurnsWithDerivation, 'up'],
  ['Compute events', (e) => e.substance.computeEvents, 'up'],
  ['Silent seats', (e) => (e.substance.hasEventLog ? e.substance.silentSeats.length : null), 'down'],
  ['Claims graded observed that the evidence check moves', (e) => (e.evidence.claims ? e.evidence.regraded.filter((r) => r.from === 'observed').length : null), 'down'],
  ['Expert turns telling a first-person anecdote as fact', (e) => e.evidence.anecdoteTurns, 'down'],
];

export function compare(before: Evaluation, after: Evaluation, label = { before: 'old', after: 'new' }): Comparison {
  const delta = (a: number | null, b: number | null) => (a === null || b === null ? '-' : `${b - a >= 0 ? '+' : ''}${round(b - a)}`);
  const rows = COMPARE_ROWS.map(([name, f, dir]) => {
    const a = f(before), b = f(after);
    const mark = a === null || b === null || a === b || dir === 'none' ? '' : (b > a) === (dir === 'up') ? ' better' : ' worse';
    return `| ${name} | ${a ?? '-'} | ${b ?? '-'} | ${delta(a, b)}${mark} |`;
  });

  const falls = before.metrics.guards && after.metrics.guards ? guardFalls(before.metrics.guards, after.metrics.guards) : [];
  const gain = after.metrics.realismIndex - before.metrics.realismIndex;
  const verdict: Comparison['verdict'] = falls.length
    ? (gain > 0 ? 'mixed' : 'regressed')
    : gain > 1 ? 'improved' : gain < -1 ? 'regressed' : 'unchanged';

  const partDeltas = REALISM_TARGETS
    .map((t) => ({ key: t.key, d: (after.metrics.realismParts[t.key] ?? 0) - (before.metrics.realismParts[t.key] ?? 0) }))
    .filter((x) => Math.abs(x.d) >= 0.05)
    .sort((a, b) => b.d - a.d);

  const md = [
    `# Comparison: ${before.id} (${label.before}) vs ${after.id} (${label.after})`,
    '',
    `Verdict: **${verdict}**. Realism index ${before.metrics.realismIndex} -> ${after.metrics.realismIndex} (${gain >= 0 ? '+' : ''}${round(gain, 1)}).`,
    falls.length
      ? `Decision-quality guards that fell by more than 10%: **${falls.join(', ')}**. Realism must not cost decision quality; do not ship on the index alone.`
      : before.metrics.guards && after.metrics.guards
        ? 'No decision-quality guard fell by more than 10%.'
        : 'Guards not compared (one side is a transcript.md without an event log).',
    '',
    `| metric | ${label.before} | ${label.after} | change |`,
    '|---|---|---|---|',
    ...rows,
    '',
    '## Realism parts that moved (score 0..1)',
    '',
    ...(partDeltas.length ? partDeltas.map((p) => `- ${p.key}: ${p.d > 0 ? '+' : ''}${round(p.d)}`) : ['- none moved by 0.05 or more']),
    '',
    '## Caveats',
    '',
    '- Offline proxies only. A regex voices a concession; it cannot tell it was sincere. Run the judge prompt (`npm run eval -- <id> --judge`) on both sides before shipping.',
    '- Two runs of different topics differ for reasons that are not the engine. Compare like with like, or pool several runs per side.',
    `- Runs under 20 expert turns are noisy (${before.id}: ${before.metrics.expertTurns}, ${after.id}: ${after.metrics.expertTurns}).`,
    '',
  ].join('\n');
  return { markdown: md, verdict, guardFalls: falls };
}
