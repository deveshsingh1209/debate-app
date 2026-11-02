/**
 * The live floor (docs/PHASE2-PLAN.md 2b, step 2b-7). Replaces the old
 * three-speaker round.
 *
 * Between two referee checkpoints the floor director (director.ts) decides,
 * turn by turn, who speaks next and how long they may go: a set piece when
 * someone has the floor to make a case, a reply when they were put on the
 * spot or are trading blows, a short reaction when a listener cannot let
 * something stand. Each turn is WRITTEN IN FULL first, then the listeners'
 * reactions are read off it (one fast call), then the director decides
 * whether anyone cuts in and where, and only then is the turn PERFORMED to
 * the room at speaking pace, with the cut, the talking-over and the pauses as
 * events. Only the words actually heard are ever saved.
 *
 * While turn k is being performed, turn k+1 is already being written, against
 * a projection of the room that holds exactly the words of k that will be
 * heard (plannedEvents), never its unsaid remainder.
 *
 * The chair speaks on a trigger, not every round: a dodged question pressed
 * twice, a heated room, a herd or an unexplained fold from the belief ledger,
 * a milestone on the meeting clock, or someone the crux turns on left out.
 *
 * This module holds the loop and the pure planning; the runner implements
 * FloorHost (models, publishing, the database).
 */
import crypto from 'node:crypto';
import type { ClaimRecord, FloorState, LintRecord } from '../../../shared/types.ts';
import {
  chairTrigger, checkpointSize, decideInterruption, decideTrailing, DIRECTOR_RULES, floorFight, pickNext, raiseHeat, rand,
  recordInterruption, recordReaction, recordTurn, splitSentences, wordBudget,
  type DirectorSeat, type Pick, type Reaction, type TurnContext,
} from './director.ts';
import type { Trailer } from './trailer.ts';
import { advanceClock, clockMilestones, type ClockMilestone } from '../realism/stakes.ts';

const rid = (p: string) => `${p}_${crypto.randomBytes(6).toString('base64url')}`;

/** A turn written in full and linted, not yet heard. */
export interface GeneratedTurn {
  id: string;
  speaker: string;
  shape: 'set_piece' | 'reply';
  /** The whole turn as written (after lint). Only the heard part is ever published. */
  text: string;
  to?: string[];
  claims?: ClaimRecord[];
  lint?: LintRecord;
  /** Server-side only: stance, desk and research requests. */
  trailer: Trailer;
  replyTo?: string;
}

/** How a turn will be performed, decided before anyone hears it. */
export interface PerformPlan {
  cut?: {
    /** Where the speaker stops, in the full text. */
    atChar: number;
    by: string;
    /** The cut-in, spoken over the speaker's last words. */
    text: string;
    id: string;
    /** Where in the heard text the cut-in starts. */
    overlapFrom: number;
    fight: 'speaker_resumes' | 'interrupter_takes';
    /** The message id of the resumed remainder, when the speaker takes the floor back. */
    resumeId?: string;
    /** What the speaker says to hold the floor before restarting the cut sentence. */
    holdLine?: string;
  };
  trailing?: { id: string; by: string; text: string; overlap: boolean };
  aside?: { id: string; from: string; to: string; text: string };
  /** Silence after the cut-in, on the performance timeline. */
  tensionMs?: number;
}

/** Lines a speaker uses to take the floor back. Few, varied, and only on a cut the speaker wins. */
const HOLD_LINES = ['Let me finish.', 'Hang on, I am not done.', 'One second.', 'No, let me get to the end of this.'];

/**
 * The events a performance publishes, in order (without seq and ts). The
 * runner publishes exactly these, and the next turn is written against
 * exactly these, so what the room reads is what the room heard.
 */
