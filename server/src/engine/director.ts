/**
 * The floor director: who speaks next, in what shape, and whether a listener
 * cuts in. Pure TypeScript with seeded randomness, so it can be tested and
 * replayed without a model (docs/PHASE2-PLAN.md, 2b).
 *
 * The models decide what is said. This decides who says it and when, which is
 * what a chair's queue and a fixed three-speaker round used to do badly: every
 * turn a memo, nobody ever cut off, two people almost never trading blows.
 *
 * Wired in 2b-7: engine/floor.ts runs every motion through it. Everything here
 * is a function of the FloorState passed in, and every random choice goes
 * through the state's own PRNG, so the same seed and the same inputs give the
 * same room.
 */
import type { FloorState, OwedAnswer, TurnShape } from '../../../shared/types.ts';

/** What the director needs to know about one expert. Defaults stand in until dossiers exist (2b-5). */
export interface DirectorSeat {
  id: string;
  temperament?: { heatGain: number; heatDecay: number; interruptThreshold: number; dominance: number };
  /** Natural set-piece length, 40-160 words. */
  typicalWords?: number;
  /**
   * Air-time propensity (default 1). Uneven by design: a dominant or deeply
   * involved expert takes more of the floor before the share penalty bites.
   */
  weight?: number;
  /** Real relevance to the crux on the table right now: never left silent (the relevance rule). */
  relevant?: boolean;
}

export const DEFAULT_TEMPERAMENT = { heatGain: 0.25, heatDecay: 0.12, interruptThreshold: 0.75, dominance: 0.5 };

/** The director's rules, in one place. Profiles override the caps in 2b-2/2b-7. */
export const DIRECTOR_RULES = {
  /** Interruptions allowed per motion (3-6 by profile). */
  interruptCap: 4,
  /** Spoken turns that must pass before the same person may interrupt again. */
  minInterruptGap: 3,
  /** A duel may run this many exchanges before a third voice comes in. */
  duelMaxExchanges: 4,
  /** Both duellists need at least this much heat for a duel to be allowed. */
  duelHeat: 0.5,
  /** Above this, the chair steps in. */
  chairHeat: 0.85,
  /** After this many presses, the chair names the dodge. */
  pressesBeforeChair: 2,
  /** A cut lands this far into the target sentence. */
  cutFrom: 0.6,
  cutTo: 0.8,
  /** Weight of a listener's reaction intensity (0-3) against their threshold. */
  intensityWeight: 0.25,
  /** Word budgets per shape. A set piece uses the seat's own typical length, clamped. */
  words: { set_piece: [60, 160], reply: [12, 60], reaction: [2, 15], chair: [10, 50] } as Record<TurnShape, [number, number]>,
  /** A reply's ceiling by why it is given (hybrid rhythm: many short turns). */
  replyWords: { duel: 25, owes: 35, addressed: 35, default: 45 } as Record<ReplyContext, number>,
  /** Spoken turns (set pieces and replies, not reactions) between referee checkpoints. */
  checkpointTurns: [6, 8] as [number, number],
  /** A listener who reacts at least this hard, and does not cut in, may say something short after the turn. */
  trailingIntensity: 2,
  /** Share of those trailing reactions that start before the speaker has quite finished. */
  trailingOverlap: 0.35,
  /** Spoken turns between two short reactions from the same listener. */
  minReactGap: 2,
} as const;

/** The founder in the room. Never interrupted, never picked by the director. */
export const FOUNDER_ID = 'user';

// ---------- seeded randomness ----------

