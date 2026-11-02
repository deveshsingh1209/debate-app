/**
 * EVERY BUDGET NUMBER IN THE APP, IN ONE PLACE.
 *
 * Owner decision (Oct 2026): "capping cost can make results worse; quality
 * over anything; hard calls must get a full debate." So nothing in this file
 * is a spend limit by default:
 *
 * - The profiles describe PROCESS DEPTH: how many experts and motions, how
 *   many rounds a motion argues before it may close, how many adversaries
 *   attack each ruling, how hard each seat thinks. Not dollars.
 * - Hard calls are moved to 'deep' automatically (AUTO_DEEP).
 * - The guards target WASTE, not spend: duplicate calls, identical retries,
 *   turns that repeat what was already said (WASTE).
 * - A spent provider allowance PAUSES the session and resumes it (QUOTA).
 * - A dollar ceiling exists only if the founder sets one, and reaching it
 *   asks them to extend rather than cutting the argument short (CEILING).
 * - TURN_COST prices the pre-debate estimate, which is information only.
 *
 * Nothing else in the codebase states any of these numbers.
 */
import type { BudgetProfile } from './realism.ts';

export interface ProfileSpec {
  label: string;
  /** One line for the setup screen: what the room does, never what it costs. */
  blurb: string;
  /** The profile shapes the session the intake sizes; the smaller wins. */
  maxExperts: number;
  maxMotions: number;
  /** Rounds every motion argues before the dry check may close it. The intake's depth read can ask for more. */
  minRounds: number;
  /**
   * Research requests in the whole session. A runaway guard, set well above
   * what a session of this depth uses; a duplicate question is refused anyway.
   */
  researchCap: number;
  /** Research requests the room (experts and chair) may send per motion; pre-session briefs are not counted here. Also a runaway guard. */
  researchPerMotion: number;
  /** Adversary seats attacking each ruling. */
  adversarySeats: number;
  /** Adversary seats attacking the written report (the seat that once caught a real shipped error). */
  reportAdversarySeats: number;
  /** Thinking budgets (tokens) by seat. The referee stays on the flagship model at every profile; only its thinking is sized. */
  thinking: { referee: number; floor: number; reply: number; steer: number; heavy: number };
  /** Interruptions per motion once the floor director is live (2b-7). */
  interruptCap: number;
  /** Side whispers (2b-7). */
  asides: boolean;
  /** How long the room argues (LENGTH below). A process shape, like the rest: it never reads a dollar. */
  length: LengthSpec;
}

/**
 * Session length (plan P2).
 *
 * The 2026-10-28 real run on Quick argued its first motion for nine
 * checkpoints and 132 messages: the profile's round minimum was only a floor,
 * and the ceilings that actually stopped it (16 rounds, 110 messages a motion)
 * were runaway backstops sized for the deepest room. Each profile now states
 * its own length, and the floor director and the referee both work to it.
 *
 * A "message" is anything spoken in the room (expert turns, reactions and
 * cut-ins, the chair, the research desk's line, closing statements): what the
 * founder reads. Deep keeps the old backstops, so it may still run long.
 */
export interface LengthSpec {
  /** The intake's depth read may not push the round target past this (absent: no cap). After the target, a checkpoint with no new substance closes the motion. */
  targetRounds?: number;
  /** Checkpoints a motion may run before it is ruled on whatever the room's state (the adversary's round is extra). */
  maxRounds: number;
  /** Messages one motion may take on the floor before it is ruled. */
  messagesPerMotion: number;
  /** Messages in the whole session, closings included. Shared between the motions still open. */
  sessionMessages: number;
  /** Every motion gets at least this many floor messages, however tight the session: no motion is ruled unargued. */
  minMotionMessages: number;
  /** The rung (shared/types RUNGS) a motion must reach to close on the merits; below it a close is recorded honestly as stuck or budget. */
  minRungToClose: number;
  /**
   * After the round target the referee calling the crux settled closes the
   * motion, as before. With this on, so does one checkpoint with no new
   * substance (the referee says circling or exhausted, or found nothing new).
   * Off: two dry checkpoints in a row, as before.
   */
  closeOnNoSubstance: boolean;
}

