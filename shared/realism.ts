/**
 * The realism engine's data model (docs/PHASE2-PLAN.md, section 2).
 *
 * Everything here is additive. Old debates carry none of it and run and
 * render exactly as before: absent means "feature off". Re-exported from
 * types.ts, so callers import from one place.
 */
import type { EvidenceGrade } from './types.ts';

// ---------- turn shapes and the spoken record ----------

/**
 * What kind of contribution a turn is. The floor director picks one, with a
 * word budget, before a turn is generated.
 *   set_piece  60-160 words: new mechanism or evidence, opening a motion
 *   reply      12-60 words: answering a direct question or attack
 *   reaction   2-15 words: a cut-in or backchannel ("On what base?")
 *   chair      10-50 words: the chair, on a trigger only
 */
export type TurnShape = 'set_piece' | 'reply' | 'reaction' | 'chair';

/** Where a turn was cut off, and by whom. `atChar` indexes the spoken text. */
export interface CutOff {
  atChar: number;
  /** Persona id of whoever cut in. */
  by: string;
  /** The message id where the speaker picked the thread back up, if they did. */
  resumedBy?: string;
}

/** A turn spoken over another one. `fromChar` indexes the other turn's text. */
export interface Overlap {
  /** Message id of the turn being talked over. */
  with: string;
  fromChar: number;
}

/** What the realism linter did to a turn. For the eval harness; never shown. */
export interface LintRecord {
  score: number;
  rewrote: boolean;
  rules: string[];
}

/** One graded claim, carried beside the speech instead of spoken aloud. */
export interface ClaimRecord {
  text: string;
  grade: EvidenceGrade;
  /**
   * The speaker's own grade, present only when the server's evidence check
   * (server/src/realism/evidence.ts) changed it: an `observed` claim nobody
   * can trace to the founder or a cited source becomes `persona` or `assumed`.
   */
  said?: EvidenceGrade;
}

// ---------- persona dossiers (2a) ----------

export type Register = 'clipped' | 'plain' | 'technical' | 'storyteller' | 'socratic' | 'combative' | 'dry';

export interface Dossier {
  personaId: string;
  /** What the room knows. Goes in the shared, cached roster. */
  publicReputation: string;
  /** Everything below is PRIVATE: only in this expert's own per-turn suffix. */
  history: { when: string; what: string; lesson: string; kind: 'failure' | 'win' }[];
  incentives: string[];
  priorPublicStance?: string;
  biases: { name: string; showsUpAs: string }[];
  blindSpots: string[];
  /** 0..1, a trait. Enforced socially (unexplained moves become chair triggers), never by editing speech. */
  stubbornness: number;
  temperament: { heatGain: number; heatDecay: number; interruptThreshold: number; dominance: number };
  speech: {
    register: Register;
    typicalWords: number;
    vocabulary: string[];
    tics: { text: string; maxPerMotion: number }[];
    neverSay: string[];
  };
  underPressure: string;
  relationships: { with: string; kind: 'ally' | 'rival' | 'history' | 'respect'; note: string }[];
  /**
   * Which way this expert's personal incentives point on the session goal
   * (-1 against, 0 neutral, +1 for). The diversity check needs at least two
   * opposed pairs. Absent on dossiers written before 2b-5 was wired.
   */
  goalLean?: -1 | 0 | 1;
}

/**
 * The panel diversity check's verdict, shown at panel approval. A panel that
 * still fails after one regeneration goes ahead, flagged, so the founder can
 * ask for a different roster.
 */
export interface DiversityFlag {
  ok: boolean;
  /** Plain-language problems, one line each. Empty when ok. */
  problems: string[];
  /** Experts whose dossiers were written a second time to fix the mix. */
  regenerated: string[];
}

// ---------- belief ledger (2c) ----------

export type Stance = -2 | -1 | 0 | 1 | 2;
export type Confidence = 'low' | 'medium' | 'high';

export interface Belief {
  expert: string;
  motionId: string;
  stance: Stance;
  confidence: Confidence;
  crux: string;
  reasons: string[];
  sinceSeq: number;
}

export interface Concession {
  motionId: string;
  expert: string;
  from: { stance: number; confidence: string };
  to: { stance: number; confidence: string };
  kind: 'full' | 'partial' | 'conditional' | 'tactical';
  movedBy: {
    kind: 'evidence' | 'computation' | 'argument' | 'falsifier' | 'founder' | 'social' | 'unexplained';
    ref?: string;
    who?: string;
  };
  /** What they gave up: a red line, a prior public stance, a budget line, face. */
  cost: string;
  messageId: string;
}

// ---------- stakes (2d) ----------

export interface Stakes {
  decisionOwner: { name: string; role: string };
  decideBy: string;
  atRisk: { money?: string; people?: string; time?: string; reputation?: string };
  ifWrong: { yes: string; no: string };
  reversibility: 'one-way' | 'two-way';
  /** Stakes are never invented silently: 'assumed' is printed as assumed. */
  source: 'founder' | 'dossier' | 'assumed';
}

