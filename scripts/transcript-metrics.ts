/**
 * Offline realism metrics for debate transcripts. No model calls, no network.
 *
 * Phase 2 needs a baseline it can be held to: "make the room sound real" is
 * not testable, but "turn-length CV went from 0.4 to 1.1 and the 'X is not A,
 * it is B' tic went from 30 to 5 per 100 turns" is. Everything here is a pure
 * function of the transcript text and the event log, so the same numbers come
 * out every time and a change to the engine can be measured against them.
 *
 * Inputs (any one):
 *   --db <path>        a debate.db (opened READ-ONLY). Default: ./data/debate.db
 *   --debate <id>      restrict to one debate (repeatable)
 *   --events <file>    a JSON array of DebateEvent (e.g. a fixture)
 *   --md <file>        a transcript.md (best effort; files written before Phase 2b
 *                      carry no founder answers)
 * Output:
 *   default            a markdown table per debate plus a pooled baseline
 *   --json             the full metric objects as JSON
 *   --min-turns <n>    debates with fewer expert turns are listed but left out
 *                      of the pooled baseline (default 20)
 *   --titles           print debate titles (off by default: titles can be personal)
 *   --self-test        run the built-in checks and exit
 *
 *   npx tsx scripts/transcript-metrics.ts
 *   npm run metrics -- --json
 *
 * Every metric is defined next to its code. A few are proxies, and say so: a
 * regex cannot know whether a concession was sincere, only that one was voiced.
 */
import fs from 'node:fs';
import path from 'node:path';

// ---------- input model ----------

/** One spoken contribution, normalised from whatever the source was. */
export interface Turn {
  speaker: string;          // persona id, 'marcus', or 'user'
  name: string;             // display name ('Ana Ruiz')
  kind: 'floor' | 'interjection' | 'closing' | 'reaction' | 'marcus' | 'user';
  /** The spoken words only. A cut turn's unsaid remainder never reaches the event log. */
  text: string;
  /** Phase 2b: this turn was cut off mid-sentence. */
  cutOff?: boolean;
  /** Phase 2b: this turn was spoken over another one. */
  overlap?: boolean;
}

export interface DebateInput {
  id: string;
  title: string;
  turns: Turn[];
  /** First names of everyone seated, for address detection and opener normalisation. */
  firstNames: string[];
  chairFirstName: string;   // 'Marcus'
  founderFirstName: string | null;
  /** Decision-quality guards; only an event log carries them (null for transcript.md). */
  guards?: Guards | null;
}

/**
 * 'reaction' is the short turn kind planned for Phase 2b (docs/PHASE2-PLAN.md).
 * Asides are their own event type there and never count as speech to the room.
 */
const EXPERT_KINDS = new Set(['floor', 'interjection', 'closing', 'reaction']);

// ---------- text helpers ----------

const words = (t: string): string[] => t.trim().split(/\s+/).filter(Boolean);
const wordCount = (t: string) => words(t).length;
const paragraphs = (t: string) => t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).length;
/** Sentence split that tolerates "e.g." and decimals well enough for counting. */
const sentences = (t: string): string[] =>
  t.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z"'(*])/).map((s) => s.trim()).filter(Boolean);
/** Strip a leading *stage direction* line so it does not count as the opener. */
const stripStage = (t: string) => t.replace(/^\s*\*[^*\n]{1,80}\*\s*/, '');
const tokens = (t: string): string[] =>
  t.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9'%$.\s-]/g, ' ').replace(/(?<!\d)\.|\.(?!\d)/g, ' ').split(/\s+/).filter(Boolean);

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
/**
 * Gini coefficient of a non-negative distribution. 0 = everyone has the same
 * share; approaches 1 as one person holds all of it. Computed over SEATED
 * experts, including those with zero turns, so a silent seat counts.
 */
export function gini(xs: number[]): number {
  const v = xs.filter((x) => x >= 0).sort((a, b) => a - b);
  const n = v.length;
  const total = v.reduce((a, b) => a + b, 0);
  if (n < 2 || total === 0) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * v[i];
  return (2 * cum) / (n * total) - (n + 1) / n;
}
const per100 = (n: number, d: number) => (d ? (100 * n) / d : 0);
const per1k = (n: number, d: number) => (d ? (1000 * n) / d : 0);
const round = (x: number, p = 2) => Math.round(x * 10 ** p) / 10 ** p;

// ---------- phrase lexicons ----------

/**
 * The lexicons are data shared with the realism linter and the prompt
 * selftest (shared/lexicon.ts), so a tic counted here is the same tic the
 * engine refuses and the prompts may not seed.
 */
import { FILLER, CONCESSION, CONCESSION_BROAD, DISCOURSE_OPENER, POSITION_CHANGE, TICS, SUMMARY_ENDING } from '../shared/lexicon.ts';
export { FILLER, CONCESSION, CONCESSION_BROAD, POSITION_CHANGE, TICS };

// ---------- the metrics ----------

export interface Metrics {
  id: string;
  title?: string;
  expertTurns: number;
  chairTurns: number;
  founderAnswers: number;
  experts: number;
  words: { mean: number; sd: number; cv: number; p10: number; p50: number; p90: number; min: number; max: number };
  /** Share of expert turns under 40 words (a human room is full of these). */
  shortTurnShare: number;
  /** Share of expert turns over 150 words: a memo, not a remark. */
  memoTurnShare: number;
  multiParagraphShare: number;
  sentenceWordsCv: number;
  /** Interjections plus turns cut off mid-sentence, per 100 expert turns. */
  interruptionRate: number;
  /** Turns spoken over another turn, per 100 expert turns. Only Phase 2b event logs can carry it; older logs read 0. */
  overlapRate: number;
  /** Share of expert turns that address the chair by name (talking to the moderator, not each other). */
  addressesChairShare: number;
  addressesColleagueShare: number;
  addressesFounderShare: number;
  questionShare: number;
  /** A-B-A within three consecutive expert turns: a live exchange rather than a queue. */
  pingPongRate: number;
  concessionPer100: number;
  positionChangePer100: number;
  /** Seated experts who voiced at least one concession. */
  expertsConcedingShare: number;
  fillerTurnShare: number;
  tics: Record<string, number>;
  emDashPer1k: number;
  summaryEndingShare: number;
  /** Share of expert turns whose normalised first three words are shared by 3+ turns. */
  openerRepeatShare: number;
  topOpeners: { opener: string; n: number }[];
  /** Mean share of a turn's 4-grams that already appeared in an earlier turn of the same debate. */
  recycled4gramShare: number;
  /** Same, restricted to the speaker's own earlier turns. */
  selfRecycled4gramShare: number;
  topRepeated4grams: { gram: string; turns: number }[];
  giniTurns: number;
  giniWords: number;
  chairWordShare: number;
  /** 0-100, the weighted closeness of every metric to its target band. See REALISM_TARGETS. */
  realismIndex: number;
  /** Each metric's 0..1 score, so nobody optimises the single number blind. */
  realismParts: Record<string, number>;
  guards: Guards | null;
}