export const BUDGET_PROFILES: Record<BudgetProfile, ProfileSpec> = {
  quick: {
    label: 'Quick',
    blurb: 'One motion, three experts, two or three rounds, one adversary on the ruling. About 40 to 60 messages.',
    maxExperts: 3, maxMotions: 1, minRounds: 2,
    researchCap: 6, researchPerMotion: 3, adversarySeats: 1, reportAdversarySeats: 1,
    thinking: { referee: 16_000, floor: 8_000, reply: 2_000, steer: 8_000, heavy: 32_000 },
    interruptCap: 3, asides: false,
    length: { targetRounds: 2, maxRounds: 3, messagesPerMotion: 34, sessionMessages: 60, minMotionMessages: 12, minRungToClose: 2, closeOnNoSubstance: true },
  },
  standard: {
    label: 'Standard',
    blurb: 'Up to three motions and four experts, three to five rounds each, one adversary per ruling.',
    maxExperts: 4, maxMotions: 3, minRounds: 3,
    researchCap: 12, researchPerMotion: 4, adversarySeats: 1, reportAdversarySeats: 1,
    thinking: { referee: 16_000, floor: 8_000, reply: 2_000, steer: 8_000, heavy: 32_000 },
    interruptCap: 4, asides: false,
    length: { targetRounds: 3, maxRounds: 5, messagesPerMotion: 70, sessionMessages: 220, minMotionMessages: 16, minRungToClose: 3, closeOnNoSubstance: true },
  },
  deep: {
    label: 'Deep',
    blurb: 'Up to six motions and eight experts, at least four rounds each, three adversaries per ruling and on the report.',
    maxExperts: 8, maxMotions: 6, minRounds: 4,
    researchCap: 30, researchPerMotion: 6, adversarySeats: 3, reportAdversarySeats: 3,
    thinking: { referee: 32_000, floor: 12_000, reply: 2_000, steer: 8_000, heavy: 60_000 },
    interruptCap: 6, asides: true,
    // The old backstops (DEPTH in shared/types.ts): a deep room still argues until it is dry.
    length: { maxRounds: 16, messagesPerMotion: 110, sessionMessages: 900, minMotionMessages: 24, minRungToClose: 3, closeOnNoSubstance: false },
  },
};

/**
 * Messages a motion may still take on the floor, given what the session has
 * spent: the profile's per-motion budget, or this motion's share of what is
 * left of the session after reserving the closings and an adversary round per
 * open motion, whichever is smaller, and never below the minimum.
 *
 * `spentElsewhere` is every message outside this motion's floor so far;
 * `motionsLeft` counts this one.
 */
export function motionAllowance(len: LengthSpec, o: { spentElsewhere: number; motionsLeft: number; experts: number; adversary: boolean }): number {
  const motionsLeft = Math.max(1, o.motionsLeft);
  const closings = o.experts + 2;                                   // one each, and the chair before and after
  const adversary = o.adversary ? Math.ceil(adversaryTurns(o.experts) * 1.5) : 0;
  const pool = len.sessionMessages - o.spentElsewhere - closings - adversary * motionsLeft;
  const share = Math.floor(pool / motionsLeft);
  return Math.max(len.minMotionMessages, Math.min(len.messagesPerMotion, share));
}

/** Spoken turns in the adversary's round on a ruling: one per expert, at least four. */
export const adversaryTurns = (experts: number) => Math.max(4, experts);

/**
 * Turns to ask of a checkpoint with `remaining` messages left in the motion:
 * a turn brings about 1.7 messages with its reactions, so ask for what fits,
 * at least two (a checkpoint of one turn is not an exchange).
 */
export function checkpointTurns(planned: number, remaining: number): number {
  return Math.max(2, Math.min(planned, Math.floor(remaining / 1.7)));
}

/** What the setup screen offers first: let the intake pick. */
export const DEFAULT_PROFILE_CHOICE = 'auto' as const;
/** What 'auto' runs as until the intake has read the ask, and when nothing marks it hard. */
export const DEFAULT_PROFILE: BudgetProfile = 'standard';

/**
 * When 'auto' moves a session to 'deep'. Any one rule is enough. 'auto' never
 * picks quick: a lighter room is the founder's choice to make, not ours.
 */
