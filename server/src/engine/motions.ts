import crypto from 'node:crypto';
import { CFG } from '../config.ts';
import { Events } from '../db.ts';
import { runJsonAgent, throwIfLimited } from '../agents/sdk.ts';
import {
  refereeSystem, refereePrompt, rungPressure,
  motionRulingPrompt, marcusSteerPrompt, marcusVoice,
} from '../agents/prompts.ts';
import { claimsRecord, formatEvents } from './transcript.ts';
import { NoveltyLedger, staleRun } from './novelty.ts';
import { rulingGrade } from '../realism/evidence.ts';
import { WASTE, adversaryTurns, checkpointTurns, type LengthSpec } from '../../../shared/budget.ts';
import { DEPTH, RUNGS, type AgendaItem, type Decision, type FloorState, type Persona, type StageActor } from '../../../shared/types.ts';
import type { Seat } from '../../../shared/models.ts';
import { checkpointSize } from './director.ts';
import type { FloorResult, FloorRun, GeneratedTurn, PerformPlan } from './floor.ts';

const rid = (p: string) => `${p}_${crypto.randomBytes(6).toString('base64url')}`;

/**
 * The depth engine.
 *
 * v1 alternated Marcus and one expert, so seven motions produced sixteen expert
 * contributions: a moderator interviewing people. Here a motion is opened and
 * argued in ROUNDS of several experts speaking back to back with no moderator
 * between them. After each round a cheap referee call judges whether genuinely
 * new argument appeared. Two dry rounds and the motion is ruled on with a
 * written, owned decision. Marcus steers between rounds only.
 */

export interface MotionState {
  motionId: string;
  index: number;
  round: number;
  messages: number;
  dryStreak: number;
  claims: string[];        // every fresh argument on the record for this motion
  unresolved: string[];
  positionChanges: string[];
  startSeq: number;
  rung: number;          // depth ladder position, 0-4
  /** The adversary desk has already attacked this motion's ruling once. */
  redTeamed?: boolean;
  /** Spoken turns in a row that repeated the room (novelty.ts). Absent on checkpoints from before the guard. */
  staleRun?: number;
  /** The floor director's state (2b-7): heat, owed answers, duels, the clock. Absent on round-engine checkpoints. */
  floor?: FloorState;
  /** A turn written and planned but not yet fully heard: a restart performs it, with no new model call. */
  performing?: { turn: GeneratedTurn; plan: PerformPlan } | null;
  /**
   * Where the motion stands, so a pause or a restart comes back to the exact
   * step (P4). In the real run of 2026-10-28 a founder pause during the
   * adversary's round ran straight on into "motion closed": the ruling under
   * attack was kept as final, the checkpoint was cleared and Resume opened the
   * next motion. Every step below is persisted before the next one starts, and
   * a pause never moves a motion past the step it was on.
   *
   *   open       a checkpoint that has started (round counted, chair checked
   *              in) and whose floor or referee has not finished
   *   pressure   what the referee wants pushed at the next checkpoint
   *   closing    the argument is over and why: next come the wind-down and the ruling
   *   ruling     the ruling as it stands: next comes the adversary desk
   *   challenge  the adversary's defeaters, while the room answers them
   */
  open?: OpenCheckpoint | null;
  pressure?: string | null;
  closing?: CloseReason | null;
  ruling?: Decision | null;
  challenge?: { numbered: string; boundary: number; turns: number; spoken: number } | null;
}

/** A checkpoint in progress (P4). */
export interface OpenCheckpoint {
  boundary: number;
  /** Spoken turns asked of this checkpoint, and how many have been heard. */
  turns: number;
  spoken: number;
  /** Messages this checkpoint may still publish under the profile's length (absent: no limit), and how many it has. */
  maxMessages?: number;
  messages: number;
  pressure: string | null;
  nudge: { speaker: string; direction: string } | null;
  /** The floor has run; the referee is next. */
  floorDone?: boolean;
}

/** One concrete way a ruling is wrong, per the adversary desk. */
export interface Defeater {
  claim: string;
  arithmetic: string;
  consequence: string;
  severity: 'fatal' | 'material' | 'minor';
}

export interface RefereeVerdict {
  fresh: string[];
  positionChanges: string[];
  unresolved: string[];
  rung: number;
  rungReason: string;
  missing: { discipline: string; why: string } | null;
  readyToDecide: boolean;
  nextPressure: string | null;
  momentum: 'climbing' | 'circling' | 'exhausted';
  /** The referee call itself failed; nothing here is a judgment of the round. */
  failed?: boolean;
}