// ---------- realism index ----------

/**
 * The target band for each metric. Inside the band a metric scores 1; outside,
 * it loses score linearly with distance and hits 0 at `scale` away. Weight 2
 * marks the structural metrics, which is where the artificiality was.
 *
 * CALIBRATED (2b-6). The rhythm metrics (turn length, turn-taking, overlap,
 * questions, balance) use the bands measured by running this same script over
 * the AMI and ICSI meeting corpora (docs/HUMAN-CALIBRATION.md,
 * docs/calibration-proposed-bands.json; tags [AMI], [ICSI], 40-turn windows),
 * with the owner's reconciliations: real talking-over (about a second or
 * more) is 3-20 per 100, Gini and A-B-A depend on panel size, the chair is a
 * light facilitator (10-20% of words), discourse-marker openers ("yeah I
 * think", "okay so") are not repeats, and concessions are counted with a
 * broader word list at half weight until a real run calibrates them. The
 * lexicon metrics keep their documented literature bands
 * (docs/HUMAN-BASELINES.md, tags [CANDOR], [MRDA], ...). Every band decision
 * is recorded in docs/ENGINE-REPORT.md.
 *
 * `band` (optional) makes a band depend on the room itself, e.g. the number of
 * experts who spoke; `lo` and `hi` are then the typical (4-5 expert) band.
 */
export interface RealismTarget {
  key: string;
  get: (m: Metrics) => number;
  lo: number;
  hi: number;
  scale: number;
  weight: number;
  band?: (m: Metrics) => { lo: number; hi: number };
}

/** The band that applies to this room: the size-aware one when a metric has it. */
export function bandOf(t: RealismTarget, m: Metrics): { lo: number; hi: number } {
  return t.band ? t.band(m) : { lo: t.lo, hi: t.hi };
}

/** Panel size buckets for the size-aware bands: 3 or fewer experts, 4-5, 6 or more. */
const bySize = (small: [number, number], mid: [number, number], large: [number, number]) => (m: Metrics) => {
  const [lo, hi] = m.experts <= 3 ? small : m.experts <= 5 ? mid : large;
  return { lo, hi };
};

export const REALISM_TARGETS: RealismTarget[] = [
  // [AMI]/[ICSI] 40-turn windows p10-p90: 0.86-2.29 and 1.04-2.07. The ceiling stops a
  // room of one-word reactions plus monologues scoring as real. High.
  { key: 'wordsCv', get: (m) => m.words.cv, lo: 0.9, hi: 2.3, scale: 0.6, weight: 2 },
  // p10 is 1-2 words in every window of both corpora; 6 leaves room for the 2-15 word
  // reaction shape. Scale tightened from 100 so a p10 of 60 no longer scores 0.5. High.
  { key: 'wordsP10', get: (m) => m.words.p10, lo: 0, hi: 6, scale: 30, weight: 1 },
  // Windows p10-p90: [AMI] 12-54, [ICSI] 17-69. Ceiling raised to 90 for the panel
  // genre's set pieces; the old floor of 120 (and the literature's 40) failed the
  // median human window. Medium.
  { key: 'wordsP90', get: (m) => m.words.p90, lo: 20, hi: 90, scale: 60, weight: 1 },
  // Windows p10: [AMI] 0.85, [ICSI] 0.80. Floor set below the human p10 on purpose
  // (expert panels run longer turns than design meetings); open above. Medium.
  { key: 'shortTurnShare', get: (m) => m.shortTurnShare, lo: 0.65, hi: 1, scale: 0.3, weight: 2 },
  // Windows p90: [AMI] 0.03, [ICSI] 0.044; 0.08 allows twice the human rate for set pieces. Medium.
  { key: 'memoTurnShare', get: (m) => m.memoTurnShare, lo: 0, hi: 0.08, scale: 0.3, weight: 2 },
  // ASSUMPTION: speech has no paragraphs. Nearest proxy: mean 2 units per turn,
  // most turns one unit [THRELKELD22], [ROBINSON22].
  { key: 'multiParagraphShare', get: (m) => m.multiParagraphShare, lo: 0, hi: 0.15, scale: 0.5, weight: 1 },
  // Windows p10-p90: [AMI] 5-25, [ICSI] 5-20; the detector matches ICSI's hand-coded
  // interrupted acts in rate (11.2 vs 10.9 per 100). Medium.
  { key: 'interruptionRate', get: (m) => m.interruptionRate, lo: 5, hi: 20, scale: 10, weight: 2 },
  // Real talking-over, not turn-change jitter: at an overlap of a second or more the
  // windows read [ICSI] 0-12.5 and [AMI] 5-27.5 per 100. The engine only overlaps on a
  // performed cut-in, so the band is 3-20 (owner decision; corpus at the 1 s threshold).
  { key: 'overlapRate', get: (m) => m.overlapRate, lo: 3, hi: 20, scale: 10, weight: 2 },
  // Size-aware. [AMI] (3 non-chair speakers) windows 0.26-0.58. With more experts, chance
  // A-B-A falls as 1/(N-1); [ICSI] reads higher (0.37-0.79) only because it has no chair
  // and counts the leader as an expert. Bands: <=3 experts 0.25-0.60, 4-5 0.20-0.55,
  // 6+ 0.15-0.50 (anchored on AMI, scaled by chance; ASSUMPTION beyond 3).
  { key: 'pingPongRate', get: (m) => m.pingPongRate, lo: 0.2, hi: 0.55, scale: 0.15, weight: 2, band: bySize([0.25, 0.6], [0.2, 0.55], [0.15, 0.5]) },
  // Windows p10-p90: [AMI] 0.03-0.20, [ICSI] 0.05-0.25; the '?' count matches the
  // DA-coded question count within 0.01. Agrees with [STROMER07]/[MRDA]. High.
  { key: 'questionShare', get: (m) => m.questionShare, lo: 0.05, hi: 0.25, scale: 0.15, weight: 2 },
  // Participants respond to the moderator in 10% of turns [STROMER07]; vocatives of
  // any name ~4.2 per 1k words, so <=7% of turns [MCCARTHY03]. Low.
  { key: 'addressesChairShare', get: (m) => m.addressesChairShare, lo: 0, hi: 0.1, scale: 0.2, weight: 1 },
  // UNCALIBRATED, half weight. Counted with the broader list (CONCESSION_BROAD: "fair
  // enough", "granted", "true, ...", "I'll give you that") on top of CONCESSION. The
  // corpus read ~0 with the strict list because people concede with "yeah"/"true"
  // [AMI]/[ICSI], which drops the old floor; the ceiling stays at the literature's
  // upper bound [BACHTIGER16]. Recalibrate on the first real run.
  { key: 'concessionPer100', get: (m) => m.concessionPer100, lo: 0, hi: 12, scale: 10, weight: 0.5 },
  // ChangeMyView, a forum built to change minds: ~0.45 deltas per thread of ~54 replies
  // = 0.83 per 100 turns [TAN16]; juries reverse the first majority in ~1 in 10 cases
  // [GASTIL07]. Low-medium.
  { key: 'positionChangePer100', get: (m) => m.positionChangePer100, lo: 0, hi: 2, scale: 3, weight: 1 },
  // Appreciation + thanks 1.45% of ICSI DAs [MRDA], appreciation 2% of Switchboard
  // utterances [SWBD00]; ~2.4 DAs per turn gives ~3-5% of turns. GPT-4 opens 31.5% of
  // turns with agreement tokens [MAYOR25]. Medium-low.
  { key: 'fillerTurnShare', get: (m) => m.fillerTurnShare, lo: 0, hi: 0.05, scale: 0.1, weight: 1 },
  // ASSUMPTION for speech: a transcript has no authored dashes. Human written prose
  // runs ~3.2 per 1k words [FREEBURG26]; not a usable spoken target.
  { key: 'emDashPer1k', get: (m) => m.emDashPer1k, lo: 0, hi: 0.5, scale: 2, weight: 1 },
  // Summarize/reformulate 0.5% of Switchboard utterances [SWBD00], 0.09% of ICSI tags
  // [MRDA]; consensus meta-talk 0.7% of thoughts [STROMER07]. Low.
  { key: 'summaryEndingShare', get: (m) => m.summaryEndingShare, lo: 0, hi: 0.02, scale: 0.08, weight: 1 },
  // Windows median 0-0.08, p90 0.13-0.15 [AMI]/[ICSI], almost all of it discourse-marker
  // openers ("yeah I think", "okay so"). Those no longer count as repeats (DISCOURSE_OPENER),
  // so 0.10 still flags a house opener. Low.
  { key: 'openerRepeatShare', get: (m) => m.openerRepeatShare, lo: 0, hi: 0.1, scale: 0.15, weight: 1 },
  // ASSUMPTION. No whole-conversation 4-gram figure; adjacent-turn word reuse is ~9%
  // vs ~6% by chance [HEALEY14]; LLM lexical alignment runs 1.3-3.3x human [MAYOR25].
  { key: 'recycled4gramShare', get: (m) => m.recycled4gramShare, lo: 0, hi: 0.03, scale: 0.05, weight: 1 },
  // Size-aware: Gini rises with group size [ROSE20]. Windows: [AMI] (3 speakers)
  // 0.05-0.30, [ICSI] (4-6) 0.15-0.42. Bands: <=3 experts 0.05-0.30, 4-5 0.10-0.40,
  // 6+ 0.15-0.45. Uneven air-time is wanted (owner decision); a near-zero Gini is a
  // rota, not a room. Medium.
  { key: 'giniTurns', get: (m) => m.giniTurns, lo: 0.1, hi: 0.4, scale: 0.2, weight: 1, band: bySize([0.05, 0.3], [0.1, 0.4], [0.15, 0.45]) },
  // Owner decision: the chair is a LIGHT facilitator, 10-20% of words. The corpus floor
  // agrees ([AMI] Project Manager windows p10 0.11); its median 0.28 is a presenter-chair
  // who also runs the slides, so the ceiling stays at 0.20 ([STROMER07] ~16%). Medium-low.
  { key: 'chairWordShare', get: (m) => m.chairWordShare, lo: 0.1, hi: 0.2, scale: 0.15, weight: 1 },
  // Tics: ASSUMPTION, no human analogue. These count this engine's own prompt-born
  // constructions (docs/PHASE2-PLAN.md 1.2); the bands say "rare", not a human rate.
  { key: 'tic.antithesis', get: (m) => m.tics.antithesis ?? 0, lo: 0, hi: 5, scale: 15, weight: 1 },
  { key: 'tic.labelParenthetical', get: (m) => m.tics.labelParenthetical ?? 0, lo: 0, hi: 3, scale: 25, weight: 1 },
  { key: 'tic.closerToRight', get: (m) => m.tics.closerToRight ?? 0, lo: 0, hi: 1, scale: 5, weight: 1 },
  { key: 'tic.metaSpeech', get: (m) => m.tics.metaSpeech ?? 0, lo: 0, hi: 2, scale: 6, weight: 1 },
  { key: 'tic.falsifierJargon', get: (m) => m.tics.falsifierJargon ?? 0, lo: 0, hi: 1, scale: 5, weight: 1 },
];