export function plannedEvents(turn: GeneratedTurn, plan: PerformPlan): any[] {
  const out: any[] = [];
  const base = {
    type: 'message', id: turn.id, speaker: turn.speaker, kind: 'floor', shape: turn.shape,
    ...(turn.to?.length ? { to: turn.to } : {}),
    ...(turn.replyTo ? { replyTo: turn.replyTo } : {}),
    ...(turn.claims?.length ? { claims: turn.claims } : {}),
    ...(turn.lint ? { lint: turn.lint } : {}),
  };
  let lastId = turn.id;
  let lastText = turn.text;
  if (plan.cut) {
    const heard = turn.text.slice(0, plan.cut.atChar).trimEnd();
    out.push({ ...base, text: heard, cutOff: { atChar: heard.length, by: plan.cut.by, ...(plan.cut.fight === 'speaker_resumes' && plan.cut.resumeId ? { resumedBy: plan.cut.resumeId } : {}) } });
    out.push({ type: 'message', id: plan.cut.id, speaker: plan.cut.by, kind: 'reaction', shape: 'reaction', text: plan.cut.text, to: [turn.speaker], replyTo: turn.id, overlap: { with: turn.id, fromChar: Math.min(plan.cut.overlapFrom, heard.length) } });
    lastId = plan.cut.id;
    lastText = plan.cut.text;
    if (plan.cut.fight === 'speaker_resumes' && plan.cut.resumeId) {
      const rest = resumeText(turn.text, plan.cut.atChar);
      if (rest) {
        const text = plan.cut.holdLine ? `${plan.cut.holdLine} ${rest}` : rest;
        out.push({ type: 'message', id: plan.cut.resumeId, speaker: turn.speaker, kind: 'floor', shape: 'reply', text, replyTo: plan.cut.id, to: [plan.cut.by] });
        lastId = plan.cut.resumeId;
        lastText = text;
      }
    }
  } else {
    out.push({ ...base, text: turn.text });
  }
  if (plan.trailing) {
    out.push({
      type: 'message', id: plan.trailing.id, speaker: plan.trailing.by, kind: 'reaction', shape: 'reaction', text: plan.trailing.text,
      to: [turn.speaker], replyTo: lastId,
      ...(plan.trailing.overlap ? { overlap: { with: lastId, fromChar: tailStart(lastText) } } : {}),
    });
  }
  return out;
}

/** The remainder a speaker picks back up after a cut: the cut sentence from its start, and everything after it. */
export function resumeText(full: string, atChar: number): string {
  const sentences = splitSentences(full);
  let start = 0;
  for (const s of sentences) if (s.start <= atChar) start = s.start;
  return full.slice(start).trim();
}

/** Where the last few words of a text begin: a cut-in or a reaction starts over them. */
export function tailStart(text: string, words = 3): number {
  const t = text.trimEnd();
  let at = t.length;
  let seen = 0;
  for (let i = t.length - 1; i > 0; i--) {
    if (t[i] === ' ' && t[i - 1] !== ' ') {
      seen++;
      at = i + 1;
      if (seen >= words) break;
    }
  }
  return seen ? at : 0;
}

/**
 * Plan one performance: whether anyone cuts in (and where), who wins the
 * floor fight, whether a listener says something short afterwards, and a
 * whisper on a deep panel. Mutates only the floor state's PRNG.
 */
export function planPerformance(
  floor: FloorState,
  seats: DirectorSeat[],
  turn: GeneratedTurn,
  reactions: Reaction[],
  opts: { interruptCap: number; aside?: { from: string; to: string; text: string } | null },
): PerformPlan {
  const plan: PerformPlan = {};
  const cut = decideInterruption(floor, seats, turn.speaker, turn.text, reactions, opts.interruptCap);
  if (cut) {
    const heard = turn.text.slice(0, cut.atChar).trimEnd();
    const fight = floorFight(floor, seats, turn.speaker, cut.by);
    plan.cut = {
      atChar: cut.atChar, by: cut.by, text: cut.cutIn, id: rid('m'), overlapFrom: tailStart(heard), fight,
      ...(fight === 'speaker_resumes' ? { resumeId: rid('m'), holdLine: HOLD_LINES[Math.floor(rand(floor) * HOLD_LINES.length)] } : {}),
    };
    plan.tensionMs = 1200 + Math.round(rand(floor) * 1200);
  }
  // A short reaction afterwards, when the turn was not cut, or was won back.
  if (!cut || plan.cut?.fight === 'speaker_resumes') {
    const t = decideTrailing(floor, seats, turn.speaker, reactions, cut?.by);
    if (t) plan.trailing = { id: rid('m'), by: t.by, text: t.text, overlap: t.overlap };
  }
  if (opts.aside && opts.aside.from !== turn.speaker && opts.aside.to !== turn.speaker && opts.aside.from !== opts.aside.to
    && seats.some((s) => s.id === opts.aside!.from) && seats.some((s) => s.id === opts.aside!.to)) {
    plan.aside = { id: rid('as'), ...opts.aside, text: opts.aside.text.slice(0, 160) };
  }
  return plan;
}