/** A 32-bit seed from any string. */
export function seedFrom(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32, advancing the state's own PRNG. Returns [0, 1). */
export function rand(st: FloorState): number {
  st.rng = (st.rng + 0x6d2b79f5) >>> 0;
  let t = st.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---------- state ----------

export function newFloor(motionId: string, seats: DirectorSeat[], seed: string | number, slotSec = 660): FloorState {
  const heat: Record<string, number> = {};
  for (const s of seats) heat[s.id] = 0.2;
  return {
    motionId,
    clock: { elapsedSec: 0, slotSec },
    heat,
    lastSpoke: {},
    turn: 0,
    spoken: {},
    owed: [],
    duel: null,
    ticUse: {},
    interruptions: 0,
    lastInterrupt: {},
    pending: [],
    rng: typeof seed === 'number' ? seed >>> 0 : seedFrom(seed),
  };
}

const temperamentOf = (seats: DirectorSeat[], id: string) =>
  seats.find((s) => s.id === id)?.temperament ?? DEFAULT_TEMPERAMENT;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Heat cools a little every spoken turn, by temperament. */
export function decayHeat(st: FloorState, seats: DirectorSeat[]) {
  for (const id of Object.keys(st.heat)) {
    st.heat[id] = clamp01(st.heat[id] - temperamentOf(seats, id).heatDecay * st.heat[id]);
  }
}

/** Something got to them: named in an attack, a disputed number repeated, cut off. */
export function raiseHeat(st: FloorState, seats: DirectorSeat[], id: string, times = 1) {
  if (!(id in st.heat)) return;
  st.heat[id] = clamp01(st.heat[id] + temperamentOf(seats, id).heatGain * times);
}

// ---------- choosing the next speaker ----------

export interface TurnContext {
  /** Who spoke last (an expert id, 'marcus', or the founder). */
  lastSpeaker?: string;
  /** Who the last turn was addressed to. */
  addressed?: string[];
  /** Listeners whose reaction said they want the floor. */
  wantsFloor?: string[];
  /** Experts whose crux is on the table right now. */
  cruxAtStake?: string[];
}

export interface Pick {
  speaker: string;
  shape: TurnShape;
  words: number;
  /** Why, in a few words. Logged and shown as the chair's note. */
  why: string;
  /** Set when an owed answer put this speaker up. */
  owes?: OwedAnswer;
}

/** The person most overdue to answer, if anyone owes the room one. */
function oldestOwed(st: FloorState, eligible: Set<string>): OwedAnswer | undefined {
  return st.owed.find((o) => eligible.has(o.from));
}

/**
 * Score every expert and pick one. Owed answers dominate; then being
 * addressed, heat, wanting the floor, a crux at stake, and having been quiet;
 * minus recency and minus already holding too much of the floor. A duel is
 * allowed while both people are hot, up to a cap, then a third voice comes in.
 */
export function pickNext(st: FloorState, seats: DirectorSeat[], ctx: TurnContext = {}): Pick {
  if (!seats.length) throw new Error('director: no seats');
  const ids = seats.map((s) => s.id).filter((id) => id !== FOUNDER_ID);
  const eligible = new Set(ids);

  // A duel that has run its course benches both people for one pick.
  const duelSpent = st.duel && st.duel.exchanges >= DIRECTOR_RULES.duelMaxExchanges;
  if (duelSpent && ids.length > 2) {
    eligible.delete(st.duel!.a);
    eligible.delete(st.duel!.b);
  }
  // Nobody speaks twice in a row.
  if (ctx.lastSpeaker && eligible.size > 1) eligible.delete(ctx.lastSpeaker);

  const spokenTotal = Math.max(1, st.turn);
  const owed = oldestOwed(st, eligible);
  let best: { id: string; score: number } | null = null;
  for (const id of eligible) {
    const seat = seats.find((s) => s.id === id);
    let score = 0;
    if (owed && owed.from === id) score += 10;
    if (ctx.addressed?.includes(id)) score += 4;
    score += 3 * (st.heat[id] ?? 0);
    if (ctx.wantsFloor?.includes(id)) score += 2;
    if (ctx.cruxAtStake?.includes(id)) score += 1.5;
    const since = st.lastSpoke[id] === undefined ? st.turn + 1 : st.turn - st.lastSpoke[id];
    score += Math.min(3, since * 0.5);                       // silence bonus, capped
    // The relevance rule: someone the crux turns on who has not spoken in this motion is overdue.
    if (seat?.relevant && st.lastSpoke[id] === undefined && st.turn >= 2) score += 2 + Math.min(4, st.turn * 0.5);
    // A duel partner answering back gets a push while the duel is live.
    if (st.duel && !duelSpent && ctx.lastSpeaker && ((st.duel.a === ctx.lastSpeaker && st.duel.b === id) || (st.duel.b === ctx.lastSpeaker && st.duel.a === id))) {
      const hot = (st.heat[st.duel.a] ?? 0) >= DIRECTOR_RULES.duelHeat && (st.heat[st.duel.b] ?? 0) >= DIRECTOR_RULES.duelHeat;
      if (hot) score += 3;
    }
    // Already holds too much of the floor; a heavier seat can hold more of it before this bites.
    score -= (2 * ((st.spoken[id] ?? 0) / spokenTotal)) / Math.max(0.3, seat?.weight ?? 1);
    score += rand(st) * 0.5;                                  // seeded tie-break
    if (!best || score > best.score) best = { id, score };
  }
  const speaker = best!.id;

  let shape: TurnShape;
  let why: string;
  let context: ReplyContext = 'default';
  if (owed && owed.from === speaker) { shape = 'reply'; why = `owes ${owed.to} an answer`; context = 'owes'; }
  else if (ctx.addressed?.includes(speaker)) { shape = 'reply'; why = 'was put on the spot'; context = 'addressed'; }
  else if (st.duel && !duelSpent && (st.duel.a === speaker || st.duel.b === speaker)) { shape = 'reply'; why = 'answering back'; context = 'duel'; }
  else if (st.turn === 0) { shape = 'set_piece'; why = 'opens the motion'; }
  else if (st.lastSpoke[speaker] === undefined || st.turn - st.lastSpoke[speaker] >= 4) { shape = 'set_piece'; why = 'has been quiet and has a case to make'; }
  else { shape = 'reply'; why = 'has something to say to that'; }

  return { speaker, shape, words: wordBudget(shape, seats.find((s) => s.id === speaker), context), why, owes: owed && owed.from === speaker ? owed : undefined };
}

/** Why a reply is being given, which sets how long it may run. */
export type ReplyContext = 'duel' | 'owes' | 'addressed' | 'default';

/**
 * The word budget for a shape. A set piece uses the seat's own natural
 * length. A reply is a working-meeting turn: a trade inside a duel is a line
 * or two, an answer to a direct question a little more, and only an open
 * reply gets the full reply budget.
 */
export function wordBudget(shape: TurnShape, seat?: DirectorSeat, context: ReplyContext = 'default'): number {
  const [lo, hi] = DIRECTOR_RULES.words[shape];
  if (shape === 'set_piece') return Math.max(lo, Math.min(hi, seat?.typicalWords ?? 100));
  if (shape === 'reply') return Math.max(lo, Math.min(hi, DIRECTOR_RULES.replyWords[context]));
  return hi;
}

/**
 * Book a spoken turn: who spoke, to whom, whether they put a question to
 * someone (which becomes an owed answer), and the duel bookkeeping.
 */
export function recordTurn(
  st: FloorState,
  seats: DirectorSeat[],
  turn: { speaker: string; to?: string[]; question?: string; messageId: string },
) {
  const prev = lastSpeakerOf(st);
  st.turn += 1;
  st.lastSpoke[turn.speaker] = st.turn;
  st.spoken[turn.speaker] = (st.spoken[turn.speaker] ?? 0) + 1;

  // Answering what you owed clears it; a press that went unanswered stays.
  st.owed = st.owed.filter((o) => o.from !== turn.speaker);
  if (turn.question && turn.to?.length) {
    for (const to of turn.to) {
      if (to === turn.speaker || to === FOUNDER_ID) continue;
      const open = st.owed.find((o) => o.from === to && o.to === turn.speaker);
      if (open) open.presses += 1;
      else st.owed.push({ from: to, to: turn.speaker, question: turn.question, messageId: turn.messageId, presses: 0 });
    }
  }

  // Two people trading turns is a duel; anyone else speaking ends it.
  if (prev && prev !== turn.speaker) {
    if (st.duel && ((st.duel.a === prev && st.duel.b === turn.speaker) || (st.duel.b === prev && st.duel.a === turn.speaker))) {
      st.duel.exchanges += 1;
    } else {
      st.duel = { a: prev, b: turn.speaker, exchanges: 1 };
    }
  }
  decayHeat(st, seats);
}

/**
 * Book a short reaction (a cut-in line, a "No.", a "Which customers?"). It is
 * a turn in the room, but not a turn on the floor: it does not use up the
 * reactor's share or reset their silence, so the person who pushed back is
 * still free to take the floor next. A question in it is owed an answer.
 */
export function recordReaction(st: FloorState, turn: { speaker: string; to?: string[]; question?: string; messageId: string }) {
  (st.lastReact ??= {})[turn.speaker] = st.turn;
  if (!turn.question || !turn.to?.length) return;
  for (const to of turn.to) {
    if (to === turn.speaker || to === FOUNDER_ID) continue;
    const open = st.owed.find((o) => o.from === to && o.to === turn.speaker);
    if (open) open.presses += 1;
    else st.owed.push({ from: to, to: turn.speaker, question: turn.question, messageId: turn.messageId, presses: 0 });
  }
}

function lastSpeakerOf(st: FloorState): string | undefined {
  let best: string | undefined;
  let at = -1;
  for (const [id, t] of Object.entries(st.lastSpoke)) if (t > at) { at = t; best = id; }
  return best;
}

/** An unanswered question: the next pick favours whoever owes it, and the presses count. */
export function pressOwed(st: FloorState, from: string) {
  for (const o of st.owed) if (o.from === from) o.presses += 1;
}

// ---------- interruptions ----------

/** One listener's reaction to an utterance, from the fast-tier reaction call. */
export interface Reaction {
  listener: string;
  /** 0 (indifferent) to 3 (cannot let it stand). */
  intensity: number;
  /** 0-based index of the sentence they react to. */
  atSentence: number;
  cutIn?: string | null;
  backchannel?: string | null;
  wantsFloor?: boolean;
}

export interface Interruption {
  by: string;
  /** The sentence being cut, 0-based. Never 0: the speaker finishes at least one sentence. */
  atSentence: number;
  /** Character offset in the full utterance where the speaker stops. */
  atChar: number;
  cutIn: string;
}

/** Split an utterance into sentences, keeping their offsets in the original text. */
export function splitSentences(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  const re = /[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!m[0].trim()) { if (re.lastIndex >= text.length) break; continue; }
    const lead = m[0].length - m[0].trimStart().length;
    out.push({ text: m[0].trim(), start: m.index + lead });
    if (re.lastIndex >= text.length) break;
  }
  return out;
}

/**
 * Decide whether anyone cuts in, and where. The model proposes; this decides:
 * never the founder, never before the first sentence is finished, never past
 * the motion's cap, never the same person twice within the minimum gap, and
 * only when heat plus intensity clears the listener's own threshold.
 */
export function decideInterruption(
  st: FloorState,
  seats: DirectorSeat[],
  speaker: string,
  utterance: string,
  reactions: Reaction[],
  /** Interruptions allowed this motion; the profile's (3-6), else the default. */
  cap: number = DIRECTOR_RULES.interruptCap,
): Interruption | null {
  if (speaker === FOUNDER_ID) return null;
  if (st.interruptions >= cap) return null;
  const sentences = splitSentences(utterance);
  if (sentences.length < 2) return null;              // nothing to cut after the first sentence

  let best: { r: Reaction; margin: number } | null = null;
  for (const r of reactions) {
    if (r.listener === speaker || r.listener === FOUNDER_ID) continue;
    if (!seats.some((s) => s.id === r.listener)) continue;
    if (!r.cutIn || !r.cutIn.trim()) continue;
    if (r.atSentence < 1 || r.atSentence >= sentences.length) continue;
    const last = st.lastInterrupt[r.listener];
    if (last !== undefined && st.turn - last < DIRECTOR_RULES.minInterruptGap) continue;
    const t = temperamentOf(seats, r.listener);
    const margin = (st.heat[r.listener] ?? 0) + DIRECTOR_RULES.intensityWeight * Math.max(0, Math.min(3, r.intensity)) - t.interruptThreshold;
    if (margin < 0) continue;
    if (!best || margin > best.margin) best = { r, margin };
  }
  if (!best) return null;

  const target = sentences[best.r.atSentence];
  const frac = DIRECTOR_RULES.cutFrom + (DIRECTOR_RULES.cutTo - DIRECTOR_RULES.cutFrom) * rand(st);
  let at = Math.floor(target.text.length * frac);
  // Land on a word boundary, so the speaker stops between words, mid-thought.
  while (at > 1 && target.text[at] !== ' ') at--;
  if (at <= 1) at = Math.max(1, target.text.indexOf(' ', 1));
  return { by: best.r.listener, atSentence: best.r.atSentence, atChar: target.start + at, cutIn: best.r.cutIn!.trim() };
}

/** Book an interruption that was performed. Being cut off makes the speaker hotter. */
export function recordInterruption(st: FloorState, seats: DirectorSeat[], by: string, speaker: string) {
  st.interruptions += 1;
  st.lastInterrupt[by] = st.turn;
  raiseHeat(st, seats, speaker);
}

/** Who keeps the floor after a cut: dominance plus heat, speaker against interrupter. */
export function floorFight(st: FloorState, seats: DirectorSeat[], speaker: string, by: string): 'speaker_resumes' | 'interrupter_takes' {
  const s = temperamentOf(seats, speaker).dominance + (st.heat[speaker] ?? 0) * 0.5;
  const b = temperamentOf(seats, by).dominance + (st.heat[by] ?? 0) * 0.5;
  return s + (rand(st) - 0.5) * 0.2 >= b ? 'speaker_resumes' : 'interrupter_takes';
}

/** A short reaction after a turn: pushback, a question, a "No." */
export interface Trailing {
  by: string;
  text: string;
  /** Starts before the speaker has quite finished: talked over the last words. */
  overlap: boolean;
}

/**
 * After a turn that was not cut, at most one listener who reacted hard enough
 * says something short: the working-meeting rhythm, where a point draws a
 * "On what base?" before the next person takes the floor. The model proposes
 * the words; the director decides whether anyone says them, and whether they
 * start over the speaker's last words.
 */
export function decideTrailing(st: FloorState, seats: DirectorSeat[], speaker: string, reactions: Reaction[], cutBy?: string): Trailing | null {
  let best: { r: Reaction; score: number } | null = null;
  for (const r of reactions) {
    if (r.listener === speaker || r.listener === FOUNDER_ID || r.listener === cutBy) continue;
    if (!seats.some((s) => s.id === r.listener)) continue;
    // Nobody pushes back turn after turn: the same listener waits a couple of turns between reactions.
    const last = st.lastReact?.[r.listener];
    if (last !== undefined && st.turn - last < DIRECTOR_RULES.minReactGap) continue;
    const text = (r.backchannel ?? r.cutIn ?? '').trim();
    if (!text || r.intensity < DIRECTOR_RULES.trailingIntensity) continue;
    if (text.split(/\s+/).length > DIRECTOR_RULES.words.reaction[1]) continue;
    const score = r.intensity + (st.heat[r.listener] ?? 0) + rand(st) * 0.5;
    if (!best || score > best.score) best = { r, score };
  }
  if (!best) return null;
  return { by: best.r.listener, text: (best.r.backchannel ?? best.r.cutIn ?? '').trim(), overlap: rand(st) < DIRECTOR_RULES.trailingOverlap };
}

/** How many spoken turns until the next referee checkpoint (seeded, 6-8). */
export function checkpointSize(st: FloorState): number {
  const [lo, hi] = DIRECTOR_RULES.checkpointTurns;
  return lo + Math.floor(rand(st) * (hi - lo + 1));
}

// ---------- the chair ----------

export type ChairTrigger =
  | { kind: 'heat'; who: string }
  | { kind: 'dodge'; who: string; question: string };

/** The chair speaks on a trigger, not every round. */
export function chairTrigger(st: FloorState): ChairTrigger | null {
  const hot = Object.entries(st.heat).find(([, h]) => h > DIRECTOR_RULES.chairHeat);
  if (hot) return { kind: 'heat', who: hot[0] };
  const dodged = st.owed.find((o) => o.presses >= DIRECTOR_RULES.pressesBeforeChair);
  if (dodged) return { kind: 'dodge', who: dodged.from, question: dodged.question };
  return null;
}
