/**
 * Realism lint rules (docs/PHASE2-PLAN.md, 2e), step 1 of the lint pipeline:
 * the free, deterministic rules that score one spoken turn.
 *
 * Pure functions on a turn string. No model, no engine, no I/O. The engine
 * (2b-3) calls `lintTurn` after the trailer is stripped and before the turn is
 * performed; above `LINT_CONFIG.rewriteThreshold` it sends the turn to the
 * fast-tier rewrite and verifies the result. That rewrite and its verifier are
 * not here.
 *
 * `BANNED_PHRASES` is THE banned-phrase list. Prompt de-seeding (no prompt may
 * contain a phrase the room is not supposed to say) and the per-turn rule both
 * read it, through `bannedPhrasesIn`. Add a phrase here and both pick it up.
 */

// ---------- the one config list ----------

/**
 * Phrases the room must never say: the corpus tics that came from the
 * prompts' own wording (plan 1.2, item 3). Lowercase, matched on word
 * boundaries, case-insensitive, with any run of whitespace between words.
 * A speaker's own `neverSay` is added on top of this per call.
 */
export const BANNED_PHRASES: readonly string[] = [
  'closer to right',
  'the strongest version of your case',
  'at its strongest',
  'what everyone is missing',
  'own my bias',
  'against my own book',
  'say it out loud',
  'say it plainly',
  "i'll name the cost",
  'i will name the cost',
  'my falsifier',
  'load-bearing claim',
  'would change my mind',
  'rather than admired',
  'i am putting it to you in writing',
];

/** Weights, thresholds and budgets. One place, so tuning is a one-line change. */
export const LINT_CONFIG = {
  /** At or above this score the turn goes to the fast-tier rewrite. */
  rewriteThreshold: 3,
  /** Em-dashes (or spaced en-dashes used as dashes) allowed per turn. */
  emDashMaxPerTurn: 0,
  /** Antithesis constructions allowed per turn before it counts. */
  antithesisMaxPerTurn: 1,
  /** An opener (first three normalised words) seen in this many recent turns is shared. */
  openerWindow: 30,
  /** 4-grams the same speaker used in their last N turns count as recycled. */
  ngramWindow: 5,
  /** Recycled 4-grams needed before the rule fires. */
  ngramMinRepeats: 2,
  weights: {
    banned_phrase: 3,
    never_say: 3,
    spoken_label: 2,
    antithesis: 2,
    antithesis_budget: 1,
    filler_praise: 1,
    em_dash: 1,
    markdown: 2,
    summary_ending: 1,
    shared_opener: 1,
    recycled_ngram: 1,
    length_budget: 2,
    addresses_chair: 1,
    template_turn: 2,
    courtesy_concession: 2,
    tic_over_budget: 2,
    meta_speech: 1,
    melodrama: 2,
  },
} as const;

export type LintRuleId = keyof typeof LINT_CONFIG.weights;

// ---------- lexicons (patterns, not phrases to ban outright) ----------

/** Praise and agreement filler: costs the speaker nothing, tells the room nothing. */
export const FILLER_PATTERNS: readonly RegExp[] = [
  /\b(great|good|fair|excellent|interesting|valid|important) (point|question|catch)\b/i,
  /\bwell said\b/i, /\bspot on\b/i, /\babsolutely right\b/i, /\bexactly right\b/i,
  /\bi (completely|totally|fully|entirely) agree\b/i, /\bi hear you\b/i,
  /\bi appreciate (that|the|your)\b/i, /\bthank you for\b/i, /\bwith (all due )?respect\b/i,
  /\bthat'?s (a )?(really )?(fair|good|great) (point|question)\b/i, /\bbuilding on (what|that|your)\b/i,
];