/**
 * Book a planned turn on the floor state, before it is performed (so the next
 * pick can be made, and the next turn written, while this one plays): turns,
 * owed answers, duels, interruptions and heat.
 */
export function bookTurn(floor: FloorState, seats: DirectorSeat[], turn: GeneratedTurn, plan: PerformPlan, reactions: Reaction[]): TurnContext & { forced?: Forced } {
  const question = turn.trailer.ask?.question;
  recordTurn(floor, seats, { speaker: turn.speaker, to: turn.to, question, messageId: turn.id });
  for (const to of turn.to ?? []) raiseHeat(floor, seats, to, 1);
  // Listeners who could not let it stand get hotter.
  for (const r of reactions) if (r.intensity >= 2) raiseHeat(floor, seats, r.listener, 0.5 * (Math.min(3, r.intensity) - 1));
  /**
   * Who may not go next. A reaction is not a floor turn: after "No." the person
   * who pushed back is free to take the floor, and the speaker is not (they
   * just had it). After a question, the speaker owes the answer and goes next.
   */
  let lastSpeaker = turn.speaker;
  let addressed: string[] | undefined = turn.to;
  let forced: Forced | undefined;
  if (plan.cut) {
    recordInterruption(floor, seats, plan.cut.by, turn.speaker);
    recordReaction(floor, { speaker: plan.cut.by, to: [turn.speaker], question: /\?\s*$/.test(plan.cut.text) ? plan.cut.text : undefined, messageId: plan.cut.id });
    if (plan.cut.fight === 'interrupter_takes') {
      forced = { forced: true, speaker: plan.cut.by, shape: 'reply', words: wordBudget('reply', undefined, 'addressed'), why: 'you cut in and won the floor', direction: 'Make the point you cut in to make.' };
    } else {
      // The speaker took the floor back and finished; the interrupter is the one with something to answer.
      addressed = [plan.cut.by];
    }
  }
  if (plan.trailing) {
    const q = /\?\s*$/.test(plan.trailing.text) ? plan.trailing.text : undefined;
    recordReaction(floor, { speaker: plan.trailing.by, to: [turn.speaker], question: q, messageId: plan.trailing.id });
    if (q) {
      lastSpeaker = plan.trailing.by;
      addressed = [turn.speaker];
    } else {
      addressed = undefined;
    }
  }
  return { lastSpeaker, addressed, wantsFloor: reactions.filter((r) => r.wantsFloor).map((r) => r.listener), forced };
}

/** A pick made by the room rather than the director's scoring: the winner of a cut, a desk answer, the chair's nudge. */
export interface Forced {
  forced: true;
  speaker: string;
  shape: 'set_piece' | 'reply';
  words: number;
  why: string;
  /** The question or instruction they answer. */
  direction?: string;
  /** No desk call on this turn (it is the answer to one). */
  noDesk?: boolean;
}

// ---------- the host ----------

export interface GenerateRequest {
  speaker: string;
  shape: 'set_piece' | 'reply';
  words: number;
  /** Why they have the floor, in words for the speaker. */
  direction: string;
  pressure: string | null;
  checkpoint: number;
  /** The checkpoint boundary: the shared prefix is frozen before it. */
  boundary: number;
  /** Events planned but not yet published (the turn being performed): the projection. */
  projected: any[];
  mayCallDesk: boolean;
  replyTo?: string;
}