/** Host capabilities the motion loop needs from the runner. */
export interface MotionHost {
  id: string;
  model: string;
  personas: Persona[];
  experts: Persona[];
  goal: string;
  topic: string;
  contextBrief: string | null;
  config: { mode: string; autonomy: string };
  marcusSession: string | undefined;
  /** Which model runs a given job. Marcus casts these; see runner.modelFor. */
  modelFor(seat: Seat): string;
  /** The human in the room, by name. */
  founder(): string;
  setMarcusSession(id: string): void;
  publish(ev: any): void;
  publishMarcus(text: string): void;
  system(text: string): void;
  /**
   * The live floor (2b-7): run one checkpoint's worth of turns through the
   * floor director, generate-then-perform, with cut-offs, talking over and
   * pauses as events. Replaces the round of three scheduled speakers.
   */
  floor(st: MotionState, run: Omit<FloorRun, 'performing'>): Promise<FloorResult>;
  /** Before a ruling: anyone the crux turns on who has not been heard on this motion gets one short turn. */
  windDown(st: MotionState, checkpoint: number, boundary: number): Promise<FloorResult>;
  /** A fresh floor for a motion, seeded so a replay of the same session makes the same choices. */
  newFloor(motionId: string): FloorState;
  research(question: string): void;
  /** Research that landed on this motion since the last steer, as lines for the chair. Consumed on read. */
  landedResearch(motionId: string): string[];
  /** Wait (bounded) for research still out on this motion; returns the questions still pending. */
  pendingResearch(motionId: string): Promise<string[]>;
  /**
   * Send an arithmetic question to the quant desk and WAIT for it. Research is
   * fired and forgotten because an outside fact keeps its value; a computed
   * figure only has value if it lands before the next person speaks about it.
   */
  compute(question: string, motionId: string | null): Promise<void>;
  /**
   * Marcus revising the agenda mid-session: add a motion the argument revealed
   * is necessary, drop one it made irrelevant. Only the changed items are sent;
   * the runner merges them, and refuses to drop a closed motion or the one on
   * the floor.
   */
  revisePlan(update: { items?: any[]; rationale?: string }): void;
  /**
   * Put an already-ruled motion back on the agenda because this argument broke
   * its premise. Vacates the old ruling. Capped at one reopen per motion; a
   * second attempt is recorded as a standing objection instead.
   */
  reopen(motionId: string, because: string): void;
  /** The agenda as it stands, so the chair can see what he is changing. */
  agenda(): { id: string; title: string; status: string }[];
  /** Motions already ruled, so a reopen can name one. */
  settled(): { id: string; title: string }[];
  /** Motions already reopened once. */
  reopened(): string[];
  /** Questions already computed this session, so the chair does not re-ask. */
  computations(): { question: string; answer: string; computable: boolean }[];
  /** Whether there is a dossier to compute against at all. */
  hasFiles(): boolean;
  /**
   * The adversary desk: independent seats that read a finished ruling cold,
   * with the files when the room has an interpreter, under one instruction,
   * prove it wrong. Returns the merged concrete defeaters, or [] when the
   * ruling holds (or the desk itself failed; an adversary crash must never
   * take the session with it).
   */
  redTeam(decision: Decision, motionTitle: string, motion: string): Promise<Defeater[]>;
  /** The shared room record frozen at `boundarySeq`; see buildRoomBlocks. */
  room(boundarySeq: number): { system: string; roundSoFar: string };
  /** Persist the open motion's state after each round; null clears it. */
  checkpoint(st: MotionState | null): void;
  /** The persisted state of this motion, if a restart interrupted it. */
  restore(motionId: string): MotionState | null;
  /**
   * How long this motion may run, from the scope the founder approved.
   * `target` is the minimum before the dry check may close it; `ceiling` is
   * the hard stop. Both are per-session, not per-build.
   */
  rounds(): { target: number; ceiling: number };
  /** The profile's session length (P2), or null for a debate from before profiles: it runs on the old backstops. */
  length(): LengthSpec | null;
  /** Messages this motion may still take on the floor under the profile's length; Infinity without one. */
  remaining(st: MotionState): number;
  /** Seat a new expert mid-session to fill a discipline gap. */
  summon(discipline: string, why: string, motion: string): Promise<boolean>;
  askUser(q: any): Promise<'answered' | 'ended'>;
  researchInflight(): number;
  stopped(): boolean;
  endedByUser(): boolean;
  /**
   * Announce that the room is working on something that is not speech.
   * Most of a motion is exactly that, and without this the UI shows nothing
   * for a minute at a time and reads as a hang.
   */
  stage(actor: StageActor, label: string, detail?: string): { think(t: string): void; close(): void };
  /**
   * The founder's own dollar ceiling, if they set one. Called between rounds;
   * at the ceiling it waits for them to extend it or to stop (which sets
   * endedByUser). Spend never shortens or thins the argument by itself.
   */
  ceiling(): Promise<void>;
  /** Thinking tokens for a seat, sized by the budget profile. */
  thinking(kind: 'referee' | 'steer' | 'heavy'): number;
  /**
   * The belief ledger (2b-5). All no-ops on a debate without one.
   *   open        starting stances when a motion opens (one clerk call)
   *   moves       stance moves nobody explained, for the referee
   *   attribute   the referee's cause for one of those moves
   *   checkpoint  after each referee pass: herd and drift detection
   *   dynamics    what the chair should act on, one line each, raised once
   */
  minds: {
    open(motionId: string, motion: string): Promise<void>;
    moves(motionId: string): { ref: string; expert: string; from: string; to: string; candidates: string[] }[];
    attribute(motionId: string, ref: string, cause: string, source: string): void;
    checkpoint(motionId: string): void;
    dynamics(motionId: string): string[];
  };
  /** The session's stakes as the ruling states them (owner, cost of a wrong yes and no), or null. */
  rulingStakes(): { owner: string; costYes: string; costNo: string } | null;
}

/** Why a motion stopped being argued. The ruling is told the truth about it. */
export type CloseReason = 'merits' | 'stuck' | 'ceiling' | 'ended' | 'no-speaker' | 'budget';