/** "X is not A, it is B": the room's dominant construction. Global, so it can be counted. */
export const ANTITHESIS = /\b(?:is|was|are|isn't|'s)\s+not\s+(?:a |an |the )?[^.;:?!]{1,60}?[,;]\s+(?:it|that|this|they)(?:'s| is| are|'re| was)\b|\bisn'?t\s+(?:a |an |the )?[^.;:?!]{1,60}?[,;]\s+(?:it|that|this|they)(?:'s| is| are|'re| was)\b|\bnot\s+(?:a |an )[^.;:?!,]{1,40},\s+(?:a |an )[^.;:?!]{1,40}[.!]/gi;

/** Evidence labels spoken aloud. Grades travel in the CLAIMS trailer now (2e). */
export const SPOKEN_LABEL = /\((?:measured|observed|assumed|mixed|persona)\b[^)]*\)|\b(?:observed|measured|assumed),\s+from\b/gi;

/** Endings that wrap a turn up for the listener instead of leaving it open. */
export const SUMMARY_ENDING = /^(?:so[, ]|so the |which means|that is why|that's why|in short|bottom line|net[:,]|the point is|the answer is|to sum up|in sum|in summary|all of which)/i;

/** Speech about one's own speech. */
export const META_SPEECH = /\b(?:out loud|let me be (?:clear|blunt|direct)|i'?ll be (?:blunt|honest|direct)|i want to name|let me name|to put it plainly)\b/i;

/** Concession language. Without a recorded stance move it is a courtesy (2c). */
export const CONCESSION_LANGUAGE = /\b(?:you'?re right|you are right|i concede|i'?ll concede|i accept (?:that|the|your)|fair (?:enough|point)|i take (?:the|your) point|granted|i grant (?:you|that)|point taken)\b/i;

/** Melodrama (2d): stakes inflated past what the record states. */
export const MELODRAMA = /\b(?:destroy everything|end of the company|existential threat|catastroph(?:e|ic)|bet the (?:company|farm)|no coming back|game[- ]over|death (?:spiral|knell|sentence))\b/i;

/** Markdown and list formatting. Nobody speaks in bullet points. */
const MARKDOWN = /(?:^|\n)\s*(?:[-*•]\s|\d+[.)]\s|#{1,6}\s)|\*\*[^*]+\*\*|__[^_]+__|`[^`]+`/;

/** Em-dash, or an en-dash or double hyphen used as a dash between words. */
const DASH = /—|\s–\s|\s--\s/g;

/** A request handed to the chair at the end of a turn ("Marcus, get the desk to pull ..."). */
const CHAIR_REQUEST = /\b(?:get|pull|ask|have|put|send|can you|could you|i want you to|we need you to)\b/i;

// ---------- helpers ----------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A word-bounded, whitespace-tolerant, case-insensitive matcher for a phrase. */
export function phraseRegex(phrase: string): RegExp {
  const body = phrase.trim().split(/\s+/).map(escapeRe).join('\\s+').replace(/'/g, "['’]");
  const lead = /^\w/.test(phrase.trim()) ? '\\b' : '';
  const tail = /\w$/.test(phrase.trim()) ? '\\b' : '';
  return new RegExp(`${lead}${body}${tail}`, 'gi');
}

/** Every banned phrase (plus any extra list) found in a text, with its position. For prompt de-seeding too. */
export function bannedPhrasesIn(text: string, extra: readonly string[] = []): { phrase: string; index: number }[] {
  const out: { phrase: string; index: number }[] = [];
  const seen = new Set<string>();
  for (const p of [...BANNED_PHRASES, ...extra]) {
    const key = p.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    for (const m of text.matchAll(phraseRegex(p))) out.push({ phrase: p, index: m.index ?? 0 });
  }
  return out.sort((a, b) => a.index - b.index);
}

export const words = (t: string) => t.split(/\s+/).filter(Boolean);
export const wordCount = (t: string) => words(t).length;

/** Sentences, split on terminal punctuation. Good enough for lint; abbreviations are rare in speech. */
export function sentences(t: string): string[] {
  return t
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=["'“‘(]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const normTokens = (t: string) =>
  t.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);

/** First three normalised words, with any known name replaced by NAME. */
export function opener(t: string, names: readonly string[] = []): string {
  const lowerNames = new Set(names.map((n) => n.toLowerCase()));
  return normTokens(t).slice(0, 3).map((w) => (lowerNames.has(w) ? 'NAME' : w)).join(' ');
}

const STOP = new Set('the a an and or but of to in on at for is it that this with as be by we i you they he she was are'.split(' '));

/** 4-grams of a text, skipping grams made only of stopwords. */
export function fourGrams(t: string): Set<string> {
  const w = normTokens(t);
  const out = new Set<string>();
  for (let i = 0; i + 4 <= w.length; i++) {
    const g = w.slice(i, i + 4);
    if (g.every((x) => STOP.has(x))) continue;
    out.add(g.join(' '));
  }
  return out;
}

// ---------- the rules ----------

export interface LintHit {
  rule: LintRuleId;
  weight: number;
  detail: string;
  /** Character index into the turn, when the rule has one place. */
  at?: number;
}

export interface LintContext {
  /** The speaker's own neverSay list (dossier), on top of BANNED_PHRASES. */
  neverSay?: readonly string[];
  /** Word budget for the turn's shape, [min, max]. */
  wordBudget?: readonly [number, number];
  /** The chair's first name, to catch a reply to a colleague routed through the chair. */
  chairName?: string;
  /** Who the turn answers. If it answers a colleague and opens on the chair's name, it routes through the chair. */
  replyTo?: string;
  /** First names of everyone seated, for the opener rule and the template rule. */
  names?: readonly string[];
  /** Recent turns by anyone, oldest first (opener rule). */
  recentTurns?: readonly string[];
  /** This speaker's recent turns, oldest first (recycled 4-gram rule). */
  speakerRecentTurns?: readonly string[];
  /**
   * Did this turn's trailer record a real stance move? `false` turns concession
   * language into a courtesy concession. Leave undefined when the ledger is not
   * live, and the rule stays quiet.
   */
  stanceMoved?: boolean;
  /** The speaker's budgeted tics and how often each was already used this motion. */
  tics?: readonly { text: string; maxPerMotion: number; used: number }[];
  /** Antithesis constructions the room has already used this motion, and its budget. */
  roomAntithesis?: { used: number; budget: number };
}

export interface LintResult {
  score: number;
  hits: LintHit[];
  /** Rule ids that fired, de-duplicated, in first-hit order. */
  rules: LintRuleId[];
  words: number;
  /** Antithesis constructions in this turn, for the caller's per-motion budget. */
  antithesisCount: number;
  /** Tic texts used in this turn, for the caller's per-motion tic budget. */
  ticsUsed: string[];
}

const W = LINT_CONFIG.weights;

function hit(rule: LintRuleId, detail: string, at?: number): LintHit {
  return { rule, weight: W[rule], detail, ...(at === undefined ? {} : { at }) };
}

export function ruleBannedPhrases(text: string): LintHit[] {
  return bannedPhrasesIn(text).map((b) => hit('banned_phrase', b.phrase, b.index));
}

export function ruleNeverSay(text: string, neverSay: readonly string[] = []): LintHit[] {
  const extra = neverSay.filter((n) => !BANNED_PHRASES.includes(n.trim().toLowerCase()));
  return bannedPhrasesIn(text, extra)
    .filter((b) => extra.includes(b.phrase))
    .map((b) => hit('never_say', b.phrase, b.index));
}

export function ruleFiller(text: string): LintHit[] {
  for (const r of FILLER_PATTERNS) {
    const m = r.exec(text);
    if (m) return [hit('filler_praise', m[0], m.index)];
  }
  return [];
}

export function countAntithesis(text: string): number {
  return [...text.matchAll(ANTITHESIS)].length;
}

export function ruleAntithesis(text: string, room?: { used: number; budget: number }): LintHit[] {
  const n = countAntithesis(text);
  const out: LintHit[] = [];
  if (n > LINT_CONFIG.antithesisMaxPerTurn) out.push(hit('antithesis', `${n} in one turn`));
  if (room && n > 0 && room.used + n > room.budget) out.push(hit('antithesis_budget', `room at ${room.used + n} of ${room.budget} this motion`));
  return out;
}

export function ruleSpokenLabels(text: string): LintHit[] {
  const m = [...text.matchAll(SPOKEN_LABEL)];
  return m.length ? [hit('spoken_label', m.map((x) => x[0]).join(' | '), m[0].index)] : [];
}

export function ruleEmDash(text: string): LintHit[] {
  const n = [...text.matchAll(DASH)].length;
  return n > LINT_CONFIG.emDashMaxPerTurn ? [hit('em_dash', `${n} dash${n === 1 ? '' : 'es'}`)] : [];
}

export function ruleMarkdown(text: string): LintHit[] {
  const m = MARKDOWN.exec(text);
  return m ? [hit('markdown', m[0].trim(), m.index)] : [];
}

/** The last sentence of a turn of three or more sentences starts with a wrap-up phrase. */
export function ruleSummaryEnding(text: string): LintHit[] {
  const ss = sentences(text);
  if (ss.length < 3) return [];
  const last = ss[ss.length - 1];
  return SUMMARY_ENDING.test(last) ? [hit('summary_ending', last.slice(0, 60))] : [];
}

export function ruleMetaSpeech(text: string): LintHit[] {
  const m = META_SPEECH.exec(text);
  return m ? [hit('meta_speech', m[0], m.index)] : [];
}

export function ruleMelodrama(text: string): LintHit[] {
  const m = MELODRAMA.exec(text);
  return m ? [hit('melodrama', m[0], m.index)] : [];
}

export function ruleLength(text: string, budget?: readonly [number, number]): LintHit[] {
  if (!budget) return [];
  const n = wordCount(text);
  const [lo, hi] = budget;
  return n < lo || n > hi ? [hit('length_budget', `${n} words, budget ${lo}-${hi}`)] : [];
}

export function ruleSharedOpener(text: string, recent: readonly string[] = [], names: readonly string[] = []): LintHit[] {
  const mine = opener(text, names);
  if (mine.split(' ').length < 3) return [];
  const window = recent.slice(-LINT_CONFIG.openerWindow);
  const n = window.filter((t) => opener(t, names) === mine).length;
  return n > 0 ? [hit('shared_opener', `"${mine}" opened ${n} of the last ${window.length} turns`)] : [];
}

export function ruleRecycledNgrams(text: string, speakerRecent: readonly string[] = []): LintHit[] {
  const mine = fourGrams(text);
  const before = new Set<string>();
  for (const t of speakerRecent.slice(-LINT_CONFIG.ngramWindow)) for (const g of fourGrams(t)) before.add(g);
  const shared = [...mine].filter((g) => before.has(g));
  return shared.length >= LINT_CONFIG.ngramMinRepeats ? [hit('recycled_ngram', shared.slice(0, 3).join(' | '))] : [];
}

/** A reply to a colleague that opens on the chair's name: the room routing through the chair. */
export function ruleAddressesChair(text: string, chairName?: string, replyTo?: string): LintHit[] {
  if (!chairName || !replyTo || replyTo.toLowerCase() === chairName.toLowerCase()) return [];
  const re = new RegExp(`^\\W*${escapeRe(chairName)}\\b`, 'i');
  return re.test(text.trim()) ? [hit('addresses_chair', `opens on ${chairName} while answering ${replyTo}`)] : [];
}

/**
 * The house template: name + concession up front, then the attack, a spoken
 * label, and a request handed to the chair at the end. Three of the four parts
 * are enough to call it.
 */
export function ruleTemplate(text: string, names: readonly string[] = [], chairName?: string): LintHit[] {
  const ss = sentences(text);
  if (ss.length < 3) return [];
  const first = ss[0];
  const last = ss[ss.length - 1];
  const namesRe = names.length ? new RegExp(`\\b(?:${names.map(escapeRe).join('|')})\\b`, 'i') : null;
  const parts = {
    nameConcession: !!namesRe?.test(first) && (CONCESSION_LANGUAGE.test(first) || /\b(?:is right|has a point|is closer)\b/i.test(first)),
    attack: ss.slice(1, -1).some((s) => /\b(?:but|except|however|yet|the problem|breaks|fails|wrong|not|isn't)\b/i.test(s)),
    label: new RegExp(SPOKEN_LABEL.source, 'i').test(text),
    chairRequest: !!chairName && new RegExp(`\\b${escapeRe(chairName)}\\b`, 'i').test(last) && CHAIR_REQUEST.test(last),
  };
  const n = Object.values(parts).filter(Boolean).length;
  return n >= 3 && (parts.nameConcession || parts.chairRequest)
    ? [hit('template_turn', Object.entries(parts).filter(([, v]) => v).map(([k]) => k).join('+'))]
    : [];
}

/** Concession language with no stance move behind it (the trailer says nothing moved). */
export function ruleCourtesyConcession(text: string, stanceMoved?: boolean): LintHit[] {
  if (stanceMoved !== false) return [];
  const m = CONCESSION_LANGUAGE.exec(text);
  return m ? [hit('courtesy_concession', m[0], m.index)] : [];
}

/** Which of the speaker's tics this turn uses, and which go over the per-motion budget. */
export function ruleTics(text: string, tics: readonly { text: string; maxPerMotion: number; used: number }[] = []): { hits: LintHit[]; used: string[] } {
  const used: string[] = [];
  const hits: LintHit[] = [];
  for (const t of tics) {
    if (!t.text.trim()) continue;
    const n = [...text.matchAll(phraseRegex(t.text))].length;
    if (!n) continue;
    used.push(t.text);
    if (t.used + n > t.maxPerMotion) hits.push(hit('tic_over_budget', `"${t.text}" ${t.used + n}/${t.maxPerMotion}`));
  }
  return { hits, used };
}

/** Run every rule on one turn. Pure: same text and context, same result. */
export function lintTurn(text: string, ctx: LintContext = {}): LintResult {
  const ticCheck = ruleTics(text, ctx.tics);
  const hits: LintHit[] = [
    ...ruleBannedPhrases(text),
    ...ruleNeverSay(text, ctx.neverSay),
    ...ruleSpokenLabels(text),
    ...ruleAntithesis(text, ctx.roomAntithesis),
    ...ruleFiller(text),
    ...ruleEmDash(text),
    ...ruleMarkdown(text),
    ...ruleSummaryEnding(text),
    ...ruleSharedOpener(text, ctx.recentTurns, ctx.names),
    ...ruleRecycledNgrams(text, ctx.speakerRecentTurns),
    ...ruleLength(text, ctx.wordBudget),
    ...ruleAddressesChair(text, ctx.chairName, ctx.replyTo),
    ...ruleTemplate(text, ctx.names, ctx.chairName),
    ...ruleCourtesyConcession(text, ctx.stanceMoved),
    ...ticCheck.hits,
    ...ruleMetaSpeech(text),
    ...ruleMelodrama(text),
  ];
  const rules: LintRuleId[] = [];
  for (const h of hits) if (!rules.includes(h.rule)) rules.push(h.rule);
  return {
    score: hits.reduce((a, h) => a + h.weight, 0),
    hits,
    rules,
    words: wordCount(text),
    antithesisCount: countAntithesis(text),
    ticsUsed: ticCheck.used,
  };
}

export const shouldRewrite = (r: LintResult) => r.score >= LINT_CONFIG.rewriteThreshold;

/** The `message.lint` record (shared/realism.ts `LintRecord`). */
export function toLintRecord(r: LintResult, rewrote: boolean): { score: number; rewrote: boolean; rules: string[] } {
  return { score: r.score, rewrote, rules: [...r.rules] };
}