export interface FloorHost {
  seats(motionId: string): DirectorSeat[];
  interruptCap(): number;
  asidesAllowed(): boolean;
  generate(req: GenerateRequest): Promise<GeneratedTurn | null>;
  react(turn: GeneratedTurn, motionId: string, allowAside: boolean): Promise<{ reactions: Reaction[]; aside?: { from: string; to: string; text: string } | null }>;
  /** Publish the planned events at speaking pace. Returns whether the turn moved its speaker's stance with a cause. */
  perform(turn: GeneratedTurn, plan: PerformPlan, motionId: string): Promise<{ concession: boolean; words: number }>;
  /** A pause on the performance timeline, persisted. */
  pause(ms: number, reason: 'after_concession' | 'unanswered' | 'tension' | 'chair'): Promise<void>;
  /** The chair on a trigger: one short line. False if he could not speak. */
  chair(reason: string, motionId: string): Promise<boolean>;
  /** Desk and research requests riding on a performed turn. A direction back means the speaker answers the desk next. */
  afterTurn(turn: GeneratedTurn, checkpoint: number, mayCallDesk: boolean): Promise<string | null>;
  /** The belief ledger's chair triggers, one line each, raised once. */
  dynamics(motionId: string): string[];
  /** Research that landed on this motion and nobody has answered yet: who answers it, and what. Each is handed out once. */
  landed(motionId: string): { speaker: string; direction: string } | null;
  /** Persist the floor (and the turn being performed, for a restart mid-performance). */
  save(floor: FloorState, performing: { turn: GeneratedTurn; plan: PerformPlan } | null): void;
  stopped(): boolean;
  endedByUser(): boolean;
  throwIfLimited(): void;
  nameOf(id: string): string;
}

export interface FloorRun {
  motionId: string;
  checkpoint: number;
  boundary: number;
  /** The referee's pressure, for the first turn of the checkpoint. */
  pressure: string | null;
  /** The chair's nudge from the check-in: this person speaks first, answering this. */
  nudge?: { speaker: string; direction: string } | null;
  /** Spoken turns to run before the next checkpoint. */
  turns: number;
  /** Messages (reactions included) the checkpoint may publish under the profile's length (P2); no new turn starts past it. */
  maxMessages?: number;
  /** A turn interrupted by a restart, to perform before anything new is written. */
  performing?: { turn: GeneratedTurn; plan: PerformPlan } | null;
}

export interface FloorResult {
  /** Experts who spoke a turn (not a reaction), in order. */
  spoke: { speaker: string; why: string }[];
  /** Set pieces and replies performed. */
  spokenTurns: number;
  /** Every message published (reactions included). */
  messages: number;
}

/** Turns the room gets to itself after the chair speaks, before heat alone can bring him back. */
const CHAIR_COOLDOWN_TURNS = 6;

/** A whole number of milliseconds, from a seeded range. */
const ms = (floor: FloorState, lo: number, hi: number) => lo + Math.round(rand(floor) * (hi - lo));

const MILESTONE_WORDS: Record<ClockMilestone, string> = {
  half: 'half of this motion\'s slot is gone',
  five_left: 'five minutes are left in this motion\'s slot',
  one_left: 'about a minute is left in this motion\'s slot',
  time: 'this motion\'s slot is used up; the room should land its points so it can be ruled on',
};

/**
 * Run the floor for one checkpoint's worth of spoken turns. Pipelined: the
 * next turn is written while this one is performed, whenever nothing between
 * them (the chair, the desk) could change what the next speaker hears.
 */
