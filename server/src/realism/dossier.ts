/**
 * Persona dossiers (docs/PHASE2-PLAN.md, 2a): validation of a generated
 * dossier, the deterministic panel DIVERSITY CHECK, the private voice card,
 * and the public-reputation roster.
 *
 * Pure: no model, no engine, no I/O. The `persona` and `relationships` calls
 * (2b-5) produce raw JSON; `parseDossier` turns it into a `Dossier` or says
 * why not; `checkDiversity` decides whether the panel is varied enough and,
 * when it is not, which experts to regenerate and with what hint.
 *
 * Privacy split: `rosterText` reads ONLY `publicReputation` (it goes in the
 * shared, cached prefix); `voiceCard` reads the private parts and goes ONLY in
 * that expert's own suffix.
 */
import type { Belief, Dossier, Register } from '../../../shared/types.ts';
import { BANNED_PHRASES, bannedPhrasesIn } from './lint-rules.ts';

export const REGISTERS: readonly Register[] = ['clipped', 'plain', 'technical', 'storyteller', 'socratic', 'combative', 'dry'];

/** Bounds a dossier must meet, and the panel-level diversity thresholds (plan 2a, item 2). */
export const DOSSIER_RULES = {
  failures: [2, 2] as const,
  wins: [1, 2] as const,
  incentives: [2, 5] as const,
  biases: [1, 4] as const,
  blindSpots: [1, 4] as const,
  vocabulary: [5, 8] as const,
  tics: [1, 2] as const,
  typicalWords: [40, 160] as const,
  ticMaxPerMotion: [1, 3] as const,
  publicReputationMaxWords: 45,
  diversity: {
    /** Distinct registers / panel size. */
    minRegisterShare: 0.7,
    /** max typicalWords / min typicalWords. */
    minLengthRatio: 3,
    /** Pairwise vocabulary Jaccard. */
    maxVocabJaccard: 0.2,
    /** Someone must be easy to move, and someone hard. */
    lowStubbornness: 0.35,
    highStubbornness: 0.7,
    /** Pairs whose incentives point opposite ways on the goal (capped at n-1 for tiny panels). */
    minOpposedPairs: 2,
    /** Pairwise token Jaccard over bias names + showsUpAs. */
    maxBiasJaccard: 0.35,
    /** Pairwise token Jaccard over incentives. */
    maxIncentiveJaccard: 0.35,
    /** Pairwise token Jaccard over underPressure. */
    maxPressureJaccard: 0.5,
  },
} as const;

// ---------- validation ----------

export type ParseResult = { ok: true; dossier: Dossier; warnings: string[] } | { ok: false; errors: string[] };

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
/** Longest any single model-written string may be. Model output is untrusted; some of it reaches the shared prefix. */
export const MAX_FIELD_CHARS = 400;
const str = (x: unknown) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_CHARS) : '');
const strList = (x: unknown) => (Array.isArray(x) ? x.map(str).filter(Boolean) : []);
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : NaN);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const dedupe = (xs: string[]) => {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.toLowerCase()) ? false : (seen.add(x.toLowerCase()), true)));
};

/**
 * Turn a model's dossier JSON into a `Dossier`. Hard errors (missing voice,
 * wrong history shape, unknown register) fail it, so the caller regenerates.
 * Soft problems (a number out of range, an over-long list, a relationship to
 * someone not on the panel) are clamped, trimmed or dropped, with a warning.
 */