export function motionOf(item: AgendaItem): string {
  return (item.motion && item.motion.trim()) || `${item.title}. ${item.detail}`.trim();
}

/** Judge a round. Cheap, personaless, structured. */
export async function refereeRound(
  host: MotionHost,
  motion: string,
  roundText: string,
  priorClaims: string[],
  rung: number,
  motionIdOf?: string
): Promise<RefereeVerdict> {
  const roster = host.experts.map((e) => `- ${e.name}: ${e.role}`).join('\n');
  const st = host.stage(
    'referee',
    'The referee is judging the round',
    `Deciding what was genuinely new, and whether the argument climbed past ${RUNGS[rung]?.name ?? 'assertion'}.`
  );
  const motionId = motionIdOf ?? '';
  const moves = motionId ? host.minds.moves(motionId) : [];
  try {
    const { value } = await runJsonAgent<any>({
      model: host.modelFor('referee'),
      system: refereeSystem(),
      prompt: refereePrompt(motion, roundText, priorClaims, roster, rung, moves),
      onThinking: (t) => st.think(t),
      thinking: host.thinking('referee'),
      /**
       * The full turn budget, not a fraction of it. This was 180s from the era
       * of the 4K-thinking referee; at 32K the seat that decides whether every
       * motion lives or dies routinely needs longer, and a timed-out referee
       * degrades to a no-verdict round in which dryness cannot be detected.
       */
      timeoutMs: CFG.turnTimeoutMs,
      debateId: host.id,
      label: 'referee',
    });
    const m = value.missing_expertise;
    // The referee's causes for moves nobody explained; "unexplained" stays unexplained.
    for (const c of Array.isArray(value.move_causes) ? value.move_causes : []) {
      if (moves.some((x) => x.ref === String(c?.ref ?? ''))) host.minds.attribute(motionId, String(c.ref), String(c.cause ?? ''), String(c.source ?? ''));
    }
    return {
      fresh: (value.fresh_arguments ?? []).map(String).slice(0, 12),
      positionChanges: (value.position_changes ?? []).map(String).slice(0, 6),
      unresolved: (value.unresolved ?? []).map(String).slice(0, 8),
      // The ladder never slides backwards: depth already reached is banked.
      rung: Math.max(rung, Math.min(4, Math.max(0, Number(value.rung) || 0))),
      rungReason: String(value.rung_reason ?? ''),
      missing: m && m.discipline ? { discipline: String(m.discipline), why: String(m.why ?? '') } : null,
      readyToDecide: value.ready_to_decide === true,
      nextPressure: value.next_pressure ? String(value.next_pressure) : null,
      momentum: ['climbing', 'circling', 'exhausted'].includes(value.momentum) ? value.momentum : 'climbing',
    };
  } catch {
    throwIfLimited(host.id);   // a spent allowance pauses the session; it is not a failed referee
    // A failed referee must never stall or prematurely close a motion, and it
    // must never bank a placeholder as if it were a claim from the round.
    return { fresh: [], positionChanges: [], unresolved: [], rung, rungReason: '', missing: null, readyToDecide: false, nextPressure: null, momentum: 'climbing', failed: true };
  } finally {
    st.close();
  }
}

/**
 * Argue one motion to exhaustion. Returns the written decision, or null if the
 * session was stopped or paused mid-motion (everything argued so far is in the
 * checkpoint, and the next call carries on from the step it was on).
 */