// ---------- the floor (2b) ----------

/** The meeting clock: fictional meeting time, advanced by speech and pauses. */
export interface MeetingClock {
  elapsedSec: number;
  slotSec: number;
}

/**
 * A turn generated but not yet (fully) performed. Server-side only: `unspoken`
 * is the remainder of a cut turn, and it must never reach an event, a prompt
 * built for another seat, the report or any transcript.
 */
export interface PendingTurn {
  id: string;
  speaker: string;
  shape: TurnShape;
  /** The full generated text. */
  text: string;
  /** How much of `text` has been performed so far. */
  performedChars: number;
  to?: string[];
  /** The remainder after a cut, kept for a resume or for the referee's "unspoken" list. */
  unspoken?: string;
}

/** An answer someone owes the room. */
export interface OwedAnswer {
  from: string;
  to: string;
  question: string;
  messageId: string;
  presses: number;
}

/** Director state, persisted in the motion checkpoint so a restart resumes it. */
export interface FloorState {
  motionId: string;
  clock: MeetingClock;
  heat: Record<string, number>;
  /** Spoken-turn index each expert last spoke at. */
  lastSpoke: Record<string, number>;
  /** Spoken turns in this motion so far. */
  turn: number;
  /** Spoken turns per expert in this motion, for the floor-share penalty. */
  spoken: Record<string, number>;
  owed: OwedAnswer[];
  duel: { a: string; b: string; exchanges: number } | null;
  ticUse: Record<string, Record<string, number>>;
  interruptions: number;
  /** Spoken-turn index of each expert's last interruption. */
  lastInterrupt: Record<string, number>;
  pending: PendingTurn[];
  /** Seeded PRNG state, so a replay with the same seed makes the same choices. */
  rng: number;
  /** Spoken-turn index of each listener's last short reaction (2b-7): nobody nags the same speaker turn after turn. */
  lastReact?: Record<string, number>;
  /** Spoken-turn index when the chair last spoke on a trigger (his cooldown). */
  chairAt?: number;
  /** Asides whispered this motion (deep panels allow one). */
  asides?: number;
  /** Meeting-clock milestones crossed and not yet announced. */
  milestones?: ('half' | 'five_left' | 'one_left' | 'time')[];
}

// ---------- budget (4.4) ----------

/**
 * How deep the room argues (experts, motions, rounds, adversaries). Not a
 * spend limit. Separate from the intake's Depth: the depth read sizes the
 * session, the profile shapes it.
 */
export type BudgetProfile = 'quick' | 'standard' | 'deep';
/** What the founder picks at setup: a profile, or 'auto' to let the intake choose. */
export type ProfileChoice = BudgetProfile | 'auto';

/**
 * The spend meter. INFORMATION ONLY: nothing in the engine stops or shortens
 * because of it. Live after every call; persisted once per motion.
 *
 * Snapshots written before Oct 2026 carry the old cap fields (capUsd,
 * outputCap, flagshipCap, callCap, turnCap, pressure, binding) and the states
 * 'wind_down' / 'closing'; they are kept optional so old debates still fold.
 */
export interface BudgetSnapshot {
  profile: BudgetProfile;
  spentUsd: number;
  outputTokens: number;
  flagshipCalls: number;
  calls: number;
  /** Spoken expert turns so far. */
  turns: number;
  /** Projected final spend at the current rate. */
  projectedUsd: number;
  /** The pre-debate estimate, for "estimate vs actual". */
  estimateLowUsd?: number;
  estimateHighUsd?: number;
  /**
   * What the dollars mean. 'plan': API-equivalent usage of a subscription
   * login (no bill). 'payg': real money on a pay-per-use API key, shown
   * prominently. 'none': no per-token figure at all (Codex).
   */
  billing?: 'plan' | 'payg' | 'none';
  /** The founder's own ceiling, if they set one. Absent or null: no limit. */
  ceilingUsd?: number | null;
  /** 'ok', or 'ceiling' while the room waits for the founder to extend their ceiling. */
  state: 'ok' | 'ceiling' | 'wind_down' | 'closing';
  clock?: MeetingClock;
  /** Share of the Claude subscription window used, when the SDK exposes it. */
  quota?: { windowPct: number; resetsAt?: number };
  /** Legacy (pre-Oct 2026 snapshots only). */
  capUsd?: number;
  outputCap?: number;
  flagshipCap?: number;
  callCap?: number;
  turnCap?: number;
  pressure?: number;
  binding?: 'usd' | 'output' | 'flagship' | 'calls' | 'turns';
}

/** A provider allowance ran out: the session is parked and will resume by itself. */
export interface QuotaPause {
  /** When the room will try again (ms epoch), or null if it is waiting for a person. */
  resumesAt: number | null;
  /** Which allowance: the Claude 5-hour window, a weekly limit, or a provider 429. */
  kind: 'session' | 'weekly' | 'unknown';
  /** True when the provider stated the reset time; false when it is a backoff guess. */
  stated: boolean;
}