export function parseDossier(raw: unknown, ctx: { personaId: string; panelIds?: readonly string[] }): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ['not an object'] };
  const R = DOSSIER_RULES;

  let publicReputation = str(raw.publicReputation);
  if (!publicReputation) errors.push('publicReputation missing');
  else if (publicReputation.split(' ').length > R.publicReputationMaxWords) {
    warnings.push('publicReputation trimmed');
    publicReputation = publicReputation.split(' ').slice(0, R.publicReputationMaxWords).join(' ');
  }

  type HistoryItem = Dossier['history'][number];
  const history = (Array.isArray(raw.history) ? raw.history : []).flatMap((h): HistoryItem[] => {
    if (!isObj(h)) return [];
    const kind: HistoryItem['kind'] | null = h.kind === 'failure' || h.kind === 'win' ? h.kind : null;
    const item = { when: str(h.when), what: str(h.what), lesson: str(h.lesson) };
    return kind && item.what && item.lesson ? [{ ...item, kind }] : [];
  });
  const failures = history.filter((h) => h.kind === 'failure').length;
  const wins = history.filter((h) => h.kind === 'win').length;
  if (failures < R.failures[0]) errors.push(`history needs ${R.failures[0]} failures, has ${failures}`);
  if (wins < R.wins[0]) errors.push(`history needs at least ${R.wins[0]} win`);
  const trimmedHistory = [
    ...history.filter((h) => h.kind === 'failure').slice(0, R.failures[1]),
    ...history.filter((h) => h.kind === 'win').slice(0, R.wins[1]),
  ];
  if (trimmedHistory.length < history.length) warnings.push('history trimmed');

  const listField = (name: string, x: unknown, [lo, hi]: readonly [number, number]) => {
    const l = dedupe(strList(x));
    if (l.length < lo) errors.push(`${name} needs at least ${lo}, has ${l.length}`);
    if (l.length > hi) warnings.push(`${name} trimmed to ${hi}`);
    return l.slice(0, hi);
  };
  const incentives = listField('incentives', raw.incentives, R.incentives);
  const blindSpots = listField('blindSpots', raw.blindSpots, R.blindSpots);

  const biases = (Array.isArray(raw.biases) ? raw.biases : [])
    .flatMap((b) => (isObj(b) && str(b.name) ? [{ name: str(b.name), showsUpAs: str(b.showsUpAs) }] : []))
    .slice(0, R.biases[1]);
  if (biases.length < R.biases[0]) errors.push('biases missing');

  let stubbornness = num(raw.stubbornness);
  if (Number.isNaN(stubbornness)) {
    errors.push('stubbornness missing');
    stubbornness = 0.5;
  } else if (stubbornness < 0 || stubbornness > 1) {
    warnings.push('stubbornness clamped');
    stubbornness = clamp(stubbornness, 0, 1);
  }

  const t = isObj(raw.temperament) ? raw.temperament : {};
  const tnum = (k: string, d: number) => {
    const v = num(t[k]);
    if (Number.isNaN(v)) {
      warnings.push(`temperament.${k} defaulted`);
      return d;
    }
    return clamp(v, 0, 1);
  };
  const temperament = {
    heatGain: tnum('heatGain', 0.25),
    heatDecay: tnum('heatDecay', 0.12),
    interruptThreshold: tnum('interruptThreshold', 0.75),
    dominance: tnum('dominance', 0.5),
  };

  const s = isObj(raw.speech) ? raw.speech : {};
  const register = REGISTERS.includes(s.register as Register) ? (s.register as Register) : null;
  if (!register) errors.push(`speech.register must be one of ${REGISTERS.join(', ')}`);
  let typicalWords = num(s.typicalWords);
  if (Number.isNaN(typicalWords)) {
    errors.push('speech.typicalWords missing');
    typicalWords = 90;
  } else if (typicalWords < R.typicalWords[0] || typicalWords > R.typicalWords[1]) {
    warnings.push('speech.typicalWords clamped');
    typicalWords = clamp(Math.round(typicalWords), R.typicalWords[0], R.typicalWords[1]);
  }
  const vocabulary = listField('speech.vocabulary', s.vocabulary, R.vocabulary).map((v) => v.toLowerCase());
  const tics = (Array.isArray(s.tics) ? s.tics : [])
    .flatMap((x) => {
      if (typeof x === 'string' && str(x)) return [{ text: str(x), maxPerMotion: 1 }];
      if (isObj(x) && str(x.text)) {
        const m = num(x.maxPerMotion);
        return [{ text: str(x.text), maxPerMotion: Number.isNaN(m) ? 1 : clamp(Math.round(m), R.ticMaxPerMotion[0], R.ticMaxPerMotion[1]) }];
      }
      return [];
    })
    .slice(0, R.tics[1]);
  if (tics.length < R.tics[0]) errors.push('speech.tics missing');
  // A tic that is itself a banned phrase would teach the room the dialect we are removing.
  for (const tic of tics) if (bannedPhrasesIn(tic.text).length) errors.push(`tic "${tic.text}" is a banned phrase`);
  const neverSay = dedupe(strList(s.neverSay));

  const underPressure = str(raw.underPressure);
  if (!underPressure) errors.push('underPressure missing');

  const panel = new Set(ctx.panelIds ?? []);
  const relationships = (Array.isArray(raw.relationships) ? raw.relationships : []).flatMap((r) => {
    if (!isObj(r)) return [];
    const kind = ['ally', 'rival', 'history', 'respect'].includes(r.kind as string) ? (r.kind as 'ally' | 'rival' | 'history' | 'respect') : null;
    const w = str(r.with);
    if (!kind || !w || w === ctx.personaId || (ctx.panelIds && !panel.has(w))) {
      warnings.push(`relationship dropped (${w || 'no target'})`);
      return [];
    }
    return [{ with: w, kind, note: str(r.note) }];
  });

  if (errors.length) return { ok: false, errors };
  const priorPublicStance = str(raw.priorPublicStance);
  const lean = num(raw.goalLean);
  const goalLean = lean === -1 || lean === 0 || lean === 1 ? (lean as -1 | 0 | 1) : undefined;
  return {
    ok: true,
    warnings,
    dossier: {
      personaId: ctx.personaId,
      publicReputation,
      history: trimmedHistory,
      incentives,
      ...(priorPublicStance ? { priorPublicStance } : {}),
      biases,
      blindSpots,
      stubbornness,
      temperament,
      speech: { register: register!, typicalWords, vocabulary, tics, neverSay },
      underPressure,
      relationships,
      ...(goalLean !== undefined ? { goalLean } : {}),
    },
  };
}