export async function runMotion(
  host: MotionHost,
  item: AgendaItem,
  index: number,
  total: number
): Promise<Decision | null> {
  const motion = motionOf(item);
  const restored = host.restore(item.id);
  const st: MotionState = restored ?? {
    motionId: item.id,
    index,
    round: 0,
    messages: 0,
    dryStreak: 0,
    claims: [],
    unresolved: [],
    positionChanges: [],
    startSeq: Events.lastSeq(host.id),
    rung: 0,
  };

  if (restored) {
    host.system(
      restored.challenge ? `Resuming "${item.title}" in the adversary's round: the ruling stays on hold until the room has answered the defeaters.`
        : restored.ruling ? `Resuming "${item.title}" with its ruling: the adversary desk is next.`
          : restored.closing ? `Resuming "${item.title}": the argument is over and the ruling is next.`
            : `Resuming "${item.title}" at round ${restored.open ? restored.round : restored.round + 1}: the ${restored.open ? restored.round - 1 : restored.round} round${(restored.open ? restored.round - 1 : restored.round) === 1 ? '' : 's'} already argued stand.`
    );
  } else {
    host.publish({ type: 'motion_open', motionId: item.id, index, total, title: item.title, motion });
    // Persisted at once, so a pause before the first checkpoint does not open the motion twice.
    host.checkpoint(st);
  }
  // Starting stances (a no-op when they exist or the debate has no ledger).
  await host.minds.open(item.id, motion);

  /**
   * The floor director's state for this motion. A checkpoint from the round
   * engine (before 2b-7) has none; the motion carries on with a fresh floor.
   */
  st.floor = st.floor ?? host.newFloor(item.id);

  if (!st.closing && !st.ruling) {
    const reason = await argue(host, item, motion, st);
    if (reason === null) { host.checkpoint(st); return null; }
    st.closing = reason;
    st.open = null;
    host.checkpoint(st);
  }
  if (host.stopped()) return null;
  const closeReason = st.closing ?? 'merits';

  if (!st.ruling) {
    /**
     * Wind-down: before the chair rules, anyone the crux turns on who has not
     * been heard on this motion gets one short turn (the relevance rule). Not
     * when the founder ended the session: they asked for the write-up now.
     * It asks only who is still unheard, so a pause in the middle of it picks
     * up with whoever is left.
     */
    if (closeReason !== 'ended' && !host.endedByUser()) {
      const wd = await host.windDown(st, st.round, Events.lastSeq(host.id));
      st.messages += wd.messages;
      if (host.stopped()) { host.checkpoint(st); return null; }
    }

    /**
     * A motion is not ruled while research on it is still out, unless the
     * founder ended it (including stopping at their own ceiling): then it rules
     * on what exists and the ruling says the evidence was pending.
     */
    const pending = closeReason === 'ended' ? [] : await host.pendingResearch(item.id);
    if (host.stopped()) return null;

    // ---- rule on it ----
    const transcript = formatEvents(Events.since(host.id, st.startSeq), host.personas).slice(-24_000);
    st.ruling = await rule(host, item, motion, transcript, st, null, closeReason, pending);
    host.checkpoint(st);
    // A ruling written while the founder paused is kept; the adversary desk waits for Resume.
    if (host.stopped()) return null;
  }

  /**
   * The ruling is a defendant, not a verdict. Before it commits, adversaries
   * who were never in the room attack it under instruction to prove it wrong;
   * anything concrete they land buys the room one more round and a re-ruling
   * that must answer each defeater or fall. Run three times against a shipped
   * report, this seat found the transposed bridge that the full panel, the
   * referee, the desk, the chair AND the numbers audit had all signed off on.
   */
  const finalDecision = await adversaryChallenge(host, item, motion, st);
  // Paused (or stopped) before the desk and the room were done with it: the motion stays open.
  if (!finalDecision) { if (!host.stopped()) host.checkpoint(st); return null; }
  host.checkpoint(null);
  host.publish({ type: 'motion_closed', motionId: item.id, rounds: st.round, messages: st.messages });
  return finalDecision;
}

/** A checkpoint is not started with less than this left in the motion's length: a ruling is worth more than two more lines. */
const MIN_CHECKPOINT_MESSAGES = 4;

/**
 * The argument itself: checkpoints of live floor, each judged by the referee,
 * until the motion closes. Returns why it closed, or null when the session
 * was stopped or paused (the open checkpoint is in `st` and resumes as it was).
 */