export function realismIndex(m: Omit<Metrics, 'realismIndex' | 'realismParts'>): { index: number; parts: Record<string, number> } {
  const parts: Record<string, number> = {};
  let sum = 0, weights = 0;
  for (const t of REALISM_TARGETS) {
    const v = t.get(m as Metrics);
    const { lo, hi } = bandOf(t, m as Metrics);
    const dist = v < lo ? lo - v : v > hi ? v - hi : 0;
    const score = Math.max(0, 1 - dist / t.scale);
    parts[t.key] = round(score);
    sum += score * t.weight;
    weights += t.weight;
  }
  return { index: round((100 * sum) / weights, 1), parts };
}

// ---------- decision-quality guards ----------

/**
 * What realism must not cost. A change to the engine ships only if the realism
 * index rises AND none of these falls by more than 10% (guardFalls). They come
 * from the event log: a transcript.md does not carry rungs or rulings.
 */
export interface Guards {
  motions: number;
  /** Mean of the highest rung each motion reached (0-4). */
  meanTopRung: number;
  /** Mean fresh arguments per refereed round (the checkpoint, before 2b-7). */
  freshPerCheckpoint: number;
  /** Adversary defeaters that survived into a ruling as dissents. */
  defeatersLanded: number;
  /** Dissents on the final ruling of each motion. */
  dissents: number;
  /** Share of final rulings graded above `assumed`. */
  rulingsAboveAssumed: number;
  /**
   * Expert turns that state a figure in speech with no graded claim carrying a
   * figure in their claims record: a number with no source and no grade. Needs
   * the 2b-3 claims record; null for a log that has none.
   */
  unsupportedFigures: number | null;
  /**
   * Not a guard, a readout for the real runs: share of linted expert turns
   * whose form the fast tier rewrote (target ≤ 25-30%). Null without lint records.
   */
  lintRewriteRate: number | null;
}