/** The speaker's own neverSay plus the global banned list: what the linter checks against. */
export function effectiveNeverSay(d: Dossier): string[] {
  return dedupe([...BANNED_PHRASES, ...d.speech.neverSay]);
}

// ---------- the diversity check ----------

/**
 * One expert as the diversity check sees them. `goalLean` is which way their
 * personal incentives point on the session goal (-1 against, 0 neutral, +1 for).
 * It is not in `Dossier` yet: the persona call should emit it next to
 * `incentives` (see docs/LOGIC-REPORT.md); until then the caller passes it.
 */
export interface PanelEntry {
  id: string;
  dossier: Dossier;
  goalLean?: -1 | 0 | 1;
}

export type DiversityRule =
  | 'registers'
  | 'length_spread'
  | 'vocabulary_overlap'
  | 'stubbornness_low'
  | 'stubbornness_high'
  | 'opposed_incentives'
  | 'bias_overlap'
  | 'incentive_overlap'
  | 'pressure_overlap'
  | 'shared_tic';

export interface DiversityFailure {
  rule: DiversityRule;
  detail: string;
  /** Experts involved (pairs for pairwise rules). */
  who: string[];
}

export interface DiversityReport {
  ok: boolean;
  failures: DiversityFailure[];
  /** Who to regenerate (once), in panel order. */
  regenerate: string[];
  /** Per-expert hints for the regeneration prompt, behaviour-level, no scripted wording. */
  hints: Record<string, string[]>;
  /** Measured values, for logging and tests. */
  measures: {
    registerShare: number;
    lengthRatio: number;
    maxVocabJaccard: number;
    minStubbornness: number;
    maxStubbornness: number;
    opposedPairs: number;
    maxBiasJaccard: number;
    maxIncentiveJaccard: number;
  };
}

const STOP = new Set(
  'the a an and or but of to in on at for is it that this with as be by we i you they he she was are my his her their them from if when what who not no so than then too very can will would could should more most less only just own over under about into out up down off any all some'.split(' '),
);

/** Content tokens, lightly stemmed (plural s, -ing, -ed), stopwords dropped. */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (let w of text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)) {
    if (!w || STOP.has(w) || w.length < 3) continue;
    w = w.replace(/(ing|ed|es|s)$/, '');
    if (w.length >= 3) out.add(w);
  }
  return out;
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const biasText = (d: Dossier) => d.biases.map((b) => `${b.name} ${b.showsUpAs}`).join(' ');

/**
 * Is this panel varied enough to argue like different people? Deterministic:
 * the same panel always gives the same report. A failing panel names who to
 * regenerate (the later member of each offending pair, so the first-designed
 * expert keeps their shape) and what to change.
 */