async function argue(host: MotionHost, item: AgendaItem, motion: string, st: MotionState): Promise<CloseReason | null> {
  /**
   * The round budget, and why a ceiling is not optional.
   *
   * A motion used to run until the referee found nothing new, capped at 16. On
   * a sixteen-expert panel that cap became the norm: more people in the room
   * means more genuinely novel angles per round, so dryness never arrives and
   * every motion runs to the ceiling. The live session that prompted this was
   * spending seventy-four messages a motion. Panel size therefore has to buy a
   * round budget too, or widening the panel silently lengthens the session as
   * well as the bill. Since P2 the profile states the length as well (`len`).
   */
  const budget = host.rounds();
  const len = host.length();
  const floor = st.floor!;
  let summoned = false; // at most one expert may be seated per motion

  // A checkpoint from before P4 caught mid-performance: it carries on inside the checkpoint it interrupted.
  if (!st.open && st.performing) {
    st.open = { boundary: Events.lastSeq(host.id), turns: checkpointSize(floor), spoken: 0, messages: 0, pressure: null, nudge: null };
  }

  /**
   * The live floor. A "round" is now a CHECKPOINT: six to eight spoken turns
   * picked by the floor director (who was put on the spot, who is in a fight,
   * who cannot let something stand), then the referee. The chair checks in at
   * each checkpoint and otherwise speaks only on a trigger.
   */
  while (true) {
    if (host.stopped()) return null;
    if (!st.open) {
      // The founder's ceiling, if any: they extend it or choose to stop. Nothing else about money is checked here.
      throwIfLimited(host.id);
      await host.ceiling();
      if (host.stopped()) return null;
      if (host.endedByUser()) return 'ended';
      const remaining = host.remaining(st);
      if (len) {
        // The profile's length (P2): the motion is ruled when its rounds or its share of the session's messages are spent.
        if (st.round >= budget.ceiling || remaining < MIN_CHECKPOINT_MESSAGES) return 'budget';
      } else if (st.round >= budget.ceiling || st.messages >= DEPTH.maxMessagesPerMotion) return 'ceiling';

      st.round++;
      const boundary = Events.lastSeq(host.id);
      // ---- the chair checks in (from the second checkpoint; light, often silent) ----
      const nudge = st.round > 1 ? await checkIn(host, motion, st, st.pressure ?? null) : null;
      const planned = checkpointSize(floor);
      st.open = {
        boundary, spoken: 0, messages: 0, pressure: st.pressure ?? null, nudge,
        // The floor director is asked for what fits the motion's length, and stops at its message budget.
        turns: len ? checkpointTurns(planned, remaining) : planned,
        ...(len ? { maxMessages: remaining } : {}),
      };
      st.pressure = null;
      host.checkpoint(st);
      if (host.stopped()) return null;
    }
    const cp = st.open;

    if (!cp.floorDone) {
      // ---- the floor: who speaks is the director's call, turn by turn ----
      const first = cp.spoken === 0;
      const res = await host.floor(st, {
        motionId: item.id, checkpoint: st.round, boundary: cp.boundary,
        pressure: first ? cp.pressure : null, nudge: first ? cp.nudge : null,
        turns: cp.turns - cp.spoken,
        ...(cp.maxMessages !== undefined ? { maxMessages: cp.maxMessages - cp.messages } : {}),
      });
      cp.spoken += res.spokenTurns;
      cp.messages += res.messages;
      st.messages += res.messages;
      host.publish({
        type: 'floor_set',
        motionId: item.id,
        round: st.round,
        why: res.spoke.length
          ? `Nobody scheduled these turns: the floor went to whoever the moment called for. ${res.spoke.slice(0, 8).map((s) => `${host.personas.find((p) => p.id === s.speaker)?.name ?? s.speaker} ${s.why.replace(/^you /, '')}`).join('; ')}.`
          : 'Nobody could take the floor.',
        slate: res.spoke.slice(0, 8).map((s) => ({ speaker: s.speaker, direction: s.why })),
      });
      // Silent seats because the allowance ran out are a pause, not a quiet round.
      throwIfLimited(host.id);
      // A pause stops the floor between turns: the checkpoint resumes with the turns it still owes.
      if (host.stopped()) { host.checkpoint(st); return null; }
      if (!cp.spoken) { st.open = null; return 'no-speaker'; } // nobody could speak: bail rather than spin
      cp.floorDone = true;
      host.checkpoint(st);
    }

    // ---- referee the round ----
    // The judge view: each turn's graded claims beside it, or rung 2 is unreachable.
    const roundText = formatEvents(Events.since(host.id, cp.boundary), host.personas, host.founder(), { judge: true });
    const verdict = await refereeRound(host, motion, roundText, st.claims, st.rung, item.id);
    host.minds.checkpoint(item.id);
    st.claims.push(...verdict.fresh);
    // An honest empty list CLEARS old unresolved items (the room answered
    // them); only a failed referee call leaves the previous list standing.
    st.unresolved = verdict.failed ? st.unresolved : verdict.unresolved;
    st.positionChanges.push(...verdict.positionChanges);
    const climbed = verdict.rung > st.rung;
    st.rung = verdict.rung;

    // Push the room up the ladder; the referee's own question wins if it has one.
    st.pressure = verdict.nextPressure ?? rungPressure(st.rung);

    /**
     * What "dry" means, and why it is not just an empty list.
     *
     * The first live session ran every motion to the same fixed length, because
     * the referee always found SOMETHING to list and `fresh.length === 0` was
     * therefore never true: both dry-based exit conditions were dead code and
     * the room argued a settled motion exactly as long as a live one. The
     * referee now reports momentum separately, and an exhausted motion ends
     * whether or not the last round happened to produce a line worth logging.
     */
    // A no-verdict round (referee failed) is not evidence of dryness; it is
    // evidence of nothing, so the streak neither grows nor resets.
    const dry = !verdict.failed && (verdict.fresh.length === 0 || verdict.momentum === 'exhausted');
    if (!verdict.failed) st.dryStreak = dry ? st.dryStreak + 1 : 0;
    // The repetition guard: turns that only restate the room, counted in a row (novelty.ts).
    const spoken = (from: number, to = Infinity) => Events.since(host.id, from)
      .filter((e): e is Extract<typeof e, { type: 'message' }> => e.type === 'message' && e.seq <= to && (e.kind === 'floor' || e.kind === 'interjection' || e.kind === 'reaction'))
      .map((e) => e.text);
    st.staleRun = staleRun(st.staleRun ?? 0, spoken(cp.boundary), new NoveltyLedger(spoken(st.startSeq, cp.boundary)));
    st.open = null;
    host.checkpoint(st);
    host.publish({
      type: 'round',
      motionId: item.id,
      round: st.round,
      freshArguments: verdict.fresh.length,
      rung: st.rung,
      rungName: RUNGS[st.rung]?.name,
      note: climbed
        ? `Argument reached ${RUNGS[st.rung]?.name}. ${verdict.rungReason}`
        : verdict.momentum === 'exhausted'
          ? 'The referee calls this motion argued out.'
          : verdict.fresh.length === 0
            ? 'No new argument this round.'
            : verdict.momentum === 'circling'
              ? `Circling: ${verdict.fresh[0]}`
              : verdict.fresh[0],
    });

    // A gap the seated panel cannot close is filled by seating someone who can (not while the founder has paused the room).
    if (verdict.missing && !summoned && !host.stopped()) {
      summoned = await host.summon(verdict.missing.discipline, verdict.missing.why, motion);
    }

    // Depth gate: a motion cannot close on silence alone, only on a real climb.
    const enoughRounds = st.round >= budget.target;
    const deepEnough = st.rung >= (len?.minRungToClose ?? DEPTH.minRungToClose);
    if (len?.closeOnNoSubstance) {
      /**
       * A profile with a stated length (P2). Past the round target the motion
       * is ruled as soon as the crux is settled or a checkpoint brings no new
       * substance: the referee says the room is circling or argued out, or it
       * found nothing new. Circling was the real run's whole second half on
       * Quick: five checkpoints of "the same five points, again". A motion
       * that has not climbed far enough is recorded honestly as stuck.
       */
      const settled = !verdict.failed && verdict.readyToDecide;
      const noSubstance = !verdict.failed && (verdict.fresh.length === 0 || verdict.momentum !== 'climbing');
      if (enoughRounds && (settled || noSubstance)) return deepEnough ? 'merits' : 'stuck';
    } else {
      /**
       * The escape hatch, and it needs a floor under it.
       *
       * `stuck` bypasses the depth gate so a motion nobody can move cannot run to
       * the 16-round ceiling. That was harmless while `dry` could never be true,
       * because the branch was unreachable. Now that the referee can call a motion
       * exhausted, three such calls in a row would close a motion at round 3 with
       * the argument still at assertion, and Marcus would write a confident ruling
       * on nothing. Exhaustion now has to persist past the minimum before it can
       * end anything.
       */
      const stuck = st.dryStreak >= DEPTH.dryRoundsToClose + 1
        && st.round >= budget.target + 2;
      const merits = deepEnough && (st.dryStreak >= DEPTH.dryRoundsToClose || verdict.readyToDecide);
      if (enoughRounds && (merits || stuck)) return merits ? 'merits' : 'stuck';
    }
    /**
     * A real stalemate: the room has said the same things in the same words
     * for several turns running. Another round would buy only more of it, so
     * the deadlock is recorded and ruled (the ruling is told the room got
     * stuck, not done). This is the waste guard on argument; spend is not.
     */
    if ((st.staleRun ?? 0) >= WASTE.staleTurnsToClose) {
      host.system(`The last ${st.staleRun} turns on "${item.title}" repeated what the room had already said. Recording a stalemate and ruling on it.`);
      return 'stuck';
    }
  }
}