export const AUTO_DEEP = {
  /** The intake's own difficulty signal: it asked for the hardest push. */
  depths: ['exhaustive'] as const,
  /** More separate decisions than standard can seat as motions. */
  decisionsAbove: BUDGET_PROFILES.standard.maxMotions,
  /** More disciplines than standard can seat as experts. */
  disciplinesAbove: BUDGET_PROFILES.standard.maxExperts - 1,
  /**
   * High-stakes words in the founder's own brief. Counts only when the intake
   * did not call the ask quick, so "a quick legal question" stays standard.
   */
  stakes: /\b(irreversib\w*|bet the (?:company|business)|existential|lay ?offs?|redundanc\w+|acqui(?:re|sition)|merger|sell the (?:company|business)|shut (?:it )?down|wind down|fundrais\w*|term sheet|series [a-d]|pivot|lawsuit|litigation|regulator\w*|recall|patient safety|life or death|\$\s?\d+(?:\.\d+)?\s?(?:m|mm|million|bn|billion)\b)/i,
} as const;

/**
 * The optional dollar ceiling. OFF by default. Set per debate on the setup
 * screen or for every debate with BUDGET_CEILING_USD. At the ceiling the room
 * pauses between rounds and asks the founder to extend it (one click) or to
 * stop and write up; it never quietly argues less.
 */
export const CEILING = {
  /** Each extension adds this share of the current ceiling... */
  extendShare: 0.5,
  /** ...and at least this many dollars. */
  extendMinUsd: 5,
} as const;

/**
 * Waste guards. These stop the app paying for nothing, never for argument.
 */
export const WASTE = {
  /** Extra attempts after a failed agent call (a usage limit is never retried; it pauses). */
  agentRetries: 1,
  /** Corrective turns when a JSON reply does not parse. */
  jsonRepairs: 2,
  /**
   * The same call (seat, model, system, prompt, session) that has already
   * SUCCEEDED this many times in one debate is refused: its answer already
   * exists, and running it again is a loop. Failures do not count.
   */
  maxIdenticalCalls: 2,
  /** Word n-gram size for the novelty check. */
  shingle: 3,
  /** A turn whose share of never-said-before n-grams is below this repeats the room. */
  minNovelty: 0.2,
  /** Turns shorter than this (in words) are not judged: a one-line reaction can be all new or all old by chance. */
  minWords: 12,
  /** This many repeating turns in a row on one motion is a stalemate: it is recorded and ruled, not argued again. */
  staleTurnsToClose: 4,
} as const;

/**
 * A spent provider allowance (Claude's 5-hour or weekly window, an OpenAI or
 * ChatGPT 429) pauses the session in place and resumes it on its own.
 */
export const QUOTA = {
  /** Wake this long after the reset the provider stated, so the window has really turned over. */
  afterResetMs: 2 * 60_000,
  /** Without a stated reset: first wait, doubling each time, up to the cap. */
  firstBackoffMs: 5 * 60_000,
  maxBackoffMs: 60 * 60_000,
  /** Never wake sooner than this. */
  minWaitMs: 60_000,
  /** A limit that has not cleared in this long is a dead credential, not a window. Longer than a weekly reset. */
  giveUpAfterMs: 8 * 24 * 3600_000,
} as const;

/**
 * Cost per agent turn, by model, in USD: what the pre-debate estimate and the
 * meter's projection are priced from. Information only; nothing stops on it.
 * Calibrated on two completed sessions under the previous Opus chair (271
 * turns $21.42, 262 turns $27.21) and carried to the current models by tier;
 * not yet re-calibrated (meta.spendByRole is what to recalibrate from).
 * OpenAI bands are derived from list prices relative to the Claude bands and
 * widened upward, because reasoning tokens bill as output. Codex has no
 * per-token charge.
 */
export const TURN_COST: Record<string, { low: number; high: number }> = {
  'claude-opus-5-5':   { low: 0.07, high: 0.15 },
  'claude-sonnet-5-5': { low: 0.04, high: 0.09 },
  'claude-haiku-4-5':  { low: 0.01, high: 0.03 },
  'gpt-6-astra':       { low: 0.14, high: 0.30 },
  'gpt-6.1-sol':       { low: 0.03, high: 0.08 },
  'gpt-6-luna':        { low: 0.002, high: 0.006 },
};

export const isProfile = (p: unknown): p is BudgetProfile => p === 'quick' || p === 'standard' || p === 'deep';