export function checkDiversity(panel: readonly PanelEntry[]): DiversityReport {
  const D = DOSSIER_RULES.diversity;
  const failures: DiversityFailure[] = [];
  const hints: Record<string, string[]> = {};
  const regen = new Set<string>();
  const flag = (id: string, hint: string) => {
    regen.add(id);
    (hints[id] ??= []).includes(hint) || hints[id].push(hint);
  };
  const n = panel.length;
  const empty: DiversityReport['measures'] = {
    registerShare: 1, lengthRatio: Infinity, maxVocabJaccard: 0, minStubbornness: 0, maxStubbornness: 0,
    opposedPairs: 0, maxBiasJaccard: 0, maxIncentiveJaccard: 0,
  };
  if (n < 2) return { ok: true, failures, regenerate: [], hints, measures: empty };

  // Registers: distinct across at least 70% of the panel.
  const byRegister = new Map<Register, string[]>();
  for (const e of panel) byRegister.set(e.dossier.speech.register, [...(byRegister.get(e.dossier.speech.register) ?? []), e.id]);
  const registerShare = byRegister.size / n;
  if (registerShare < D.minRegisterShare) {
    const used = new Set(byRegister.keys());
    const free = REGISTERS.filter((r) => !used.has(r));
    const dupes = [...byRegister.values()].flatMap((ids) => ids.slice(1));
    failures.push({ rule: 'registers', detail: `${byRegister.size} registers for ${n} experts`, who: dupes });
    // Regenerate just enough duplicates to reach the share.
    const need = Math.ceil(D.minRegisterShare * n) - byRegister.size;
    dupes.slice(-need).forEach((id, i) => flag(id, `use a different speaking register (free: ${free.slice(i).join(', ') || 'any other'})`));
  }

  // Length spread: someone talks long, someone short.
  const tw = panel.map((e) => e.dossier.speech.typicalWords);
  const lengthRatio = Math.max(...tw) / Math.max(1, Math.min(...tw));
  if (lengthRatio < D.minLengthRatio) {
    const sorted = [...panel].sort((a, b) => a.dossier.speech.typicalWords - b.dossier.speech.typicalWords || panel.indexOf(a) - panel.indexOf(b));
    const target = sorted[0].dossier.speech.typicalWords <= 60 ? sorted[sorted.length - 1] : sorted[0];
    failures.push({ rule: 'length_spread', detail: `typical length ratio ${lengthRatio.toFixed(2)} < ${D.minLengthRatio}`, who: [target.id] });
    flag(target.id, target === sorted[0] ? 'speak much shorter: typicalWords about 40-50' : 'speak at length: typicalWords about 140-160');
  }

  // Pairwise overlaps.
  let maxVocab = 0, maxBias = 0, maxInc = 0;
  const vocab = panel.map((e) => new Set(e.dossier.speech.vocabulary.map((v) => v.toLowerCase())));
  const bias = panel.map((e) => contentTokens(biasText(e.dossier)));
  const inc = panel.map((e) => contentTokens(e.dossier.incentives.join(' ')));
  const press = panel.map((e) => contentTokens(e.dossier.underPressure));
  const tics = panel.map((e) => new Set(e.dossier.speech.tics.map((t) => t.text.toLowerCase().trim())));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = panel[i].id, b = panel[j].id;
      const v = jaccard(vocab[i], vocab[j]);
      maxVocab = Math.max(maxVocab, v);
      if (v > D.maxVocabJaccard) {
        failures.push({ rule: 'vocabulary_overlap', detail: `${a}/${b} vocabulary Jaccard ${v.toFixed(2)}`, who: [a, b] });
        flag(b, `use vocabulary from your own trade; avoid ${[...vocab[j]].filter((w) => vocab[i].has(w)).join(', ')}`);
      }
      const bj = jaccard(bias[i], bias[j]);
      maxBias = Math.max(maxBias, bj);
      if (bj > D.maxBiasJaccard) {
        failures.push({ rule: 'bias_overlap', detail: `${a}/${b} biases Jaccard ${bj.toFixed(2)}`, who: [a, b] });
        flag(b, `give biases that come from a different career than ${a}'s`);
      }
      const ij = jaccard(inc[i], inc[j]);
      maxInc = Math.max(maxInc, ij);
      if (ij > D.maxIncentiveJaccard) {
        failures.push({ rule: 'incentive_overlap', detail: `${a}/${b} incentives Jaccard ${ij.toFixed(2)}`, who: [a, b] });
        flag(b, `give personal stakes that differ from ${a}'s: something different to win or lose`);
      }
      const pj = jaccard(press[i], press[j]);
      if (pj > D.maxPressureJaccard) {
        failures.push({ rule: 'pressure_overlap', detail: `${a}/${b} behave the same under pressure`, who: [a, b] });
        flag(b, `react to pressure differently from ${a}`);
      }
      const shared = [...tics[i]].filter((t) => tics[j].has(t));
      if (shared.length) {
        failures.push({ rule: 'shared_tic', detail: `${a}/${b} share a tic`, who: [a, b] });
        flag(b, 'pick a verbal habit nobody else on the panel has');
      }
    }
  }

  // Stubbornness extremes.
  const st = panel.map((e) => e.dossier.stubbornness);
  const minS = Math.min(...st), maxS = Math.max(...st);
  const byS = [...panel].sort((a, b) => a.dossier.stubbornness - b.dossier.stubbornness || panel.indexOf(a) - panel.indexOf(b));
  if (minS > D.lowStubbornness) {
    const who = byS[0];
    failures.push({ rule: 'stubbornness_low', detail: `nobody at or below ${D.lowStubbornness} (lowest ${minS})`, who: [who.id] });
    flag(who.id, `be easy to move: stubbornness about 0.2-0.3`);
  }
  if (maxS < D.highStubbornness) {
    // Never pick the same person for both ends.
    const who = byS[byS.length - 1].id === byS[0].id && n > 1 ? byS[byS.length - 2] : byS[byS.length - 1];
    failures.push({ rule: 'stubbornness_high', detail: `nobody at or above ${D.highStubbornness} (highest ${maxS})`, who: [who.id] });
    flag(who.id, `be hard to move: stubbornness about 0.75-0.85`);
  }

  // Opposed incentives on the goal.
  const leaned = panel.filter((e) => e.goalLean !== undefined);
  let opposed = 0;
  for (let i = 0; i < leaned.length; i++)
    for (let j = i + 1; j < leaned.length; j++) if (leaned[i].goalLean! * leaned[j].goalLean! < 0) opposed++;
  const needOpposed = Math.min(D.minOpposedPairs, n - 1);
  if (opposed < needOpposed) {
    const fors = panel.filter((e) => e.goalLean === 1).length;
    const against = panel.filter((e) => e.goalLean === -1).length;
    const want: 1 | -1 = fors <= against ? 1 : -1;
    // Regenerate a neutral (or unknown) expert first, else the last member of the majority side.
    const cand = [...panel].reverse().find((e) => !e.goalLean) ?? [...panel].reverse().find((e) => e.goalLean === -want)!;
    failures.push({ rule: 'opposed_incentives', detail: `${opposed} opposed pair(s), need ${needOpposed}`, who: [cand.id] });
    flag(cand.id, want === 1 ? 'give personal incentives that gain if the goal goes ahead' : 'give personal incentives that lose if the goal goes ahead');
  }

  const regenerate = panel.map((e) => e.id).filter((id) => regen.has(id));
  return {
    ok: failures.length === 0,
    failures,
    regenerate,
    hints,
    measures: {
      registerShare, lengthRatio, maxVocabJaccard: maxVocab, minStubbornness: minS, maxStubbornness: maxS,
      opposedPairs: opposed, maxBiasJaccard: maxBias, maxIncentiveJaccard: maxInc,
    },
  };
}