/**
 * One adversary pass per motion: attack the ruling, and if anything concrete
 * lands, give the room a round to answer it and make the chair re-rule with
 * the defeaters in front of him. Unanswered defeaters do not disappear, they
 * become dissents on the record under the adversary's name.
 *
 * Returns the final decision, or null when the founder paused (or the session
 * stopped) before it was done: the ruling, `redTeamed` and the defeaters stay
 * in the checkpoint, and the next call carries on from that step. A pause here
 * used to return the ruling under attack as final and close the motion.
 */
async function adversaryChallenge(
  host: MotionHost,
  item: AgendaItem,
  motion: string,
  st: MotionState
): Promise<Decision | null> {
  const decision = st.ruling!;
  if (!st.challenge) {
    if (st.redTeamed || host.endedByUser()) return decision;
    if (host.stopped()) return null;
    const defeaters = await host.redTeam(decision, item.title, motion);
    throwIfLimited(host.id);   // an adversary silenced by a spent allowance is not an adversary that found nothing
    // The desk has read it, whatever it found: a resume never sends it in twice.
    st.redTeamed = true;
    if (!defeaters.length) { host.checkpoint(st); return host.stopped() ? null : decision; }

    const numbered = defeaters
      .map((d, i) => `${i + 1}. ${d.claim}${d.arithmetic ? ` The arithmetic: ${d.arithmetic}` : ''} If it stands: ${d.consequence}`)
      .join('\n');
    host.publishMarcus(
      `Hold the ruling on "${item.title}". My ruling was: ${decision.decision} The adversary desk read it cold, under one instruction, prove it wrong, and it came back with something concrete:\n\n${numbered}\n\nOne more round. Answer these on the merits or the ruling changes.`
    );
    st.round++;
    // One checkpoint of live floor on the defeaters: as many turns as there are experts, at least four.
    st.challenge = { numbered, boundary: Events.lastSeq(host.id), turns: adversaryTurns(host.experts.length), spoken: 0 };
    host.checkpoint(st);
  }
  const ch = st.challenge;
  if (host.endedByUser()) return decision;
  if (host.stopped()) return null;

  if (ch.spoken < ch.turns) {
    const pressure = `The adversary desk's defeaters, which this exchange exists to answer:\n${ch.numbered}`;
    const res = await host.floor(st, { motionId: item.id, checkpoint: st.round, boundary: ch.boundary, pressure, nudge: null, turns: ch.turns - ch.spoken });
    ch.spoken += res.spokenTurns;
    st.messages += res.messages;
    host.checkpoint(st);
    if (host.endedByUser()) return decision;
    // A pause stops the floor between turns: the adversary's round resumes with the turns it still owes.
    if (host.stopped()) return null;
    ch.spoken = ch.turns;   // the floor ran its course (or nobody could speak): the re-ruling is next
    host.checkpoint(st);
  }

  const final = await rule(host, item, motion, '(the record above, including the adversary round)', st, ch.numbered, 'merits', await host.pendingResearch(item.id));
  st.ruling = final;
  st.challenge = null;
  host.checkpoint(st);
  return host.stopped() ? null : final;
}

/**
 * The chair's check-in at a checkpoint. He no longer hands out a slate: the
 * floor director decides who speaks. He may say one short thing, nudge one
 * person who is dodging or left out, send research or the desk, change the
 * agenda, or ask the founder. Returns the nudge, if any.
 */