export function computeGuards(events: any[]): Guards {
  const topRung = new Map<string, number>();
  const fresh: number[] = [];
  const finalRuling = new Map<string, any>();
  let hasClaims = false;
  let unsupported = 0;
  let linted = 0;
  let rewritten = 0;
  for (const ev of events) {
    if (ev.type === 'message' && EXPERT_KINDS.has(ev.kind)) {
      if (ev.claims) hasClaims = true;
      if (/\d/.test(String(ev.text ?? '')) && !(ev.claims ?? []).some((c: any) => /\d/.test(String(c.text ?? '')))) unsupported++;
      if (ev.lint) { linted++; if (ev.lint.rewrote) rewritten++; }
    } else if (ev.type === 'round') {
      topRung.set(ev.motionId, Math.max(topRung.get(ev.motionId) ?? 0, Number(ev.rung ?? 0)));
      fresh.push(Number(ev.freshArguments ?? 0));
    } else if (ev.type === 'decision' && ev.decision?.motionId) {
      finalRuling.set(ev.decision.motionId, ev.decision);
    } else if (ev.type === 'motion_reopened') {
      finalRuling.delete(ev.motionId);
    }
  }
  const rulings = [...finalRuling.values()];
  const dissents = rulings.flatMap((d) => d.dissents ?? []);
  return {
    motions: rulings.length,
    meanTopRung: round(mean([...topRung.values()]), 2),
    freshPerCheckpoint: round(mean(fresh), 2),
    defeatersLanded: dissents.filter((x) => /adversary/i.test(String(x.expert ?? ''))).length,
    dissents: dissents.length,
    rulingsAboveAssumed: round(rulings.length ? rulings.filter((d) => d.evidence && d.evidence !== 'assumed').length / rulings.length : 0),
    unsupportedFigures: hasClaims ? unsupported : null,
    lintRewriteRate: linted ? round(rewritten / linted) : null,
  };
}

/** The guards that fell by more than `tolerance` (a share) from `before` to `after`. Higher is better for all but unsupportedFigures. */
export function guardFalls(before: Guards, after: Guards, tolerance = 0.1): string[] {
  const falls: string[] = [];
  for (const k of ['meanTopRung', 'freshPerCheckpoint', 'defeatersLanded', 'dissents', 'rulingsAboveAssumed'] as const) {
    if (before[k] > 0 && after[k] < before[k] * (1 - tolerance)) falls.push(k);
  }
  if (before.unsupportedFigures !== null && after.unsupportedFigures !== null && after.unsupportedFigures > before.unsupportedFigures * (1 + tolerance)) {
    falls.push('unsupportedFigures');
  }
  return falls;
}

/** Replace seated first names with a placeholder so "Marcus, ..." and "Ana, ..." count as one opener. */
function normaliseNames(t: string, names: string[]): string {
  let out = t;
  for (const n of names) {
    if (!n) continue;
    out = out.replace(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), 'NAME');
  }
  return out;
}

function opener(t: string, names: string[]): string {
  const first = tokens(normaliseNames(stripStage(t), names)).slice(0, 3);
  return first.join(' ');
}

const STOP4 = new Set(['name', 'the', 'a', 'of', 'to', 'and', 'is', 'it', 'that', 'in']);

function grams4(t: string, names: string[]): string[] {
  const tk = tokens(normaliseNames(t, names)).filter((w) => !/^\d/.test(w));
  const out: string[] = [];
  for (let i = 0; i + 4 <= tk.length; i++) {
    const g = tk.slice(i, i + 4);
    // A 4-gram made only of glue words is grammar, not a phrase anyone chose.
    if (g.every((w) => STOP4.has(w))) continue;
    out.push(g.join(' '));
  }
  return out;
}

export function computeMetrics(d: DebateInput): Metrics {
  const expert = d.turns.filter((t) => EXPERT_KINDS.has(t.kind));
  const chair = d.turns.filter((t) => t.kind === 'marcus');
  const founder = d.turns.filter((t) => t.kind === 'user');
  const wc = expert.map((t) => wordCount(t.text));
  const sorted = [...wc].sort((a, b) => a - b);
  const m = mean(wc);
  const s = sd(wc);

  const seated = [...new Set(expert.map((t) => t.speaker))];
  const others = (sp: string) => d.firstNames.filter((n) => n && n !== d.chairFirstName && n !== d.founderFirstName && !nameOf(sp, expert).startsWith(n));
  const re = (n: string) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);

  let addrChair = 0, addrColleague = 0, addrFounder = 0, questions = 0, filler = 0, concessions = 0, changes = 0, summaryEnd = 0;
  const conceders = new Set<string>();
  const tic: Record<string, number> = Object.fromEntries(Object.keys(TICS).map((k) => [k, 0]));
  let emDashes = 0;
  const sentenceLens: number[] = [];

  for (const t of expert) {
    const text = t.text;
    if (re(d.chairFirstName).test(text)) addrChair++;
    if (others(t.speaker).some((n) => re(n).test(text))) addrColleague++;
    if (d.founderFirstName && re(d.founderFirstName).test(text)) addrFounder++;
    if (text.includes('?')) questions++;
    if (FILLER.some((r) => r.test(text))) filler++;
    // Strict markers or the broader human ones ("fair enough", "true, but"): one hit per turn.
    if (CONCESSION.some((r) => r.test(text)) || CONCESSION_BROAD.some((r) => r.test(text))) { concessions++; conceders.add(t.speaker); }
    if (POSITION_CHANGE.some((r) => r.test(text))) changes++;
    for (const [k, r] of Object.entries(TICS)) {
      if (k === 'narrowly' ? r.test(stripStage(text).trim()) : r.test(text)) tic[k]++;
    }
    emDashes += (text.match(/—/g) ?? []).length;
    const ss = sentences(stripStage(text));
    for (const x of ss) sentenceLens.push(wordCount(x));
    const last = ss[ss.length - 1] ?? '';
    if (ss.length > 2 && SUMMARY_ENDING.test(last)) summaryEnd++;
  }

  // A-B-A: the same two people trading blows across three consecutive expert turns.
  let pingPong = 0;
  for (let i = 2; i < expert.length; i++) {
    if (expert[i].speaker === expert[i - 2].speaker && expert[i].speaker !== expert[i - 1].speaker) pingPong++;
  }

  // Openers.
  const openers = expert.map((t) => opener(t.text, d.firstNames));
  const openerCount = new Map<string, number>();
  for (const o of openers) openerCount.set(o, (openerCount.get(o) ?? 0) + 1);
  // "yeah I think", "okay so": how human turns start, not a house style (2b-6 calibration).
  const marker = (o: string) => DISCOURSE_OPENER.has(o.split(' ')[0] ?? '');
  const openerRepeat = openers.filter((o) => !marker(o) && (openerCount.get(o) ?? 0) >= 3).length;
  const topOpeners = [...openerCount.entries()].filter(([o, n]) => n >= 3 && !marker(o)).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([opener, n]) => ({ opener, n }));

  // Recycled phrasing.
  const seenAll = new Set<string>();
  const seenBy = new Map<string, Set<string>>();
  const gramTurns = new Map<string, number>();
  const recycled: number[] = [];
  const selfRecycled: number[] = [];
  for (const t of expert) {
    const g = grams4(t.text, d.firstNames);
    const own = seenBy.get(t.speaker) ?? new Set<string>();
    if (g.length) {
      recycled.push(g.filter((x) => seenAll.has(x)).length / g.length);
      selfRecycled.push(g.filter((x) => own.has(x)).length / g.length);
    }
    for (const x of new Set(g)) gramTurns.set(x, (gramTurns.get(x) ?? 0) + 1);
    for (const x of g) { seenAll.add(x); own.add(x); }
    seenBy.set(t.speaker, own);
  }
  const topRepeated4grams = [...gramTurns.entries()].filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([gram, turns]) => ({ gram, turns }));

  // Balance over seated experts (anyone who spoke at least once; the event log
  // knows the roster but a transcript.md does not, so this is the common denominator).
  const turnsBy = seated.map((sp) => expert.filter((t) => t.speaker === sp).length);
  const wordsBy = seated.map((sp) => expert.filter((t) => t.speaker === sp).reduce((a, t) => a + wordCount(t.text), 0));
  const expertWords = wc.reduce((a, b) => a + b, 0);
  const chairWords = chair.reduce((a, t) => a + wordCount(t.text), 0);
  const n = expert.length;

  const base = {
    id: d.id,
    title: d.title,
    expertTurns: n,
    chairTurns: chair.length,
    founderAnswers: founder.length,
    experts: seated.length,
    words: { mean: round(m, 1), sd: round(s, 1), cv: round(m ? s / m : 0), p10: round(quantile(sorted, 0.1), 0), p50: round(quantile(sorted, 0.5), 0), p90: round(quantile(sorted, 0.9), 0), min: sorted[0] ?? 0, max: sorted[sorted.length - 1] ?? 0 },
    shortTurnShare: round(n ? wc.filter((x) => x < 40).length / n : 0),
    memoTurnShare: round(n ? wc.filter((x) => x > 150).length / n : 0),
    multiParagraphShare: round(n ? expert.filter((t) => paragraphs(t.text) > 1).length / n : 0),
    sentenceWordsCv: round(mean(sentenceLens) ? sd(sentenceLens) / mean(sentenceLens) : 0),
    interruptionRate: round(per100(expert.filter((t) => t.kind === 'interjection' || t.cutOff).length, n), 1),
    overlapRate: round(per100(expert.filter((t) => t.overlap).length, n), 1),
    addressesChairShare: round(n ? addrChair / n : 0),
    addressesColleagueShare: round(n ? addrColleague / n : 0),
    addressesFounderShare: round(n ? addrFounder / n : 0),
    questionShare: round(n ? questions / n : 0),
    pingPongRate: round(n > 2 ? pingPong / (n - 2) : 0),
    concessionPer100: round(per100(concessions, n), 1),
    positionChangePer100: round(per100(changes, n), 1),
    expertsConcedingShare: round(seated.length ? conceders.size / seated.length : 0),
    fillerTurnShare: round(n ? filler / n : 0),
    tics: Object.fromEntries(Object.entries(tic).map(([k, v]) => [k, round(per100(v, n), 1)])),
    emDashPer1k: round(per1k(emDashes, expertWords), 2),
    summaryEndingShare: round(n ? summaryEnd / n : 0),
    openerRepeatShare: round(n ? openerRepeat / n : 0),
    topOpeners,
    recycled4gramShare: round(mean(recycled), 3),
    selfRecycled4gramShare: round(mean(selfRecycled), 3),
    topRepeated4grams,
    giniTurns: round(gini(turnsBy)),
    giniWords: round(gini(wordsBy)),
    chairWordShare: round(expertWords + chairWords ? chairWords / (expertWords + chairWords) : 0),
    guards: d.guards ?? null,
  };
  const { index, parts } = realismIndex(base);
  return { ...base, realismIndex: index, realismParts: parts };
}