// ---------- voice card (private, per-turn suffix) ----------

export interface VoiceCardContext {
  /** The motion under debate; picks the two incentives most relevant to it. */
  motion?: string;
  /** How often each tic has been used this motion (FloorState.ticUse[expert]). */
  ticUse?: Record<string, number>;
  /** The expert's own current belief (never anyone else's). */
  belief?: Belief;
  /** Stance labels, so the card reads in words. */
  stanceWords?: Record<number, string>;
}

/** Roughly 250 tokens. The card is cut to this many characters, least important lines first. */
export const VOICE_CARD_MAX_CHARS = 1100;

const DEFAULT_STANCE_WORDS: Record<number, string> = {
  [-2]: 'firmly against', [-1]: 'leaning against', 0: 'undecided', 1: 'leaning for', 2: 'firmly for',
};

/** Incentives ranked by content overlap with the motion; ties keep dossier order. */
export function relevantIncentives(d: Dossier, motion = '', k = 2): string[] {
  const m = contentTokens(motion);
  return d.incentives
    .map((text, i) => {
      const t = contentTokens(text);
      let s = 0;
      for (const x of t) if (m.has(x)) s++;
      return { text, i, s };
    })
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, k)
    .map((x) => x.text);
}

/** What the trait means in the room, in behaviour terms (2c). */
export function stubbornnessLine(s: number): string {
  if (s >= 0.7) return 'You move on your main position only for a computed number, new evidence, or the one observation you said would flip you. Pressure and charm do not count.';
  if (s >= 0.4) return 'You move when an argument or evidence actually answers your reason, not because the room leans the other way.';
  return 'You change your mind readily when someone gives you a good reason, and you say what the reason was.';
}