async function checkIn(
  host: MotionHost,
  motion: string,
  st: MotionState,
  pressure: string | null
): Promise<{ speaker: string; direction: string } | null> {
  /**
   * Stateless chair. The check-in runs at a checkpoint, so the whole argument
   * is already in the frozen record: his call presents the same system prompt
   * the next checkpoint's turns will present, which means HE writes that
   * boundary's cache entry and every expert after him reads it at a tenth of
   * the price.
   */
  // +1: boundary is exclusive (frozen = seq < boundary), so without it the
  // most recent speech in the record was invisible to this call.
  const room = host.room(Events.lastSeq(host.id) + 1);
  const stage = host.stage(
    'marcus',
    'Marcus is checking the room',
    `Checkpoint ${st.round}. Is anyone dodging, left out, or arguing about a number nobody has checked?`
  );
  try {
    const { value } = await runJsonAgent<any>({
      /**
       * The FLOOR's model, not the chair's — a cost invariant, not a taste.
       *
       * The note above is the whole design: this call presents `room.system`,
       * byte-identical to what every floor turn in the coming round presents,
       * so it is the call that WRITES the round-boundary cache entry the room
       * then reads at a tenth of the price. Caches are keyed PER MODEL. Running
       * the steer on the chair while the floor runs on Sonnet wrote that whole
       * prefix twice every round, at 1.25x each, with nobody able to read
       * either copy cheaply — it quietly defeated the one mechanism the
       * architecture was built around. Do not give this a seat of its own:
       * casting it independently is exactly how this re-breaks.
       */
      model: host.modelFor('floor'),
      system: room.system,
      prompt: [
        marcusVoice(host.config as any, host.founder()),
        marcusSteerPrompt({
          motion,
          round: st.round,
          delta: '',
          bids: null,
          unresolved: st.unresolved,
          pressure,
          researchInflight: host.researchInflight(),
          landed: host.landedResearch(st.motionId),
          slots: 0,
          hasFiles: host.hasFiles(),
          computed: host.computations().map((c) => c.question),
          agenda: host.agenda(),
          settled: host.settled(),
          reopened: host.reopened(),
          dynamics: host.minds.dynamics(st.motionId),
        }),
      ].join('\n\n'),
      onThinking: (t) => stage.think(t),
      thinking: host.thinking('steer'),
      debateId: host.id,
      label: 'marcus:steer',
    });

    if (value.say) host.publishMarcus(String(value.say));
    if (value.research && host.researchInflight() < CFG.maxInflightResearch) host.research(String(value.research));
    /**
     * Blocking on purpose. The desk exists to put a computed number in front of
     * the next speaker; letting the round proceed while it works would give the
     * room one more turn of arguing about the very figure being measured, which
     * is the failure this whole mechanism was built to end.
     */
    if (value.compute && host.hasFiles()) {
      stage.close();
      await host.compute(String(value.compute), st.motionId);
    }
    /**
     * The agenda is live from here on. It was drafted before anyone had spoken
     * and then frozen for the whole session, because the only code that could
     * revise it hung off a function nothing called.
     */
    if (value.plan_update) host.revisePlan(value.plan_update);
    /**
     * A ruling this argument has since destroyed goes back on the floor. The
     * reopened motion is not argued now: the room finishes what it is on, and
     * the meeting loop finds the reopened one next because it sits earlier in
     * the agenda than anything still pending.
     */
    if (value.reopen?.motionId) {
      host.reopen(String(value.reopen.motionId), String(value.reopen.because ?? ''));
    }
    if (value.assumption && host.config.autonomy === 'autonomous') {
      host.publish({ type: 'assumption', text: String(value.assumption) });
    }
    if (value.ask_user && host.config.autonomy === 'interactive') {
      const r = await host.askUser(value.ask_user);
      if (r === 'ended') return null;
    }

    const n = value.nudge;
    if (n && host.experts.some((e) => e.id === String(n.speaker ?? '')) && String(n.direction ?? '').trim()) {
      return { speaker: String(n.speaker), direction: String(n.direction).trim().slice(0, 400) };
    }
  } catch {
    throwIfLimited(host.id);
    // A silent check-in is the normal case anyway: the room carries on under the director.
  } finally {
    stage.close();
  }
  return null;
}