export async function runFloor(host: FloorHost, floor: FloorState, run: FloorRun): Promise<FloorResult> {
  const result: FloorResult = { spoke: [], spokenTurns: 0, messages: 0 };
  const motionId = run.motionId;
  let ctx: TurnContext & { forced?: Forced } = { lastSpeaker: lastOf(floor) };
  let forced: Forced | undefined = run.nudge
    ? { forced: true, speaker: run.nudge.speaker, shape: 'reply', words: wordBudget('reply', undefined, 'addressed'), why: 'the chair put a question to you', direction: run.nudge.direction }
    : undefined;
  let pressure = run.pressure;
  let failures = 0;
  let prefetch: { pick: Pick | Forced; promise: Promise<{ turn: GeneratedTurn | null } | { error: unknown }> } | null = null;

  // A restart caught a turn mid-performance: perform it as planned, with no new model call.
  if (run.performing) {
    const { turn, plan } = run.performing;
    const done = await host.perform(turn, plan, motionId);
    host.save(floor, null);
    result.messages += plannedEvents(turn, plan).length;
    result.spokenTurns++;
    result.spoke.push({ speaker: turn.speaker, why: 'picked up where the room stopped' });
    advance(floor, done.words, 0);
    // The turn was booked before the restart; what it set up for the next pick is re-derived from its plan.
    ctx = { lastSpeaker: turn.speaker };
    if (plan.cut?.fight === 'interrupter_takes') {
      forced = { forced: true, speaker: plan.cut.by, shape: 'reply', words: wordBudget('reply', undefined, 'addressed'), why: 'you cut in and won the floor', direction: 'Make the point you cut in to make.' };
    }
  }

  const generate = (pick: Pick | Forced, projected: any[], withPressure: string | null) => host.generate(requestFor(pick, run, projected, withPressure, (id) => host.nameOf(id)));

  const roomFor = () => run.maxMessages === undefined || result.messages < run.maxMessages;
  while (result.spokenTurns < run.turns && roomFor() && !host.stopped() && !host.endedByUser()) {
    host.throwIfLimited();

    // ---- the chair, on a trigger, between turns (never over one) ----
    if (!prefetch) {
      const said = await chairOnTrigger(host, floor, motionId);
      if (said?.forced) forced = said.forced;
      if (said) ctx = { ...ctx, lastSpeaker: 'marcus' };
      if (host.stopped() || host.endedByUser()) break;
      // Research that just landed goes to the person it bears on: a finding nobody has to answer is wasted (2f).
      const landed = forced ? null : host.landed(motionId);
      if (landed) forced = { forced: true, speaker: landed.speaker, shape: 'reply', words: wordBudget('reply', undefined, 'addressed'), why: 'the research desk has just landed something that bears on you', direction: landed.direction };
    }

    // ---- who speaks ----
    const seats = host.seats(motionId);
    if (!seats.length) break;
    const pick: Pick | Forced = forced && seats.some((s) => s.id === forced!.speaker) ? forced : pickNext(floor, seats, ctx);
    forced = undefined;

    // ---- write the turn in full (or collect the one written during the last performance) ----
    let turn: GeneratedTurn | null;
    if (prefetch && prefetch.pick.speaker === pick.speaker) {
      const got: { turn: GeneratedTurn | null } | { error: unknown } = await prefetch.promise;
      if ('error' in got) throw got.error;
      turn = got.turn;
    } else {
      if (prefetch) { const got = await prefetch.promise; if ('error' in got) throw got.error; }
      // The referee's pressure rides on the first turn of the checkpoint only.
      turn = await generate(pick, [], pressure);
    }
    prefetch = null;
    pressure = null;
    if (host.stopped() || host.endedByUser()) break;
    if (!turn) {
      // A lost train of thought: someone else takes it; three in a row and the checkpoint ends.
      if (++failures >= 3) break;
      ctx = { ...ctx, lastSpeaker: pick.speaker };
      continue;
    }
    failures = 0;

    // ---- how the listeners take it, and how it will play ----
    const contested = turn.shape === 'set_piece' || !!turn.to?.length || !!floor.duel;
    const allowAside = host.asidesAllowed() && !floor.asides;
    const { reactions, aside } = contested ? await host.react(turn, motionId, allowAside) : { reactions: [], aside: null };
    const plan = planPerformance(floor, seats, turn, reactions, { interruptCap: host.interruptCap(), aside: allowAside ? aside : null });
    if (plan.aside) floor.asides = 1;
    const next = bookTurn(floor, seats, turn, plan, reactions);
    ctx = next;
    forced = next.forced;
    floor.pending = [{ id: turn.id, speaker: turn.speaker, shape: turn.shape, text: turn.text, performedChars: 0, ...(turn.to ? { to: turn.to } : {}) }];
    host.save(floor, { turn, plan });

    // ---- write the next turn while this one plays, when nothing in between can change it ----
    const deskPending = !!turn.trailer.compute;
    const lastOfSegment = result.spokenTurns + 1 >= run.turns
      || (run.maxMessages !== undefined && result.messages + plannedEvents(turn, plan).length >= run.maxMessages);
    const chairDue = !!chairTrigger(floor);
    if (!deskPending && !lastOfSegment && !chairDue) {
      if (!forced) {
        const landed = host.landed(motionId);
        if (landed) forced = { forced: true, speaker: landed.speaker, shape: 'reply', words: wordBudget('reply', undefined, 'addressed'), why: 'the research desk has just landed something that bears on you', direction: landed.direction };
      }
      const nextPick: Pick | Forced = forced && seats.some((s) => s.id === forced!.speaker) && forced.speaker !== turn.speaker ? forced : pickNext(floor, seats, ctx);
      const projected = plannedEvents(turn, plan);
      prefetch = { pick: nextPick, promise: generate(nextPick, projected, null).then((t) => ({ turn: t }), (error) => ({ error })) };
      // The pick is made; the next iteration replays it rather than scoring again.
      forced = nextPick as Forced;
    }

    // ---- perform ----
    // Paused before a word of it was heard: the room goes quiet now, and the turn (saved above, planned) plays first on Resume with no new model call.
    if (host.stopped()) break;
    const done = await host.perform(turn, plan, motionId);
    floor.pending = [];
    result.spokenTurns++;
    result.messages += plannedEvents(turn, plan).length;
    result.spoke.push({ speaker: turn.speaker, why: pick.why });
    let pauseMs = 0;
    if (plan.tensionMs) pauseMs += plan.tensionMs;
    if (done.concession) {
      const p = ms(floor, 1500, 3000);
      await host.pause(p, 'after_concession');
      pauseMs += p;
    }
    advance(floor, done.words, pauseMs);
    host.save(floor, null);

    // ---- the desk, and research, riding on the turn ----
    const deskAnswer = await host.afterTurn(turn, run.checkpoint, !(pick as Forced).noDesk);
    if (deskAnswer) {
      if (prefetch) { const got = await prefetch.promise; if ('error' in got) throw got.error; prefetch = null; }
      forced = { forced: true, speaker: turn.speaker, shape: 'reply', words: wordBudget('reply', undefined, 'owes'), why: 'the desk has just answered the calculation you asked for', direction: deskAnswer, noDesk: true };
    }
  }
  // A turn written for a checkpoint that ended (a stop, a stall) is dropped unheard: it never reaches an event.
  if (prefetch) await prefetch.promise.catch(() => undefined);
  return result;
}