/** "Goes quiet then comes back hard" -> "go quiet then come back hard." (second person, ends on a full stop). */
export function pressureClause(s: string): string {
  let c = s.trim().replace(/^you\s+/i, '');
  c = c.charAt(0).toLowerCase() + c.slice(1);
  // Third-person verbs to second person for the common shapes: "gets", "goes", "talks", "reaches".
  c = c.replace(/\b(get|go|talk|reach|ask|cite|stay|turn|dig|become|come|look|lean)(e?s)\b/g, '$1');
  return /[.!?]$/.test(c) ? c : `${c}.`;
}

/**
 * The compact private card for one expert's turn suffix. It describes how the
 * person talks; it never contains the global banned list (that would seed the
 * phrases into the prompt), only the speaker's own neverSay minus anything
 * already banned globally, which the linter enforces anyway.
 */
export function voiceCard(d: Dossier, ctx: VoiceCardContext = {}): string {
  const words = ctx.stanceWords ?? DEFAULT_STANCE_WORDS;
  const use = ctx.ticUse ?? {};
  const tics = d.speech.tics.map((t) => {
    const left = t.maxPerMotion - (use[t.text] ?? 0);
    return left > 0 ? `"${t.text}" (at most ${left} more this motion)` : `"${t.text}" (spent this motion; do not use it)`;
  });
  const own = d.speech.neverSay.filter((p) => !bannedPhrasesIn(p).length);
  const lines: { text: string; priority: number }[] = [
    { priority: 0, text: `VOICE: ${d.speech.register} register, natural length about ${d.speech.typicalWords} words when you hold the floor.` },
    { priority: 0, text: `Words you actually use: ${d.speech.vocabulary.join(', ')}.` },
    { priority: 1, text: `Habit: ${tics.join('; ')}.` },
    { priority: 1, text: `Under pressure you ${pressureClause(d.underPressure)}` },
    { priority: 0, text: `What you personally stand to gain or lose here: ${relevantIncentives(d, ctx.motion).join('; ')}.` },
    { priority: 1, text: stubbornnessLine(d.stubbornness) },
  ];
  if (ctx.belief) {
    const b = ctx.belief;
    lines.push({ priority: 0, text: `Where you stand now: ${words[b.stance] ?? String(b.stance)} (${b.confidence} confidence). Your crux: ${b.crux}.` });
  }
  if (own.length) lines.push({ priority: 2, text: `You would never say: ${own.map((p) => `"${p}"`).join(', ')}.` });
  if (d.priorPublicStance) lines.push({ priority: 2, text: `On record in public: ${d.priorPublicStance}` });

  const ordered = lines.map((l, i) => ({ ...l, i }));
  const fit = (ls: typeof ordered) => ls.sort((a, b) => a.i - b.i).map((l) => l.text).join('\n');
  // Drop the least important lines (highest priority number, latest first) until it fits.
  let kept = [...ordered];
  while (fit(kept).length > VOICE_CARD_MAX_CHARS && kept.some((l) => l.priority > 0)) {
    const worst = [...kept].sort((a, b) => b.priority - a.priority || b.i - a.i)[0];
    kept = kept.filter((l) => l !== worst);
  }
  const text = fit(kept);
  return text.length > VOICE_CARD_MAX_CHARS ? `${text.slice(0, VOICE_CARD_MAX_CHARS - 1)}…` : text;
}

// ---------- public roster (shared, cached prefix) ----------

export interface RosterMember {
  id: string;
  name: string;
  role: string;
  /** Absent for old debates: the line falls back to name and role. */
  dossier?: Pick<Dossier, 'publicReputation'>;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The public roster block for the shared prefix. Reads only name, role and
 * publicReputation, in panel order, so it is byte-identical for every seat and
 * stays constant all session (cache-safe). Never pass private fields in.
 */
export function rosterText(members: readonly RosterMember[]): string {
  if (!members.length) return '';
  const lines = members.map((m) => {
    const rep = m.dossier?.publicReputation ? ` ${oneLine(m.dossier.publicReputation)}` : '';
    return `- ${oneLine(m.name)} (${oneLine(m.role)}).${rep}`;
  });
  return `WHO IS IN THE ROOM (what everyone knows about each other):\n${lines.join('\n')}`;
}