async function rule(
  host: MotionHost,
  item: AgendaItem,
  motion: string,
  transcript: string,
  st: MotionState,
  /** The adversary's defeaters, when this is the re-ruling after their round. */
  mandate?: string | null,
  /** Why the argument stopped. Anything but 'merits' must be said in the ruling. */
  closeReason: CloseReason = 'merits',
  /** Research questions on this motion still unanswered when it went to ruling. */
  pendingResearch: string[] = []
): Promise<Decision> {
  const fallback: Decision = {
    motionId: item.id,
    motionTitle: item.title,
    decision: 'Undecidable in session: the ruling could not be recorded.',
    owner: 'Founder',
    rationale: 'The moderator failed to produce a ruling for this motion.',
    evidence: 'assumed',
    dependsOn: [],
    dissents: [],
    undecidable: { question: motion, evidenceNeeded: 'Re-run this motion', who: 'Founder' },
  };

  // The longest silence in the whole session: Marcus reads the entire motion
  // back and writes an owned decision with dissents. Minutes, historically blank.
  const stage = host.stage(
    'chair',
    'Marcus is writing the ruling',
    `Reading back all ${st.round} round${st.round === 1 ? '' : 's'} on "${item.title}" to settle it, name an owner and record the dissents.`
  );
  try {
    /**
     * The ruling used to resume Marcus's session (which had already read every
     * word of the motion) AND paste the same transcript into the prompt: the
     * most expensive argument in the app, paid for twice. Now the record IS
     * the system prompt, frozen at the motion's end, cached from the last
     * round, and referenced rather than repeated.
     */
    // +1: boundary is exclusive (frozen = seq < boundary), so without it the
  // most recent speech in the record was invisible to this call.
  const room = host.room(Events.lastSeq(host.id) + 1);
    const { value } = await runJsonAgent<any>({
      model: host.modelFor('ruling'),
      system: room.system,
      prompt: [
        marcusVoice(host.config as any, host.founder()),
        motionRulingPrompt(
          motion,
          '(The full argument is the record above.)',
          st.unresolved,
          host.computations(),
          { rung: st.rung, rounds: st.round },
          host.settled(),
          host.reopened(),
          closeReason,
          host.rulingStakes()
        ),
        // The grades the experts recorded but no longer speak; the prefix carries none.
        claimsRecord(Events.since(host.id, st.startSeq), host.personas, host.founder()),
        pendingResearch.length
          ? `RESEARCH STILL PENDING: the research desk had not answered these when the motion closed:\n${pendingResearch.map((q) => `- ${q}`).join('\n')}\nRule on what exists, and say in the rationale that this evidence was pending; if the ruling turns on it, name it in "undecidable".`
          : '',
        mandate
          ? `THE ADVERSARY'S DEFEATERS, AND WHAT YOU OWE THEM. Your first ruling on this motion was attacked and the room has now had its round on these:\n${mandate}\nFor each one, exactly one of two things happens in your ruling: it changes what you decide and you say so, or your rationale answers it in plain arithmetic. Any defeater the room could not actually answer goes into dissents, expert "Adversary desk", position = the defeater, reasoning = why it still stands. Papering over one is the single failure this desk exists to catch.`
          : '',
      ].filter(Boolean).join('\n\n'),
      onThinking: (t) => stage.think(t),
      thinking: host.thinking('heavy'),
      debateId: host.id,
      label: 'marcus:ruling',
    });
    if (value.say) host.publishMarcus(String(value.say));

    const d = value.decision ?? {};
    const und = d.undecidable;
    /**
     * A ruling graded observed must stand on something observed: a claim that
     * survived the evidence check, or the founder's own word during the motion.
     * Measured needs a computation. Otherwise it is assumed (P1).
     */
    const motionEvents = Events.since(host.id, st.startSeq);
    const graded = rulingGrade(
      ['measured', 'observed', 'assumed', 'mixed'].includes(d.evidence) ? d.evidence : 'assumed',
      motionEvents.flatMap((e) => (e.type === 'message' ? e.claims ?? [] : [])),
      motionEvents.some((e) => e.type === 'answer'),
      host.computations().some((c) => c.computable)
    );
    const owner = host.rulingStakes()?.owner;
    const decision: Decision = {
      motionId: item.id,
      motionTitle: item.title,
      decision: String(d.decision ?? fallback.decision),
      owner: String(d.owner ?? owner ?? 'Founder'),
      rationale: String(d.rationale ?? ''),
      evidence: graded,
      dependsOn: Array.isArray(d.dependsOn) ? d.dependsOn.map(String).slice(0, 8) : [],
      dissents: Array.isArray(d.dissents)
        ? d.dissents.slice(0, 6).map((x: any) => {
            const tw = x?.tripwire && typeof x.tripwire === 'object' && String(x.tripwire.signal ?? '').trim()
              ? { signal: String(x.tripwire.signal).trim().slice(0, 300), by: String(x.tripwire.by ?? '').trim().slice(0, 120) }
              : undefined;
            const cost = String(x?.costOfIgnoring ?? '').trim().slice(0, 300);
            return {
              expert: String(x.expert ?? ''),
              position: String(x.position ?? ''),
              reasoning: String(x.reasoning ?? ''),
              // Dissent with teeth (2d): what would prove them right, by when, and what ignoring it costs.
              ...(tw ? { tripwire: tw } : {}),
              ...(cost ? { costOfIgnoring: cost } : {}),
            };
          })
        : [],
      undecidable:
        und && und.question
          ? { question: String(und.question), evidenceNeeded: String(und.evidenceNeeded ?? ''), who: String(und.who ?? 'Founder') }
          : undefined,
    };
    host.publish({ type: 'decision', decision });
    /**
     * Closing one motion is the moment an earlier ruling is most likely to fall
     * over, because this is the first time the chair has read the whole
     * argument back. Handled after the decision publishes so the record shows
     * what was settled before it shows what that unsettled.
     */
    if (value.reopen?.motionId && String(value.reopen.motionId) !== item.id) {
      host.reopen(String(value.reopen.motionId), String(value.reopen.because ?? ''));
    }
    return decision;
  } catch {
    throwIfLimited(host.id);   // never a fallback ruling because the allowance ran out
    host.publish({ type: 'decision', decision: fallback });
    return fallback;
  } finally {
    stage.close();
  }
}

export { rid };