/**
 * Why someone has the floor, said to them. Describes the situation, never the
 * words to use (prompt de-seeding).
 */
export function directionFor(pick: Pick | Forced, nameOf: (id: string) => string): string {
  if ('forced' in pick) return `${capital(pick.why)}${pick.direction ? `: ${pick.direction}` : '.'}`;
  const p = pick as Pick;
  if (p.owes) return `You owe ${nameOf(p.owes.to)} an answer to "${p.owes.question}". Answer it.`;
  switch (p.why) {
    case 'was put on the spot': return 'You were just put on the spot. Answer what was put to you.';
    case 'answering back': return 'You are in a live exchange with the last speaker. Answer back.';
    case 'opens the motion': return 'You open this motion: make your case.';
    case 'has been quiet and has a case to make': return 'You have been quiet. Bring what your own field says about this.';
    default: return 'Respond to what was just said.';
  }
}

/** What the runner is asked to write for a pick. */
function requestFor(pick: Pick | Forced, run: FloorRun, projected: any[], pressure: string | null, nameOf: (id: string) => string): GenerateRequest {
  return {
    speaker: pick.speaker,
    shape: pick.shape === 'set_piece' ? 'set_piece' : 'reply',
    words: pick.words,
    direction: directionFor(pick, nameOf),
    pressure,
    checkpoint: run.checkpoint,
    boundary: run.boundary,
    projected,
    mayCallDesk: !(pick as Forced).noDesk,
    ...(projected.length ? { replyTo: projected[projected.length - 1].id } : {}),
  };
}

const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Move the meeting clock by what was said and the silences. */
function advance(floor: FloorState, words: number, pauseMs: number) {
  const prev = floor.clock;
  floor.clock = advanceClock(prev, { words, pauseMs });
  const crossed = clockMilestones(prev, floor.clock);
  if (crossed.length) floor.milestones = [...(floor.milestones ?? []), ...crossed];
}

