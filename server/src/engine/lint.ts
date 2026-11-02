/**
 * Realism linting (docs/PHASE2-PLAN.md 2e).
 *
 * Every expert turn is scored against free, deterministic rules after its
 * trailer comes off and before anyone hears it. Below the threshold it ships
 * as written. At or above it, a fast-tier model rewrites the FORM, and the
 * rewrite is only accepted if a deterministic verifier shows nothing of
 * substance moved: the same numbers, the same names, the same citation
 * markers, inside the word budget, and a lower score. Otherwise one retry,
 * then the original ships with its lint record.
 *
 * This replaces the old flagship "too long, say it again under 100 words"
 * re-run, which fired on up to 40% of floor turns at flagship price.
 *
 * Never applied to the founder's words, research, the quant desk or rulings:
 * only experts' floor turns, interjections and closings come through here.
 *
 * Pure apart from the injected rewriter; tested in lint.selftest.ts.
 */
import {
  SPEECH_BANNED, FILLER, CONCESSION, POSITION_CHANGE, SUMMARY_ENDING, ANTITHESIS_ALL, MELODRAMA, TICS,
} from '../../../shared/lexicon.ts';
import type { LintRecord, TurnShape } from '../../../shared/types.ts';
import { splitTrailer } from './trailer.ts';
import { ruleBannedPhrases, ruleMetaSpeech, ruleNeverSay, ruleTemplate, ruleTics } from '../realism/lint-rules.ts';
import { anecdotes } from '../realism/evidence.ts';

/** At or above this score a turn is rewritten. */
export const LINT_THRESHOLD = 3;

/** The antithesis construction across the whole room, per motion, before it costs a point. */
export const ANTITHESIS_PER_MOTION = 3;

export type LintShape = TurnShape | 'interjection' | 'closing';

/**
 * Word budgets by shape. The set piece's ceiling is the persona's own
 * `typicalWords` once dossiers exist (2b-5); until then it is one number for
 * everyone, set well under the old 160-word median memo.
 */
export const WORD_BUDGET: Record<LintShape, { min: number; max: number }> = {
  set_piece: { min: 40, max: 130 },
  reply: { min: 3, max: 60 },
  reaction: { min: 1, max: 15 },
  interjection: { min: 2, max: 35 },
  chair: { min: 5, max: 50 },
  closing: { min: 20, max: 90 },
};

export interface LintContext {
  shape: LintShape;
  budget: { min: number; max: number };
  speaker: string;
  /** First names of everyone seated, the chair included. */
  names: string[];
  /** The chair's first name: a reply to a colleague that addresses him is routing through the chair. */
  chairName: string;
  /** This turn answers a colleague rather than opening a point. */
  replyToColleague: boolean;
  /** Earlier spoken expert turns in the session, oldest first. */
  recent: { speaker: string; text: string }[];
  /**
   * Whether the trailer shows the speaker's stance actually moved this turn.
   * null when it cannot be known (no stance before, or none now).
   */
  stanceMoved: boolean | null;
  /** Antithesis constructions the room has already used on this motion. */
  antithesisSoFar: number;
  /** Phrases this speaker never says (dossier, 2b-5). */
  neverSay?: string[];
  /** The speaker's budgeted verbal habits (dossier) and how often each was used this motion. */
  tics?: { text: string; maxPerMotion: number; used: number }[];
}

export interface LintHit {
  rule: string;
  weight: number;
  /** The offending text, or a short description. Shown to the rewriter, never to the room. */
  detail: string;
}

export interface LintResult {
  score: number;
  rules: string[];
  hits: LintHit[];
  /** The speaker's own habits this turn used, for the per-motion tic budget. */
  ticsUsed: string[];
}

// ---------- text helpers ----------

export const wordCount = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