function nameOf(speaker: string, turns: Turn[]): string {
  return turns.find((t) => t.speaker === speaker)?.name ?? speaker;
}

/** Pool several debates' metrics into one baseline, weighting by expert turns. */
export function pool(ms: Metrics[]): Record<string, number> {
  const total = ms.reduce((a, m) => a + m.expertTurns, 0);
  const w = (f: (m: Metrics) => number) => round(ms.reduce((a, m) => a + f(m) * m.expertTurns, 0) / (total || 1), 3);
  const out: Record<string, number> = {
    debates: ms.length,
    expertTurns: total,
    wordsMean: w((m) => m.words.mean),
    wordsCv: w((m) => m.words.cv),
    wordsP10: w((m) => m.words.p10),
    wordsP90: w((m) => m.words.p90),
    shortTurnShare: w((m) => m.shortTurnShare),
    memoTurnShare: w((m) => m.memoTurnShare),
    multiParagraphShare: w((m) => m.multiParagraphShare),
    interruptionRate: w((m) => m.interruptionRate),
    overlapRate: w((m) => m.overlapRate),
    questionShare: w((m) => m.questionShare),
    realismIndex: w((m) => m.realismIndex),
    addressesChairShare: w((m) => m.addressesChairShare),
    addressesColleagueShare: w((m) => m.addressesColleagueShare),
    pingPongRate: w((m) => m.pingPongRate),
    concessionPer100: w((m) => m.concessionPer100),
    positionChangePer100: w((m) => m.positionChangePer100),
    expertsConcedingShare: w((m) => m.expertsConcedingShare),
    fillerTurnShare: w((m) => m.fillerTurnShare),
    emDashPer1k: w((m) => m.emDashPer1k),
    summaryEndingShare: w((m) => m.summaryEndingShare),
    openerRepeatShare: w((m) => m.openerRepeatShare),
    recycled4gramShare: w((m) => m.recycled4gramShare),
    selfRecycled4gramShare: w((m) => m.selfRecycled4gramShare),
    giniTurns: w((m) => m.giniTurns),
    giniWords: w((m) => m.giniWords),
    chairWordShare: w((m) => m.chairWordShare),
  };
  for (const k of Object.keys(TICS)) out[`tic.${k}`] = w((m) => m.tics[k] ?? 0);
  return out;
}

// ---------- loaders ----------

/** Build a DebateInput from an event array (the source of truth). */
export function fromEvents(id: string, title: string, events: any[], founderName: string | null = null): DebateInput {
  const personas = new Map<string, string>();
  for (const ev of events) {
    if (ev.type === 'panel') for (const p of ev.personas ?? []) personas.set(p.id, p.name);
    if (ev.type === 'panel_amended' && ev.persona) personas.set(ev.persona.id, ev.persona.name);
  }
  const turns: Turn[] = [];
  for (const ev of events) {
    // Asides are their own event type and never count as speech to the room.
    if (ev.type === 'message' && ['floor', 'interjection', 'closing', 'reaction', 'marcus'].includes(ev.kind)) {
      turns.push({ speaker: ev.speaker, name: personas.get(ev.speaker) ?? ev.speaker, kind: ev.kind, text: String(ev.text ?? ''), cutOff: !!ev.cutOff, overlap: !!ev.overlap });
    } else if (ev.type === 'answer') {
      turns.push({ speaker: 'user', name: founderName ?? 'Founder', kind: 'user', text: String(ev.answer ?? '') });
    }
  }
  const firstNames = [...new Set([...personas.values()].map(firstName).filter(Boolean))];
  return {
    id, title, turns, firstNames, chairFirstName: 'Marcus',
    founderFirstName: founderName ? firstName(founderName) : guessFounder(turns, firstNames),
    guards: computeGuards(events),
  };
}