function lastOf(floor: FloorState): string | undefined {
  let best: string | undefined;
  let at = -1;
  for (const [id, t] of Object.entries(floor.lastSpoke)) if (t > at) { at = t; best = id; }
  return best;
}

/**
 * The chair speaks when the room needs him, and only then: a dodge pressed
 * twice, a room too hot, the ledger's herd or unexplained fold, a clock
 * milestone. Returns a forced pick when the trigger puts someone up.
 */
async function chairOnTrigger(host: FloorHost, floor: FloorState, motionId: string): Promise<{ forced?: Forced } | null> {
  /**
   * A light chair: after he speaks, the room gets a few turns to itself before
   * heat alone brings him back (a dodge, the ledger and the clock still can).
   */
  const sinceChair = floor.turn - (floor.chairAt ?? -Infinity);
  const raw = chairTrigger(floor);
  const trig = raw && (raw.kind === 'dodge' || sinceChair >= CHAIR_COOLDOWN_TURNS) ? raw : null;
  // Never two chair lines back to back (a dodge pressed twice is the exception); nothing is consumed meanwhile.
  if (!trig && sinceChair < 2) return null;
  // Read (and so consume) the ledger's triggers only when nothing more urgent is taking the chair's line.
  const dyn = trig ? [] : host.dynamics(motionId);
  const milestones: ClockMilestone[] = floor.milestones ?? [];
  const time = trig || dyn.length ? undefined : milestones.filter((m) => m === 'five_left' || m === 'time').pop();
  if (!trig && !dyn.length) floor.milestones = [];
  let reason: string | null = null;
  let forced: Forced | undefined;
  if (trig?.kind === 'dodge') {
    reason = `${host.nameOf(trig.who)} has been asked "${trig.question.slice(0, 200)}" more than once and has not answered it. Put it to them again, by name, and do not let it slide.`;
    floor.owed = floor.owed.filter((o) => o.from !== trig.who);
    forced = { forced: true, speaker: trig.who, shape: 'reply', words: wordBudget('reply', undefined, 'owes'), why: 'the chair has called out the question you have not answered', direction: trig.question };
    await host.pause(ms(floor, 1200, 2200), 'unanswered');
  } else if (trig?.kind === 'heat') {
    reason = `${host.nameOf(trig.who)} is heated and the exchange has stopped producing anything new. Cool it down and get them to make their actual point.`;
    for (const k of Object.keys(floor.heat)) floor.heat[k] *= 0.6;
  } else if (dyn.length) {
    reason = dyn[0];
  } else if (time) {
    reason = MILESTONE_WORDS[time];
  }
  if (!reason) return null;
  floor.chairAt = floor.turn;
  const ok = await host.chair(reason, motionId);
  if (ok) await host.pause(ms(floor, 900, 1600), 'chair');
  return ok ? { forced } : forced ? { forced } : null;
}

/**
 * Before a ruling: anyone the crux turns on who has not spoken on this motion
 * gets one short turn (the relevance rule: never left silent). Returns the
 * turns run.
 */
export async function windDown(host: FloorHost, floor: FloorState, run: Omit<FloorRun, 'turns' | 'pressure' | 'nudge'>): Promise<FloorResult> {
  const silent = host.seats(run.motionId).filter((s) => s.relevant && floor.lastSpoke[s.id] === undefined);
  const result: FloorResult = { spoke: [], spokenTurns: 0, messages: 0 };
  if (!silent.length) return result;
  await host.chair(`the motion is about to be ruled on and ${silent.map((s) => host.nameOf(s.id)).join(' and ')} ${silent.length === 1 ? 'has' : 'have'} not been heard on it, though the decision turns on what they know. Ask for their read before ruling.`, run.motionId);
  for (const s of silent) {
    if (host.stopped() || host.endedByUser()) break;
    const r = await runFloor(host, floor, {
      ...run, turns: 1, pressure: null,
      nudge: { speaker: s.id, direction: 'Before the ruling: where do you land on this motion, and what in your own field decides it?' },
    });
    result.spoke.push(...r.spoke);
    result.spokenTurns += r.spokenTurns;
    result.messages += r.messages;
  }
  return result;
}

export { DIRECTOR_RULES };