export function sentences(t: string): string[] {
  return t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

const STOP = new Set(['name', 'the', 'a', 'an', 'of', 'to', 'and', 'is', 'it', 'that', 'in', 'on', 'for', 'we', 'i', 'you', 'this', 'be', 'at', 'if', 'but', 'not', 'are', 'was']);

function tokens(t: string, names: string[]): string[] {
  let s = t.toLowerCase();
  for (const n of names) if (n) s = s.replace(new RegExp(`\\b${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), 'name');
  return s.replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
}

function opener(t: string, names: string[]): string | null {
  const w = tokens(t, names).slice(0, 3);
  return w.length === 3 ? w.join(' ') : null;
}

function fourGrams(t: string, names: string[]): Set<string> {
  const w = tokens(t, names);
  const out = new Set<string>();
  for (let i = 0; i + 4 <= w.length; i++) {
    const g = w.slice(i, i + 4);
    if (g.every((x) => STOP.has(x))) continue;
    out.add(g.join(' '));
  }
  return out;
}

// ---------- the rules ----------

export function lintTurn(text: string, ctx: LintContext): LintResult {
  const hits: LintHit[] = [];
  const hit = (rule: string, weight: number, detail: string) => hits.push({ rule, weight, detail: detail.slice(0, 160) });

  for (const b of SPEECH_BANNED) {
    const m = text.match(b.re);
    if (m) hit(`banned:${b.id}`, 3, m[0]);
  }
  // The realism module's one banned-phrase list (realism/lint-rules.ts), for
  // the phrases the speech patterns above do not already catch.
  for (const b of ruleBannedPhrases(text)) {
    if (!SPEECH_BANNED.some((s) => s.re.test(b.detail))) hit('banned:phrase', 3, b.detail);
  }
  const label = text.match(TICS.labelParenthetical);
  if (label) hit('spoken_label', 3, label[0]);
  // Word-bounded, so "circle back" does not fire on "semicircle backing".
  for (const n of ruleNeverSay(text, ctx.neverSay ?? [])) hit('never_say', 3, n.detail);
  const tics = ruleTics(text, ctx.tics ?? []);
  for (const t of tics.hits) hit('tic_over_budget', 2, t.detail);
  if (!hits.some((h) => h.rule === 'banned:meta_speech')) {
    const meta = ruleMetaSpeech(text)[0];
    if (meta) hit('meta_speech', 1, meta.detail);
  }

  const anti = text.match(ANTITHESIS_ALL) ?? [];
  if (anti.length > 1) hit('antithesis_repeat', 2, anti.slice(0, 2).join(' / '));
  else if (anti.length === 1 && ctx.antithesisSoFar >= ANTITHESIS_PER_MOTION) hit('antithesis_budget', 1, anti[0]);

  const filler = FILLER.map((r) => text.match(r)).find(Boolean);
  if (filler) hit('filler', 1, filler[0]);
  if (/—/.test(text)) hit('em_dash', 1, 'an em-dash');
  if (/^\s*([-*•]|\d+[.)])\s/m.test(text) || /^#{1,6}\s/m.test(text) || /\*\*[^*]+\*\*/.test(text)) hit('markdown', 2, 'a list, header or bold text');

  const ss = sentences(text);
  if (ss.length > 2 && SUMMARY_ENDING.test(ss[ss.length - 1])) hit('summary_ending', 1, ss[ss.length - 1]);

  const recent = ctx.recent.slice(-30);
  const open = opener(text, ctx.names);
  if (open && recent.some((r) => opener(r.text, ctx.names) === open)) hit('shared_opener', 1, open);

  const mine = recent.filter((r) => r.speaker === ctx.speaker).slice(-5);
  if (mine.length) {
    const seen = new Set<string>();
    for (const r of mine) for (const g of fourGrams(r.text, ctx.names)) seen.add(g);
    const reused = [...fourGrams(text, ctx.names)].filter((g) => seen.has(g));
    if (reused.length >= 2) hit('recycled_4gram', 1, reused.slice(0, 2).join(' / '));
  }

  const n = wordCount(text);
  if (n > ctx.budget.max) hit('too_long', 2, `${n} words, budget ${ctx.budget.max}`);
  if (n > ctx.budget.max * 1.5) hit('far_too_long', 1, `${n} words`);
  if (ctx.shape === 'set_piece' && n < ctx.budget.min) hit('too_short', 1, `${n} words, budget ${ctx.budget.min}+`);

  const chair = ctx.chairName ? new RegExp(`\\b${ctx.chairName}\\b`) : null;
  if (chair && ctx.replyToColleague && chair.test(text)) hit('chair_address', 1, `addresses ${ctx.chairName} in a reply to a colleague`);

  const concedes = CONCESSION.some((r) => r.test(text));
  if (concedes && chair && ss.length > 1 && chair.test(ss[ss.length - 1])) {
    hit('template', 2, 'concedes, attacks, then hands a request to the chair');
  } else {
    // The fuller house template: name and concession, attack, spoken label, request to the chair (3 of 4).
    const t = ruleTemplate(text, ctx.names, ctx.chairName)[0];
    if (t) hit('template', 2, t.detail);
  }
  if (concedes && ctx.stanceMoved === false && !POSITION_CHANGE.some((r) => r.test(text))) {
    const m = CONCESSION.map((r) => text.match(r)).find(Boolean);
    hit('courtesy_concession', 2, m?.[0] ?? 'concession language');
  }
  const melo = text.match(MELODRAMA);
  if (melo) hit('melodrama', 1, melo[0]);

  /**
   * A first-person anecdote told as fact ("my head baker quit after eight
   * weeks"). Flagged, never rewritten: the story is the speaker's to tell, and
   * removing it would change substance. Weight 0, so it never triggers a
   * rewrite on its own; the record carries it to the eval kit, and the
   * evidence check (realism/evidence.ts) grades the claim persona.
   */
  const story = anecdotes(text)[0];
  if (story) hit('persona_anecdote', 0, story);

  return { score: hits.reduce((s, h) => s + h.weight, 0), rules: [...new Set(hits.map((h) => h.rule))], hits, ticsUsed: tics.used };
}

// ---------- the rewrite ----------

const WHY: Record<string, string> = {
  spoken_label: 'an evidence grade spoken as a parenthetical; grades are recorded separately, so say the claim without it',
  never_say: 'a phrase this speaker never uses',
  antithesis_repeat: 'the "X is not A, it is B" construction more than once; keep at most one, say the rest straight',
  antithesis_budget: 'the "X is not A, it is B" construction, which the room has already overused; say it straight',
  filler: 'praise or agreement filler',
  em_dash: 'em-dashes; use commas, periods or parentheses',
  markdown: 'lists, headers or bold text; this is speech',
  summary_ending: 'a final sentence that wraps the turn up; end on the point instead',
  shared_opener: 'an opening that copies how other turns opened; start differently',
  recycled_4gram: 'phrasing this speaker already used in recent turns',
  too_long: 'too long for this turn',
  far_too_long: 'far too long for this turn',
  too_short: 'too thin for a turn that opens a point',
  chair_address: 'talking to the chair while answering a colleague; talk to the colleague',
  template: 'the stock shape: concede, attack, then hand the chair a request',
  courtesy_concession: 'conceding a point the speaker has not actually moved on; drop the courtesy or make the concession real',
  melodrama: 'stakes inflated past anything the room has shown',
  tic_over_budget: 'a verbal habit of this speaker\'s, already used as often as it can be this motion; say it another way',
  meta_speech: 'talking about how they are about to talk; just say the thing',
};

/** Why a rule fired, in words the rewriter can act on. */
export function describeHit(h: LintHit): string {
  if (h.rule.startsWith('banned:') || h.rule === 'never_say') return `a stock phrase this room overuses: "${h.detail}"`;
  if (h.rule === 'tic_over_budget') return `${WHY[h.rule]} (${h.detail})`;
  return `${WHY[h.rule] ?? h.rule}${h.rule === 'too_long' || h.rule === 'too_short' ? ` (${h.detail})` : ''}`;
}

/**
 * The rewrite prompt. EXEMPT from the prompt selftest's banned-phrase check on
 * purpose: to remove a stock phrase it has to quote the one this turn used.
 * Its output is checked instead, by the verifier and by a re-lint.
 */
export function rewritePrompt(
  text: string,
  lint: LintResult,
  ctx: LintContext,
  voice: { name: string; style: string },
  retryReasons?: string[]
): { system: string; prompt: string } {
  const system = `You edit one turn of speech from a live working meeting so that it sounds like the person talking, not like a memo. You change FORM only.

Hard rules:
- Keep every claim and every number exactly as written: digits stay digits, words stay words. Keep every person's name and every citation marker like [c_ab12]. Add no claim, number, name or marker that is not already there.
- Fix exactly the problems listed and nothing else.
- At most ${ctx.budget.max} words. Spoken prose: no lists, no headers, no bold, no em-dashes.
- Keep the speaker's own voice: ${voice.style || 'plain and direct'}.
- Output only the edited words. No preamble, no quotation marks around them, no notes.`;
  const prompt = [
    `THE SPEAKER: ${voice.name}`,
    // Weight-0 hits are flags for the record, not problems of form to fix.
    `WHAT TO FIX:\n${lint.hits.filter((h) => h.weight > 0).map((h) => `- ${describeHit(h)}`).join('\n')}`,
    retryReasons?.length ? `YOUR LAST EDIT WAS REJECTED BECAUSE:\n${retryReasons.map((r) => `- ${r}`).join('\n')}\nKeep the substance exactly; change only the form.` : '',
    `THE TURN:\n${text}`,
  ].filter(Boolean).join('\n\n');
  return { system, prompt };
}

// ---------- the verifier ----------

const NUMBER_WORDS = new Set([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty',
  'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'million', 'billion',
  'half', 'third', 'quarter', 'double', 'twice', 'triple', 'percent',
]);

/** Every number in a text, digits and number words both, as a sorted multiset. */
export function numbersOf(text: string): string[] {
  const out: string[] = [];
  const t = text.replace(/\[c_[A-Za-z0-9_-]+\]/g, ' ');   // citation ids are checked on their own
  for (const m of t.matchAll(/\d[\d,]*(?:\.\d+)?%?/g)) out.push(m[0].replace(/,/g, '').replace(/\.$/, ''));
  for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) if (NUMBER_WORDS.has(w)) out.push(w);
  return out.sort();
}

export const citationsOf = (t: string) => (t.match(/\[c_[A-Za-z0-9_-]+\]/g) ?? []).sort();

const PRONOUN_CAPS = new Set(['I', "I'm", "I'll", "I've", "I'd"]);

/** Capitalised words that are not the first word of a sentence: names, places, products. */
function entities(t: string): Set<string> {
  const out = new Set<string>();
  for (const s of sentences(t)) {
    const words = s.split(/\s+/).slice(1);
    for (const raw of words) {
      const w = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9'&-]+$/g, '').replace(/'s$/, '');
      if (/^[A-Z][A-Za-z0-9&'-]*$/.test(w) && !PRONOUN_CAPS.has(w)) out.add(w);
    }
  }
  return out;
}

function wordSet(t: string): Set<string> {
  return new Set((t.match(/[A-Za-z0-9&'-]+/g) ?? []).map((w) => w.replace(/'s$/, '')));
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Accept a rewrite only if nothing of substance moved. Deterministic: the
 * model that wrote it does not get a say in whether it is acceptable.
 */
export function verifyRewrite(original: string, candidate: string, ctx: LintContext): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const c = candidate.trim();
  if (!c) return { ok: false, reasons: ['the edit was empty'] };
  if (splitTrailer(c).keys.length) reasons.push('it added a line that looks like a trailer');
  if (!sameList(numbersOf(original), numbersOf(c))) reasons.push(`the numbers changed (${numbersOf(original).join(', ') || 'none'} became ${numbersOf(c).join(', ') || 'none'})`);
  if (!sameList(citationsOf(original), citationsOf(c))) reasons.push('the citation markers changed');
  const origWords = wordSet(original);
  const candWords = wordSet(c);
  const lost = [...entities(original)].filter((e) => !candWords.has(e));
  if (lost.length) reasons.push(`names were dropped: ${lost.join(', ')}`);
  const added = [...entities(c)].filter((e) => !origWords.has(e));
  if (added.length) reasons.push(`names were added: ${added.join(', ')}`);
  const n = wordCount(c);
  if (n > ctx.budget.max) reasons.push(`it is ${n} words, over the ${ctx.budget.max}-word budget`);
  if (n < Math.min(ctx.budget.min, wordCount(original)) * 0.5) reasons.push(`it is ${n} words, too short to carry the point`);
  if (!reasons.length) {
    const before = lintTurn(original, ctx).score;
    const after = lintTurn(c, ctx).score;
    if (after >= before) reasons.push(`it still scored ${after} against the original's ${before}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** Runs the rewriter model. Injected so tests can drive it without one. */
export type Rewriter = (req: { system: string; prompt: string; attempt: number }) => Promise<string>;

/**
 * Lint, and rewrite if the score calls for it. Never throws: a rewriter that
 * fails costs the turn its polish, never the turn.
 */
export async function lintAndRewrite(
  text: string,
  ctx: LintContext,
  voice: { name: string; style: string },
  rewriter: Rewriter | null
): Promise<{ text: string; record: LintRecord; result: LintResult }> {
  const result = lintTurn(text, ctx);
  const record = (rewrote: boolean): LintRecord => ({ score: result.score, rewrote, rules: result.rules });
  if (result.score < LINT_THRESHOLD || !rewriter) return { text, record: record(false), result };
  let reasons: string[] | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const req = rewritePrompt(text, result, ctx, voice, reasons);
      const candidate = (await rewriter({ ...req, attempt })).trim().replace(/^"(.*)"$/s, '$1');
      const v = verifyRewrite(text, candidate, ctx);
      if (v.ok) return { text: candidate, record: record(true), result };
      reasons = v.reasons;
    } catch {
      break;
    }
  }
  return { text, record: record(false), result };
}
