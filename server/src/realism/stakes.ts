/**
 * Boardroom stakes (docs/PHASE2-PLAN.md, 2d): who decides, by when, what is at
 * risk, what being wrong costs; the meeting clock; dissent with tripwires and
 * the minority report; the reality-check seat rule. Every field is marked real
 * or assumed, and assumed is printed as assumed.
 *
 * Pure: no model, no engine, no I/O. Intake (2b-5) hands `resolveStakes` the
 * partial stakes it extracted; the result carries the clarify questions to ask
 * (interactive) or the assumptions to log (autonomous), and `stakesBlock`
 * renders the constant STAKES block for the cached prefix.
 */
import type { Decision, MeetingClock, Persona, Stakes } from '../../../shared/types.ts';

// ---------- stakes with provenance ----------

export type StakesField = 'decisionOwner' | 'decideBy' | 'atRisk' | 'ifWrong' | 'reversibility';
export const STAKES_FIELDS: readonly StakesField[] = ['decisionOwner', 'decideBy', 'atRisk', 'ifWrong', 'reversibility'];

/** Where a field came from. 'missing' only appears before resolution, never in a resolved record. */
export type FieldSource = 'founder' | 'dossier' | 'assumed';

/** What intake managed to extract. Anything absent or blank is missing. */
export interface StakesDraft {
  decisionOwner?: { name?: string; role?: string };
  decideBy?: string;
  atRisk?: { money?: string; people?: string; time?: string; reputation?: string };
  ifWrong?: { yes?: string; no?: string };
  reversibility?: 'one-way' | 'two-way';
  /** Where the draft's present fields came from (default 'founder': the founder's own words). */
  from?: 'founder' | 'dossier';
}

/** Stakes plus per-field provenance. `stakes.source` is the weakest field's source. */
export interface MarkedStakes {
  stakes: Stakes;
  fields: Record<StakesField, FieldSource>;
}

export interface StakesResolution {
  marked: MarkedStakes;
  /** Fields that were missing from the draft. */
  missing: StakesField[];
  /** Interactive mode: one clarify question per missing field, in field order. */
  clarify: { field: StakesField; question: string }[];
  /** Autonomous mode: one assumption line per field that was filled in. */
  assumptions: string[];
}

export const STAKES_QUESTIONS: Record<StakesField, string> = {
  decisionOwner: 'Who makes the final call on this, and what is their role?',
  decideBy: 'By when does this have to be decided: a date, or an occasion like a board meeting?',
  atRisk: 'What is at risk if this goes wrong: money, people, or time? Rough figures are fine.',
  ifWrong: 'What does a wrong yes cost you, and what does a wrong no cost you?',
  reversibility: 'If this turns out wrong, can it be undone, or is it a one-way door?',
};