/**
 * Titles like "Dr." and quoted nicknames ("Wen-Li "Wendy" Ho") are skipped:
 * the room addresses people by the name they are called.
 */
function firstName(full: string): string {
  const nick = full.match(/["“]([^"”]+)["”]/);
  if (nick) return nick[1];
  const parts = full.replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '').split(/\s+/);
  return parts[0] ?? '';
}

/**
 * The founder's name is not in the log (FOUNDER_NAME is config), so guess it:
 * the capitalised vocative most often used by the chair that is not a seat.
 */
function guessFounder(turns: Turn[], seats: string[]): string | null {
  const counts = new Map<string, number>();
  for (const t of turns.filter((x) => x.kind === 'marcus')) {
    for (const m of t.text.matchAll(/\b([A-Z][a-z]{2,})\b[,:]/g)) {
      const w = m[1];
      if (seats.includes(w) || w === 'Marcus' || /^(Right|First|Second|Third|One|Two|Three|Here|Now|So|And|But|Yes|No|Meanwhile|Then|Hold|Fine)$/.test(w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 ? best[0] : null;
}

/**
 * Parse a transcript.md written by appendTranscriptFile. Since Phase 2b the
 * file also carries the founder's mid-meeting answers ("**Name (founder):**")
 * and the chair's questions to him ("**Marcus asks the founder:**"); older
 * files have neither. Clarify answers sit in the header and are not turns.
 */
export function fromMarkdown(id: string, md: string): DebateInput {
  const turns: Turn[] = [];
  const re = /^\*\*([^*]+?)(?: \((interrupting|closing|joining|founder)\))?:\*\* ?([\s\S]*?)(?=\n\n\*\*[^*]+?:\*\*|\n\n---|\n*$)/gm;
  for (const m of md.matchAll(re)) {
    const name = m[1].trim();
    if (/^(RESEARCH DESK|QUANT DESK|NUMBERS AUDIT)/.test(name) || name.startsWith('DECISION') || name.startsWith('Ruling')) continue;
    if (/^(Ruling|Owner|Why|Evidence grade|Dissents|Undecidable|Topic|Goal|Clarifications)$/.test(name)) continue;
    const chair = name === 'Marcus' || name.startsWith('Marcus asks') || name.startsWith('Marcus, deciding');
    const kind: Turn['kind'] = chair ? 'marcus' : m[2] === 'founder' ? 'user' : m[2] === 'interrupting' ? 'interjection' : m[2] === 'closing' ? 'closing' : 'floor';
    const speaker = chair ? 'marcus' : kind === 'user' ? 'user' : name.toLowerCase().replace(/[^a-z]/g, '');
    turns.push({ speaker, name: chair ? 'Marcus' : name, kind, text: m[3].trim() });
  }
  const firstNames = [...new Set(turns.filter((t) => t.kind !== 'marcus').map((t) => firstName(t.name)))];
  return { id, title: id, turns, firstNames, chairFirstName: 'Marcus', founderFirstName: guessFounder(turns, firstNames) };
}

async function fromDb(dbPath: string, only: string[]): Promise<DebateInput[]> {
  const { openDb } = await import('../server/src/sqlite.ts');
  const db = openDb(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT id, title FROM debates ORDER BY created_at').all() as { id: string; title: string }[];
    const pick = only.length ? rows.filter((r) => only.includes(r.id)) : rows;
    const stmt = db.prepare('SELECT payload FROM events WHERE debate_id = ? ORDER BY seq');
    return pick.map((r) => fromEvents(r.id, r.title, (stmt.all(r.id) as { payload: string }[]).map((x) => JSON.parse(x.payload))));
  } finally {
    db.close();
  }
}

// ---------- output ----------

const ROWS: [string, (m: Metrics) => string | number][] = [
  ['REALISM INDEX (0-100)', (m) => m.realismIndex],
  ['expert turns / chair turns / founder answers', (m) => `${m.expertTurns} / ${m.chairTurns} / ${m.founderAnswers}`],
  ['seated experts who spoke', (m) => m.experts],
  ['words per turn: mean (sd)', (m) => `${m.words.mean} (${m.words.sd})`],
  ['words per turn: CV', (m) => m.words.cv],
  ['words per turn: p10 / p50 / p90', (m) => `${m.words.p10} / ${m.words.p50} / ${m.words.p90}`],
  ['turns under 40 words', (m) => pct(m.shortTurnShare)],
  ['turns over 150 words', (m) => pct(m.memoTurnShare)],
  ['multi-paragraph turns', (m) => pct(m.multiParagraphShare)],
  ['interruptions per 100 turns', (m) => m.interruptionRate],
  ['true overlap (talking over) per 100 turns', (m) => m.overlapRate],
  ['turns addressing the chair by name', (m) => pct(m.addressesChairShare)],
  ['turns addressing a colleague by name', (m) => pct(m.addressesColleagueShare)],
  ['turns addressing the founder', (m) => pct(m.addressesFounderShare)],
  ['turns containing a question', (m) => pct(m.questionShare)],
  ['A-B-A exchange rate', (m) => pct(m.pingPongRate)],
  ['concession markers per 100 turns', (m) => m.concessionPer100],
  ['explicit position changes per 100 turns', (m) => m.positionChangePer100],
  ['experts who conceded at least once', (m) => pct(m.expertsConcedingShare)],
  ['turns with praise/agreement filler', (m) => pct(m.fillerTurnShare)],
  ['em-dashes per 1k words', (m) => m.emDashPer1k],
  ['turns ending on a summary line', (m) => pct(m.summaryEndingShare)],
  ['turns sharing a 3-word opener with 2+ others', (m) => pct(m.openerRepeatShare)],
  ['4-grams recycled from earlier turns', (m) => pct(m.recycled4gramShare)],
  ['4-grams recycled from own earlier turns', (m) => pct(m.selfRecycled4gramShare)],
  ['speaker balance Gini (turns)', (m) => m.giniTurns],
  ['speaker balance Gini (words)', (m) => m.giniWords],
  ['chair share of spoken words', (m) => pct(m.chairWordShare)],
  ...Object.keys(TICS).map((k): [string, (m: Metrics) => number] => [`tic per 100 turns: ${k}`, (m) => m.tics[k]]),
  ['GUARD motions ruled', (m) => m.guards?.motions ?? '-'],
  ['GUARD mean top rung per motion', (m) => m.guards?.meanTopRung ?? '-'],
  ['GUARD fresh arguments per checkpoint', (m) => m.guards?.freshPerCheckpoint ?? '-'],
  ['GUARD adversary defeaters landed', (m) => m.guards?.defeatersLanded ?? '-'],
  ['GUARD dissents on final rulings', (m) => m.guards?.dissents ?? '-'],
  ['GUARD rulings graded above assumed', (m) => (m.guards ? pct(m.guards.rulingsAboveAssumed) : '-')],
  ['GUARD turns stating a figure with no graded claim', (m) => m.guards?.unsupportedFigures ?? '-'],
  ['lint: share of expert turns rewritten', (m) => (m.guards?.lintRewriteRate != null ? pct(m.guards.lintRewriteRate) : '-')],
];
const pct = (x: number) => `${Math.round(x * 100)}%`;

function table(ms: Metrics[], titles: boolean): string {
  const head = `| metric | ${ms.map((m) => (titles && m.title ? `${m.id} (${m.title})` : m.id)).join(' | ')} |`;
  const sep = `|---|${ms.map(() => '---').join('|')}|`;
  return [head, sep, ...ROWS.map(([label, f]) => `| ${label} | ${ms.map((m) => f(m)).join(' | ')} |`)].join('\n');
}

// ---------- self-test ----------

function selfTest(): number {
  let fails = 0;
  const ok = (name: string, cond: boolean, detail = '') => {
    console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
    if (!cond) fails++;
  };
  ok('gini of equal shares is 0', gini([5, 5, 5, 5]) === 0);
  ok('gini of one holder of four is 0.75', Math.abs(gini([0, 0, 0, 12]) - 0.75) < 1e-9, String(gini([0, 0, 0, 12])));
  ok('gini ignores order', gini([1, 2, 3]) === gini([3, 1, 2]));

  const ev = [
    { type: 'panel', personas: [{ id: 'marcus', name: 'Marcus Hale' }, { id: 'ana', name: 'Ana Ruiz' }, { id: 'bo', name: 'Dr. Bo Chen' }] },
    { type: 'message', speaker: 'marcus', kind: 'marcus', text: 'Dana, one question for you: is the price fixed? Dana, answer when you can.' },
    { type: 'message', speaker: 'ana', kind: 'floor', text: 'Great point, Bo. The price is not a cost, it is a signal. Marcus, get the desk to check it.' },
    { type: 'message', speaker: 'bo', kind: 'interjection', text: 'No.' },
    { type: 'message', speaker: 'ana', kind: 'floor', text: 'I was wrong about the margin, Bo is right. So the answer is to price it higher.' },
    { type: 'answer', answer: 'Fixed at $40.' },
  ];
  const m = computeMetrics(fromEvents('t', 't', ev));
  ok('counts expert turns, chair turns and answers', m.expertTurns === 3 && m.chairTurns === 1 && m.founderAnswers === 1, JSON.stringify([m.expertTurns, m.chairTurns, m.founderAnswers]));
  ok('interjection rate', Math.abs(m.interruptionRate - 33.3) < 0.1, String(m.interruptionRate));
  ok('filler detected once', Math.abs(m.fillerTurnShare - 0.33) < 0.01, String(m.fillerTurnShare));
  ok('antithesis tic detected', m.tics.antithesis > 0, JSON.stringify(m.tics));
  ok('position change detected', m.positionChangePer100 > 0);
  ok('chair addressed once', Math.abs(m.addressesChairShare - 0.33) < 0.01, String(m.addressesChairShare));
  ok('colleague addressed (Bo)', m.addressesColleagueShare > 0.6, String(m.addressesColleagueShare));
  ok('A-B-A detected', m.pingPongRate === 1, String(m.pingPongRate));
  ok('short turn share counts "No."', m.shortTurnShare === 1, String(m.shortTurnShare));
  ok('founder name guessed from the chair', fromEvents('t', 't', ev).founderFirstName === 'Dana');
  ok('nickname is the first name', firstName('Wen-Li "Wendy" Ho') === 'Wendy' && firstName('Dr. Bo Chen') === 'Bo');

  const md = `**Ana Ruiz:** First thing.\n\n**Bo Chen (interrupting):** Second thing.\n\n**Marcus:** Third.\n\n**RESEARCH DESK (q):** facts\n\n**Ana Ruiz (closing):** Last.\n\n`;
  const mm = fromMarkdown('md', md);
  ok('markdown parse: four spoken turns, desk skipped', mm.turns.length === 4, JSON.stringify(mm.turns.map((t) => t.kind)));
  ok('markdown parse: kinds', mm.turns.map((t) => t.kind).join(',') === 'floor,interjection,marcus,closing');
  const md2 = `# T\n\n**Topic:** x\n\n**Clarifications:**\n\n- **Q:** Which market?\n  **Dana (founder):** India\n\n---\n\n**Ana Ruiz:** First.\n\n**Marcus asks the founder:** Price fixed?\n\n**Dana (founder):** Fixed at $40.\n\n**Bo Chen:** Then it is settled.\n\n`;
  const m2 = computeMetrics(fromMarkdown('md2', md2));
  ok('markdown parse: founder answers and chair questions', m2.expertTurns === 2 && m2.chairTurns === 1 && m2.founderAnswers === 1, JSON.stringify([m2.expertTurns, m2.chairTurns, m2.founderAnswers]));

  // Phase 2b: reactions are expert turns, overlap and cut-offs count, asides never do.
  const ev2 = [
    { type: 'panel', personas: [{ id: 'ana', name: 'Ana Ruiz' }, { id: 'bo', name: 'Bo Chen' }] },
    { type: 'message', id: 'a', speaker: 'ana', kind: 'floor', text: 'The payback lands inside month', cutOff: { atChar: 30, by: 'bo' } },
    { type: 'message', id: 'b', speaker: 'bo', kind: 'reaction', text: 'On what base?', overlap: { with: 'a', fromChar: 20 } },
    { type: 'aside', id: 'x', from: 'bo', to: 'ana', text: 'one two three four five six seven' },
  ];
  const m3 = computeMetrics(fromEvents('t2', 't2', ev2));
  ok('a reaction counts as an expert turn; an aside does not', m3.expertTurns === 2, String(m3.expertTurns));
  ok('a cut-off counts as an interruption', m3.interruptionRate === 50, String(m3.interruptionRate));
  ok('overlap is measured', m3.overlapRate === 50, String(m3.overlapRate));

  // The realism index and the guards, on the committed synthetic fixtures.
  const fx = (f: string) => {
    const raw = JSON.parse(fs.readFileSync(path.join(path.dirname(import.meta.filename ?? ''), 'fixtures', f), 'utf8'));
    return computeMetrics(fromEvents(f, f, raw.events));
  };
  const before = fx('realism-baseline.json');
  const after = fx('realism-target.json');
  ok('the index ranks the target-like fixture well above the baseline-like one', after.realismIndex > before.realismIndex + 20, `${before.realismIndex} -> ${after.realismIndex}`);
  ok('the index reports its parts', Object.keys(after.realismParts).length === REALISM_TARGETS.length);
  ok('guards are computed from the event log', !!before.guards && before.guards.motions === 1 && before.guards.meanTopRung === 3 && before.guards.dissents === 1, JSON.stringify(before.guards));
  ok('the target fixture drops no guard', guardFalls(before.guards!, after.guards!).length === 0, JSON.stringify([before.guards, after.guards]));
  ok('a guard that falls by more than 10% is caught', guardFalls(before.guards!, { ...before.guards!, meanTopRung: 2 }).join() === 'meanTopRung');

  // Phase 2b-3: the claims record and the lint records.
  ok('a log with no claims record has no unsupported-figures guard', before.guards!.unsupportedFigures === null && before.guards!.lintRewriteRate === null);
  const g = computeGuards([
    { type: 'message', speaker: 'ana', kind: 'floor', text: 'Sunday covers run 40.', claims: [{ text: 'Sunday covers run 40', grade: 'observed' }], lint: { score: 0, rewrote: false, rules: [] } },
    { type: 'message', speaker: 'bo', kind: 'floor', text: 'Payback is 3 months.', claims: [{ text: 'staff will agree', grade: 'assumed' }], lint: { score: 4, rewrote: true, rules: ['too_long'] } },
    { type: 'message', speaker: 'cy', kind: 'reply' as any, text: 'No.' },
    { type: 'message', speaker: 'marcus', kind: 'marcus', text: 'We have 2 minutes.' },
  ]);
  ok('a figure with no graded figure behind it is unsupported; the chair is not counted', g.unsupportedFigures === 1, JSON.stringify(g));
  ok('the rewrite rate is over linted turns', g.lintRewriteRate === 0.5, JSON.stringify(g));
  ok('a transcript.md has no guards', computeMetrics(fromMarkdown('md', md)).guards === null);

  // 2b-6 calibration: size-aware bands, discourse-marker openers, the broader concession list.
  const gt = REALISM_TARGETS.find((t) => t.key === 'giniTurns')!;
  const at = (experts: number) => bandOf(gt, { ...after, experts } as Metrics);
  ok('the Gini band widens with panel size', at(3).hi === 0.3 && at(5).lo === 0.1 && at(8).hi === 0.45, JSON.stringify([at(3), at(5), at(8)]));
  const pp = REALISM_TARGETS.find((t) => t.key === 'pingPongRate')!;
  ok('the A-B-A band falls with panel size', bandOf(pp, { ...after, experts: 3 } as Metrics).lo > bandOf(pp, { ...after, experts: 7 } as Metrics).lo);
  const yeah = [
    { type: 'panel', personas: [{ id: 'ana', name: 'Ana Ruiz' }, { id: 'bo', name: 'Bo Chen' }, { id: 'cy', name: 'Cy Okafor' }] },
    ...['ana', 'bo', 'cy', 'ana'].map((s, i) => ({ type: 'message', speaker: s, kind: 'floor', text: `Yeah I think the rota ${i} holds.` })),
    ...['bo', 'cy', 'ana'].map((s, i) => ({ type: 'message', speaker: s, kind: 'floor', text: `The real problem ${i} is staff.` })),
  ];
  const my = computeMetrics(fromEvents('y', 'y', yeah));
  ok('"yeah I think" is not a repeated opener; a real house opener still is', Math.abs(my.openerRepeatShare - 3 / 7) < 0.01 && my.topOpeners.length === 1 && my.topOpeners[0].opener === 'the real problem', JSON.stringify([my.openerRepeatShare, my.topOpeners]));
  const conc = computeMetrics(fromEvents('c', 'c', [
    { type: 'message', speaker: 'ana', kind: 'floor', text: 'Fair enough, the oven is idle on Sundays.' },
    { type: 'message', speaker: 'bo', kind: 'floor', text: 'True, but the staff are tired.' },
    { type: 'message', speaker: 'cy', kind: 'floor', text: 'That is not true at all.' },
  ]));
  ok('the broader list counts "fair enough" and "true, but", not "not true"', Math.abs(conc.concessionPer100 - 66.7) < 0.1, String(conc.concessionPer100));
  ok('concessions weigh half until calibrated', REALISM_TARGETS.find((t) => t.key === 'concessionPer100')!.weight === 0.5);
  console.log(fails ? `${fails} failed` : 'all self-tests passed');
  return fails;
}

// ---------- CLI ----------

async function main() {
  const args = process.argv.slice(2);
  const flag = (f: string) => args.includes(f);
  const vals = (f: string) => args.flatMap((a, i) => (a === f && args[i + 1] ? [args[i + 1]] : []));
  if (flag('--self-test')) process.exit(selfTest() ? 1 : 0);

  const minTurns = Number(vals('--min-turns')[0] ?? 20);
  let inputs: DebateInput[] = [];
  for (const f of vals('--events')) {
    const ev = JSON.parse(fs.readFileSync(f, 'utf8'));
    inputs.push(fromEvents(path.basename(f), path.basename(f), Array.isArray(ev) ? ev : ev.events ?? []));
  }
  for (const f of vals('--md')) inputs.push(fromMarkdown(path.basename(path.dirname(f)) || f, fs.readFileSync(f, 'utf8')));
  if (!inputs.length) {
    const db = vals('--db')[0] ?? path.resolve(process.cwd(), 'data/debate.db');
    if (!fs.existsSync(db)) {
      console.error(`No input. Pass --db, --events or --md (looked for ${db}).`);
      process.exit(2);
    }
    inputs = await fromDb(db, vals('--debate'));
  }

  const all = inputs.map(computeMetrics).filter((m) => m.expertTurns > 0);
  const pooledSet = all.filter((m) => m.expertTurns >= minTurns);
  const baseline = pool(pooledSet);
  if (flag('--json')) {
    console.log(JSON.stringify({ debates: all.map((m) => (flag('--titles') ? m : { ...m, title: undefined })), baseline, minTurns }, null, 2));
    return;
  }
  console.log(`## Per debate (${all.length} with expert turns)\n`);
  console.log(table(all, flag('--titles')));
  console.log(`\n## Pooled baseline (${pooledSet.length} debates with >= ${minTurns} expert turns, weighted by turns)\n`);
  console.log('| metric | value |\n|---|---|');
  for (const [k, v] of Object.entries(baseline)) console.log(`| ${k} | ${v} |`);
  console.log('\n## Most shared openers and 4-grams (per debate, normalised; NAME = any seated first name)\n');
  for (const m of all) {
    if (!m.topOpeners.length && !m.topRepeated4grams.length) continue;
    console.log(`- ${m.id}: openers ${m.topOpeners.map((o) => `"${o.opener}" x${o.n}`).join(', ') || '(none)'}; 4-grams ${m.topRepeated4grams.slice(0, 6).map((g) => `"${g.gram}" x${g.turns}`).join(', ') || '(none)'}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? '')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