const blank = (s?: string) => !s || !s.trim();
const t = (s?: string) => (s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Fill a stakes draft. Present fields keep the draft's source; missing ones
 * get a stated, conservative assumption (never an invented figure: missing
 * money at risk becomes "not stated", not a number). In interactive mode the
 * caller asks `clarify` first and re-runs this with the answers; whatever is
 * still missing after that is assumed and marked.
 */
export function resolveStakes(draft: StakesDraft, opts: { founderName?: string } = {}): StakesResolution {
  const src: FieldSource = draft.from ?? 'founder';
  const owner = t(opts.founderName) || 'the founder';
  const missing: StakesField[] = [];
  const fields = {} as Record<StakesField, FieldSource>;
  const assumptions: string[] = [];
  const assume = (f: StakesField, line: string) => {
    missing.push(f);
    fields[f] = 'assumed';
    assumptions.push(line);
  };

  let decisionOwner: Stakes['decisionOwner'];
  if (blank(draft.decisionOwner?.name)) {
    decisionOwner = { name: owner, role: t(draft.decisionOwner?.role) || 'decision owner' };
    assume('decisionOwner', `Assumed the decision owner is ${owner}.`);
  } else {
    decisionOwner = { name: t(draft.decisionOwner!.name), role: t(draft.decisionOwner?.role) || 'decision owner' };
    fields.decisionOwner = src;
  }

  let decideBy: string;
  if (blank(draft.decideBy)) {
    decideBy = 'the end of this session';
    assume('decideBy', 'Assumed the decision is due at the end of this session.');
  } else {
    decideBy = t(draft.decideBy);
    fields.decideBy = src;
  }

  const r = draft.atRisk ?? {};
  const atRisk: Stakes['atRisk'] = {};
  for (const k of ['money', 'people', 'time', 'reputation'] as const) if (!blank(r[k])) atRisk[k] = t(r[k]);
  if (!Object.keys(atRisk).length) {
    atRisk.money = 'not stated';
    assume('atRisk', 'What is at risk was not stated; the room treats it as unknown, not as zero.');
  } else fields.atRisk = src;

  const w = draft.ifWrong ?? {};
  let ifWrong: Stakes['ifWrong'];
  if (blank(w.yes) && blank(w.no)) {
    ifWrong = { yes: 'not stated', no: 'not stated' };
    assume('ifWrong', 'The cost of a wrong yes and a wrong no were not stated.');
  } else {
    ifWrong = { yes: t(w.yes) || 'not stated', no: t(w.no) || 'not stated' };
    fields.ifWrong = src;
  }

  let reversibility: Stakes['reversibility'];
  if (!draft.reversibility) {
    // The cautious reading: treat an unknown door as one-way until told otherwise.
    reversibility = 'one-way';
    assume('reversibility', 'Assumed the decision is hard to undo (one-way) until told otherwise.');
  } else {
    reversibility = draft.reversibility;
    fields.reversibility = src;
  }

  const sources = STAKES_FIELDS.map((f) => fields[f]);
  const source: Stakes['source'] = sources.includes('assumed') ? 'assumed' : sources.includes('dossier') ? 'dossier' : 'founder';
  return {
    marked: { stakes: { decisionOwner, decideBy, atRisk, ifWrong, reversibility, source }, fields },
    missing,
    clarify: missing.map((field) => ({ field, question: STAKES_QUESTIONS[field] })),
    assumptions,
  };
}

/** Mark stakes that arrived without per-field provenance (an old or hand-made record). */
export function markAll(stakes: Stakes): MarkedStakes {
  const fields = Object.fromEntries(STAKES_FIELDS.map((f) => [f, stakes.source])) as Record<StakesField, FieldSource>;
  return { stakes, fields };
}

const tag = (s: FieldSource) => (s === 'assumed' ? ' (assumed)' : '');

/**
 * The STAKES block for the session-constant layer of the shared prefix. Pure
 * and deterministic: the same stakes always give the same bytes, so the cache
 * holds. Every assumed field says so.
 */
export function stakesBlock(m: MarkedStakes): string {
  const { stakes: s, fields: f } = m;
  const risk = (['money', 'people', 'time', 'reputation'] as const)
    .filter((k) => s.atRisk[k])
    .map((k) => `${k}: ${s.atRisk[k]}`)
    .join('; ');
  return [
    'STAKES',
    `Decision owner: ${s.decisionOwner.name}, ${s.decisionOwner.role}${tag(f.decisionOwner)}.`,
    `Decide by: ${s.decideBy}${tag(f.decideBy)}.`,
    `At risk: ${risk}${tag(f.atRisk)}.`,
    `If a wrong yes: ${s.ifWrong.yes}. If a wrong no: ${s.ifWrong.no}${tag(f.ifWrong)}.`,
    `Reversibility: ${s.reversibility === 'one-way' ? 'one-way door, hard to undo' : 'two-way door, can be undone'}${tag(f.reversibility)}.`,
  ].join('\n');
}

/** The owner a ruling names: whoever the room named, else the stakes' decision owner. */
export function rulingOwner(stakes: Stakes | undefined, roomNamed?: string, fallback = 'the founder'): string {
  return t(roomNamed) || stakes?.decisionOwner.name || fallback;
}

/** The expected-cost line a ruling states, from `ifWrong`. */
export function costOfBeingWrong(m: MarkedStakes, ruling: 'yes' | 'no'): string {
  const c = ruling === 'yes' ? m.stakes.ifWrong.yes : m.stakes.ifWrong.no;
  const door = m.stakes.reversibility === 'one-way' ? 'and it is hard to undo' : 'and it can be undone';
  return `If this ${ruling} is wrong, it costs ${c}${tag(m.fields.ifWrong)}, ${door}.`;
}

// ---------- the meeting clock ----------

export const CLOCK_RULES = {
  /** Speaking pace on the performance timeline. */
  wordsPerSec: 2.5,
  /** Mean words per spoken turn under the director's mix (plan 2d). */
  avgWordsPerTurn: 42,
  /** Fictional meeting time a research wait costs. */
  researchWaitSec: 90,
  /** Pause allowance per turn folded into the slot. */
  pauseSecPerTurn: 1.5,
} as const;

/**
 * A motion's time slot from an expected number of spoken turns:
 * slot = (turns / motions) * avgWords / pace + pauses. 80 turns over 2
 * motions gives about 11 minutes. The profiles no longer carry a turn cap
 * (budget redesign), so whoever wires this must choose the turn count.
 */
export function slotSecFor(turnCap: number, motions: number): number {
  const perMotion = turnCap / Math.max(1, motions);
  const speech = (perMotion * CLOCK_RULES.avgWordsPerTurn) / CLOCK_RULES.wordsPerSec;
  return Math.round(speech + perMotion * CLOCK_RULES.pauseSecPerTurn);
}

/** Advance the clock by spoken words, pauses and research waits. Returns a new clock. */
export function advanceClock(c: MeetingClock, by: { words?: number; pauseMs?: number; researchWaits?: number }): MeetingClock {
  const add = (by.words ?? 0) / CLOCK_RULES.wordsPerSec + (by.pauseMs ?? 0) / 1000 + (by.researchWaits ?? 0) * CLOCK_RULES.researchWaitSec;
  return { ...c, elapsedSec: c.elapsedSec + Math.max(0, add) };
}

export type ClockMilestone = 'half' | 'five_left' | 'one_left' | 'time';

/** The milestones crossed going from `prev` to `next`, in order. The chair announces them. */
export function clockMilestones(prev: MeetingClock, next: MeetingClock): ClockMilestone[] {
  const slot = next.slotSec;
  const marks: [ClockMilestone, number][] = [
    ['half', slot / 2],
    ['five_left', slot - 300],
    ['one_left', slot - 60],
    ['time', slot],
  ];
  return marks.filter(([, at]) => at > 0 && prev.elapsedSec < at && next.elapsedSec >= at).map(([m]) => m);
}

export const isOutOfTime = (c: MeetingClock) => c.elapsedSec >= c.slotSec;

const NUM_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 0-99 in words; larger numbers as digits. */
export function numberWords(n: number): string {
  if (n < 0 || n > 99 || !Number.isInteger(n)) return String(n);
  if (n < 20) return NUM_WORDS[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? `-${NUM_WORDS[n % 10]}` : '');
}

/** The clock as a speaker's suffix line: "fourteen minutes into a twenty-minute slot". Never in the prefix. */
export function clockLine(c: MeetingClock): string {
  const slotMin = Math.max(1, Math.round(c.slotSec / 60));
  const slotWords = numberWords(slotMin);
  const slot = `${/^(eight|eleven)/.test(slotWords) ? 'an' : 'a'} ${slotWords}-minute slot`;
  if (isOutOfTime(c)) return `The ${numberWords(slotMin)}-minute slot for this motion is used up.`;
  const el = Math.floor(c.elapsedSec / 60);
  if (el < 1) return `Under a minute into ${slot}.`;
  return `${numberWords(el)[0].toUpperCase()}${numberWords(el).slice(1)} minute${el === 1 ? '' : 's'} into ${slot}.`;
}

// ---------- dissent with teeth, and the minority report ----------

/** A dissent as rulings record it today, plus the tripwire and cost the plan asks for (2d, item 5). */
export interface DissentRecord {
  expert: string;
  position: string;
  reasoning: string;
  /** What would prove the dissenter right, and by when. */
  tripwire?: { signal: string; by: string };
  /** What ignoring this dissent costs if the dissenter turns out right. */
  costOfIgnoring?: string;
}

export type DissentProblem = 'no_tripwire' | 'vague_signal' | 'no_deadline' | 'no_cost';

/** Vague signals that could never fire, so they prove nothing. */
const VAGUE = /^(?:if (?:things|it|this) (?:go(?:es)? (?:badly|wrong)|fail|fails|doesn'?t work)|time will tell|we'?ll see|results|the market|performance|if it goes wrong)\.?$/i;
/** A deadline must name a time or an occasion. */
const DEADLINE = /\b(?:\d{1,4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q[1-4]|week|month|quarter|year|day|monday|tuesday|wednesday|thursday|friday|board|review|launch|close|renewal|end of|before|after|by)\b/i;

/** What a dissent is missing before it has teeth. Empty means it is complete. */
export function dissentProblems(d: DissentRecord): DissentProblem[] {
  const p: DissentProblem[] = [];
  if (!d.tripwire || blank(d.tripwire.signal)) p.push('no_tripwire');
  else {
    if (VAGUE.test(t(d.tripwire.signal)) || t(d.tripwire.signal).split(' ').length < 4) p.push('vague_signal');
    if (blank(d.tripwire.by) || !DEADLINE.test(d.tripwire.by)) p.push('no_deadline');
  }
  if (blank(d.costOfIgnoring)) p.push('no_cost');
  return p;
}

export interface MinorityEntry {
  motionId: string;
  motionTitle: string;
  ruling: string;
  expert: string;
  position: string;
  reasoning: string;
  tripwire?: { signal: string; by: string };
  costOfIgnoring?: string;
  /** Problems found; a dissent without teeth is still reported, marked incomplete. */
  problems: DissentProblem[];
}

/**
 * The minority report: every dissent on every ruling, in ruling order then
 * the order the ruling listed them. Dissents may be the plain `Decision`
 * shape (old debates) or carry a tripwire; incomplete ones are kept and marked.
 */
export function minorityReport(decisions: readonly (Omit<Decision, 'dissents'> & { dissents: DissentRecord[] })[]): MinorityEntry[] {
  return decisions.flatMap((d) =>
    d.dissents.map((x) => ({
      motionId: d.motionId,
      motionTitle: d.motionTitle,
      ruling: d.decision,
      expert: x.expert,
      position: x.position,
      reasoning: x.reasoning,
      ...(x.tripwire ? { tripwire: x.tripwire } : {}),
      ...(x.costOfIgnoring ? { costOfIgnoring: x.costOfIgnoring } : {}),
      problems: dissentProblems(x),
    })),
  );
}

/** Plain text of the minority report, for the report writer or the PDF. */
export function renderMinorityReport(entries: readonly MinorityEntry[], nameOf: (id: string) => string = (id) => id): string {
  if (!entries.length) return 'No dissents were recorded.';
  return entries
    .map((e) => {
      const lines = [`${e.motionTitle}: ${nameOf(e.expert)} dissents. ${e.position}`];
      if (e.tripwire) lines.push(`  Proves them right: ${e.tripwire.signal} (by ${e.tripwire.by}).`);
      if (e.costOfIgnoring) lines.push(`  Cost of ignoring: ${e.costOfIgnoring}`);
      if (e.problems.length) lines.push(`  Incomplete: ${e.problems.join(', ')}.`);
      return lines.join('\n');
    })
    .join('\n');
}

// ---------- the reality-check seat ----------

export type RealityKind = 'operations' | 'finance' | 'delivery';

/** Role words that mark someone who has to make the plan happen on Monday. */
export const REALITY_ROLES: Record<RealityKind, RegExp> = {
  operations: /\b(?:operations|ops|coo|operator|general manager|store manager|shift|logistics|supply chain|head of people|hr|staffing|site manager|plant)\b/i,
  finance: /\b(?:cfo|finance|financial controller|controller|fp&a|treasurer|accountant|bookkeeper|head of finance)\b/i,
  delivery: /\b(?:delivery|engineering manager|vp engineering|head of engineering|cto|project manager|program manager|implementation|product manager|tech lead|site reliability)\b/i,
};

/** Topic words that pick which implementer the room needs. */
const TOPIC_KIND: [RealityKind, RegExp][] = [
  ['finance', /\b(?:price|pricing|billing|fundrais\w*|raise|runway|cash|budget|revenue|margin|cost|invest\w*|valuation|loan|debt|annual|monthly)\b/i],
  ['delivery', /\b(?:build|ship|launch|product|feature|platform|migrat\w*|rewrite|engineering|software|app|release|roadmap)\b/i],
  ['operations', /\b(?:staff|hire|hiring|shift|hours|open|store|bakery|restaurant|warehouse|logistics|process|supplier|schedule|sunday|weekend)\b/i],
];

/** Which implementer a topic needs. Ties go to the first match in topic order; default operations. */
export function realityKindFor(topic: string): RealityKind {
  let best: RealityKind = 'operations';
  let bestN = 0;
  for (const [k, re] of TOPIC_KIND) {
    const n = [...topic.matchAll(new RegExp(re.source, 'gi'))].length;
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

export interface RealitySeatCheck {
  ok: boolean;
  want: RealityKind;
  /** The seated implementer, when there is one. */
  seat?: string;
  /** For the architect's retry when the seat is missing. */
  hint?: string;
}

/**
 * The reality-check seat rule: the panel must seat one implementer whose
 * incentive is not to be handed an impossible plan. Any implementer counts
 * (an operations lead on a pricing question still has to make it work), but
 * the hint asks for the kind the topic needs.
 */
export function checkRealitySeat(panel: readonly Pick<Persona, 'id' | 'role'>[], topic: string): RealitySeatCheck {
  const want = realityKindFor(topic);
  const exact = panel.find((p) => REALITY_ROLES[want].test(p.role));
  if (exact) return { ok: true, want, seat: exact.id };
  const any = panel.find((p) => Object.values(REALITY_ROLES).some((re) => re.test(p.role)));
  if (any) return { ok: true, want, seat: any.id };
  return {
    ok: false,
    want,
    hint: `Seat one ${want} implementer: the person who has to make this happen on Monday, whose own interest is not to be handed an impossible plan.`,
  };
}
