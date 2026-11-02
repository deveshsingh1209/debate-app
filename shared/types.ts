/**
 * THE DEBATE APP — shared contract between server engine and web UI.
 * This file is the single source of truth. Server imports it directly;
 * web imports it via relative path. Do not fork or duplicate these types.
 */

export const APP_NAME = 'The Debate App';

// ---------- access ----------

/**
 * What GET /api/me returns. The app is single-user and local: there are no
 * accounts. `ok` is false only when ACCESS_PASSWORD is set and this browser
 * has not signed in.
 */
export interface SessionInfo {
  ok: boolean;
  /** An access password is configured, so a sign-in screen is needed. */
  authRequired: boolean;
  /** Send back as the `x-csrf-token` header on every POST/DELETE. */
  csrfToken: string;
  /** Which provider doors can run on this machine. Null until signed in. */
  providers: Record<Provider, boolean> | null;
  /** FOUNDER_NAME, if set: how the panel addresses you. */
  founderName: string | null;
  /** Telegram notifications are configured on this machine. A boolean, never the token. */
  telegram?: boolean;
}

// ---------- Connect your AI (the four doors) ----------

/**
 * Whether a door can run a debate right now, from a probe that makes no model
 * call (server/src/doors). `needs_setup`: nothing is there yet (no login, no
 * key). `problem`: something is there but will not work as it is.
 */
export type DoorState = 'ready' | 'needs_setup' | 'problem';

/** One step of a door's setup. `copy` is the exact text the copy button puts on the clipboard. */
export interface DoorStep {
  text: string;
  copy?: string;
}

export interface DoorStatus {
  id: Provider;
  /** "Claude: sign in", "Claude: API key", ... */
  title: string;
  /** Who this door is for and what it costs, in one plain sentence. */
  blurb: string;
  state: DoorState;
  /** One line: what the probe found. Never a secret, never an account name. */
  summary: string;
  /** What to do, in plain words. Null when ready. */
  fix: string | null;
  /** The full setup, start to finish, always present so a ready door can be re-done. */
  steps: DoorStep[];
  /** Anything else worth knowing (a heads-up, not a blocker). */
  note: string | null;
  checkedAt: number;
}

/** GET /api/doors */
export interface DoorsInfo {
  doors: DoorStatus[];
  /** Where the app reads API keys from, so the steps can name the file. The contents are never returned. */
  envFile: string;
  /** MOCK=1: debates are scripted and need no door. */
  mock: boolean;
}

// ---------- Setup / configuration ----------

/**
 * Model ids, seat casting and the provider families live in ./models.ts. The
 * founder picks only a provider door; the product decides which model runs
 * each seat.
 */
import type { Provider, Seat } from './models.ts';
export type { Provider, Seat } from './models.ts';
import type {
  BudgetProfile, BudgetSnapshot, ProfileChoice, QuotaPause, Belief, ClaimRecord, Concession, CutOff, DiversityFlag, LintRecord, MeetingClock, Overlap, TurnShape,
} from './realism.ts';
import type { ResearchResult } from './research.ts';
import type { Attention } from './attention.ts';
export type * from './realism.ts';
export type * from './research.ts';

/** The jobs a casting sheet lists. Same names as the seats in models.ts. */
export type CastRole = Seat;

export interface CastEntry {
  role: CastRole;
  model: string;
  /** Why this seat runs on this tier. Shown in the UI. */
  why: string;
}

/**
 * Which model runs which job in this session. Fixed by the product (see
 * models.ts) and published once when the room opens, so the founder can see
 * exactly what runs. Older debates also carry re-cast revisions from when the
 * chair chose models himself; the UI still renders those.
 */
export interface Casting {
  /** Marcus's own model. */
  chair: string;
  entries: CastEntry[];
  strategy: string;
  revision: number;
}
export type EngineMode = 'directed' | 'freeforall';
export type Autonomy = 'interactive' | 'autonomous';

export interface DebateConfig {
  /** Which provider family runs the whole debate. */
  provider: Provider;
  mode: EngineMode;
  autonomy: Autonomy;
  /**
   * Legacy only: debates created before providers existed stored the chair's
   * model id here. Read through providerOfConfig() in models.ts.
   */
  model?: string;
  /**
   * How deep the room argues (quick | standard | deep), or 'auto' (the
   * default) to let the intake pick: hard or high-stakes calls go deep. A
   * process shape, not a spend limit. Rows created before profiles existed
   * have none and run exactly as they always did. Rows from the capped era
   * (2b-2) keep their profile and simply run without caps now.
   */
  profile?: ProfileChoice;
  /**
   * Optional dollar ceiling for this debate, off when absent or null. At the
   * ceiling the room asks the founder to extend it; it never argues less.
   * BUDGET_CEILING_USD sets one for every debate that does not set its own.
   */
  ceilingUsd?: number | null;
}

/**
 * How big a session is, decided by the topic rather than by this file.
 *
 * The first version fixed all three dimensions in prompt text: "5-8 motions",
 * a panel the architect sized however it liked, and a depth ladder every motion
 * ran to. A narrow question and a sprawling one therefore cost the same, which
 * on a real session meant sixteen experts arguing eight motions for eighty
 * dollars whatever was asked. Cost scales with experts x motions x rounds, so
 * all three have to be a judgement about THIS topic.
 */
export type Depth = 'quick' | 'standard' | 'exhaustive';

/** The intake analyst's read of the ask. Counts, not prose: the server does the arithmetic. */
export interface ComplexityRead {
  /** Genuinely separate contested decisions in the ask. Not sub-questions of one decision. */
  decisions: number;
  /** Distinct disciplines that must be at the table for the argument to be real. */
  disciplines: number;
  /** How hard each decision has to be pushed before it is safe to act on. */
  depth: Depth;
  /** Addressed to the founder: why this ask is this size and not larger. */
  rationale: string;
}

/** The sized session. Derived from ComplexityRead, shown to the founder, editable by him. */
export interface SessionScope {
  experts: number;
  motions: number;
  /** Target rounds per motion. A motion still closes early when it goes dry. */
  roundsPerMotion: number;
  depth: Depth;
  rationale: string;
  /** What this is expected to cost, computed from the model prices below. */
  estimate: ScopeEstimate;
}

export interface ScopeEstimate {
  turns: number;
  lowUsd: number;
  highUsd: number;
  /** Plain-language statement of what the numbers assume, so the range can be judged. */
  basis: string;
  /** The profile that shaped this session, and why when the intake chose it. */
  profile?: BudgetProfile;
  profileReason?: string;
  /** The founder's own ceiling, if any. Null or absent: no limit is applied. */
  ceilingUsd?: number | null;
  /** Legacy: the hard caps shown on estimates from the capped era (2b-2). Never written now. */
  caps?: {
    profile: BudgetProfile;
    usdCap: number | null;
    flagshipCap: number;
    callCap: number;
    turnCap: number;
    outputCap: number;
  };
}

/** Bounds on what a founder or an analyst may ask for. Guardrails, not defaults. */
export const SCOPE_LIMITS = {
  experts: { min: 3, max: 16 },
  motions: { min: 1, max: 10 },
  rounds: { min: 2, max: 10 },
} as const;

/**
 * Depth policy. The engine argues each motion until it goes DRY: two
 * consecutive rounds that surface no genuinely new argument. These are the
 * guardrails around that, not a message target. Per-session numbers now come
 * from SessionScope; what remains here is the safety envelope around it.
 */
export const DEPTH = {
  maxRoundsPerMotion: 16,
  dryRoundsToClose: 2,
  speakersPerRound: 3,          // floor slots per round on a small panel (see roundSize)
  maxMessagesPerMotion: 110,
  hardMessageCeiling: 900,      // whole-session backstop
  /** A motion may not close until the argument has climbed at least this far. */
  minRungToClose: 3,
} as const;

/**
 * Rounds a motion should run before the dry check may close it, by depth.
 * A quick session still argues; it just stops pushing sooner.
 */
export const DEPTH_ROUNDS: Record<Depth, number> = {
  quick: 2,
  standard: 3,
  exhaustive: 5,
};

/**
 * The depth ladder. A motion is not "argued" because people spoke; it is argued
 * when the room has climbed from assertion to falsifier. The referee reports
 * the rung reached each round and the moderator pushes the room up it.
 */
export const RUNGS = [
  { rung: 0, name: 'assertion',  test: 'Positions stated, nothing yet supporting them.' },
  { rung: 1, name: 'mechanism',  test: 'The causal story behind each position is on the table.' },
  { rung: 2, name: 'evidence',   test: 'Specific numbers, sources or field observations are attached, and graded.' },
  { rung: 3, name: 'stress',     test: 'The strongest objection to the leading position has been made and answered.' },
  { rung: 4, name: 'falsifier',  test: 'Each side has named what would change its mind, and the decision rule is explicit.' },
] as const;

export type Rung = (typeof RUNGS)[number]['rung'];

/**
 * Floor slots per round, scaled to panel size so a large panel still rotates
 * fully every ~3 rounds instead of leaving experts silent for half a motion.
 * 5 seats -> 3 per round, 12 -> 4, 15 -> 5.
 */
export function roundSize(expertCount: number): number {
  return Math.max(3, Math.min(5, Math.ceil(expertCount / 3)));
}

export type DebateStatus =
  | 'intake'          // clarity check running on the topic paragraph
  | 'clarifying'      // waiting on user answers to clarifying questions
  | 'goal_approval'   // goal statement proposed, waiting on user
  | 'panel_design'    // panel architect assembling the expert roster
  | 'panel_approval'  // roster proposed, waiting on user
  | 'planning'        // Marcus drafting the opening discussion plan
  | 'plan_approval'   // plan proposed, waiting on user
  | 'meeting'         // the live debate loop
  | 'wrapup'          // closing statements
  | 'reporting'       // report agents writing the final report
  | 'complete'
  | 'paused'
  | 'error'
  | 'cancelled';

// ---------- Domain ----------

export interface Persona {
  id: string;            // slug, e.g. 'priya'
  name: string;          // 'Dr. Priya Nair'
  role: string;          // 'Consumer psychologist, Indian middle-class markets'
  tagline: string;       // one-line hook shown on the hologram card
  bio: string;           // 2-4 sentence background
  expertise: string[];   // chips
  personality: string;   // how they behave in a room
  biases: string;        // what they over/under-weight (drives real disagreement)
  style: string;         // speaking style notes
  color: string;         // hex accent color for UI, e.g. '#22d3ee'
  initials: string;      // 'PN'
  isModerator?: boolean; // true only for Marcus
}

export interface AgendaItem {
  id: string;
  title: string;
  detail: string;
  /** The proposition the room must settle. Debate runs until this is decided. */
  motion?: string;
  status: 'pending' | 'active' | 'done' | 'added' | 'dropped';
  /** Skipped first when the budget runs low. Motions the chair adds mid-session count as optional too. */
  optional?: boolean;
}

/**
 * Evidence discipline: every behavioural claim must be labelled.
 *
 * `observed` is reserved for facts the founder supplied (his brief, his
 * answers, his uploaded documents) and research findings cited by id.
 * `persona` is a panelist's own career or backstory: the experts are invented
 * characters, so their "my last shop" is illustrative colour, never evidence
 * about the founder's business (P1, evidence honesty; realism/evidence.ts).
 */
export type EvidenceGrade = 'measured' | 'observed' | 'assumed' | 'mixed' | 'persona';

/** The written output of one motion. This is what the session is FOR. */
export interface Decision {
  motionId: string;
  motionTitle: string;
  decision: string;          // the ruling, in one or two sentences
  owner: string;             // named human owner
  rationale: string;         // what settled it
  evidence: EvidenceGrade;
  dependsOn: string[];
  /**
   * Every standing dissent. From 2b-5 each one should carry a tripwire (what
   * would prove the dissenter right, and by when) and what ignoring it costs;
   * older rulings have neither and still render.
   */
  dissents: {
    expert: string;
    position: string;
    reasoning: string;
    tripwire?: { signal: string; by: string };
    costOfIgnoring?: string;
  }[];
  undecidable?: { question: string; evidenceNeeded: string; who: string };
}

export interface Plan {
  revision: number;      // 1 = initial plan; bumps on every iteration
  items: AgendaItem[];
  rationale?: string;    // why this revision happened
}

/**
 * What one expert walked into the room already believing.
 *
 * buildRoomBlocks makes the system prompt byte-identical for every seat so it
 * caches, and its own comment insists "everything in the prefix must be written
 * in nobody's voice". Identity therefore lived in the six lines of expertVoice,
 * which means every expert knew exactly the same things and disagreement could
 * only ever be temperament. A room where nobody holds a position they are
 * committed to defending converges politely and calls it consensus.
 *
 * Each card is written before the first motion by a mind that has NOT seen any
 * other expert's card, then frozen into that expert's own fresh suffix. The
 * falsifier is the load-bearing field: an expert may not concede except by
 * naming it out loud and saying it fired, which is what separates a real
 * position change from being agreeable.
 */
export interface PositionCard {
  thesis: string;
  loadBearingClaims: string[];
  redLine: string;            // what this expert will never concede
  falsifier: string;          // the one observation that flips them
  expectWrong: string;        // "<expert id> and why"
}

export interface Bid {
  speaker: string;       // persona id
  urgency: number;       // 0-10
  hook: string;          // one-line reason they want the floor
}

export interface QuestionOption {
  label: string;
  description: string;
}

// ---------- Event log (append-only, monotonically increasing seq) ----------

interface Ev<T extends string> {
  seq: number;
  ts: number;            // epoch ms
  type: T;
}

export type DebateEvent =
  | (Ev<'status'>       & { status: DebateStatus })
  | (Ev<'system'>       & { text: string })                    // engine narration, boot lines
  | (Ev<'clarify'>      & { questionId: string; question: string; options: string[]; allowCustom: boolean })
  | (Ev<'goal'>         & { title: string; goal: string })     // proposed; approve via API
  /**
   * `publicReputation` (2b-5): what the room knows about each expert, by
   * persona id. `diversity`: the dossier diversity check, flagged here when the
   * panel still fails it after one regeneration. Both absent on older panels.
   */
  | (Ev<'panel'>        & { personas: Persona[]; rationale: string; publicReputation?: Record<string, string>; diversity?: DiversityFlag })
  | (Ev<'plan'>         & { plan: Plan })
  | (Ev<'message'>      & {
      id: string;
      speaker: string;       // persona id | 'marcus' | 'research' | 'user' | 'quant'
      /**
       * 'quant' is the desk reporting a computed figure. It exists so the
       * transcript every persona reads contains the number, but the client
       * renders it as a computation card from the compute_done event instead of
       * a speech bubble, so it never appears here as one.
       */
      kind: 'floor' | 'interjection' | 'marcus' | 'research' | 'closing' | 'user' | 'quant' | 'reaction';
      /**
       * The words actually spoken, and nothing else. A turn that was cut off
       * carries only what was said before the cut; the unsaid remainder lives
       * server-side and never enters an event.
       */
      text: string;
      replyTo?: string;      // message id being answered/interrupted
      // ---- realism engine (Phase 2b); all optional, absent on old events ----
      shape?: TurnShape;
      /** Persona ids this turn is addressed to. */
      to?: string[];
      cutOff?: CutOff;
      overlap?: Overlap;
      /** For the eval harness; never shown. */
      lint?: LintRecord;
      /** Graded claims, carried beside the speech instead of spoken aloud. */
      claims?: ClaimRecord[];
    })
  | (Ev<'bids'>         & { round: number; bids: Bid[]; winner?: string })
  | (Ev<'question'>     & { questionId: string; question: string; context: string; options: QuestionOption[]; allowCustom: boolean })
  | (Ev<'answer'>       & { questionId: string; answer: string })
  | (Ev<'assumption'>   & { text: string })                    // autonomous mode: decision made without you
  | (Ev<'context_brief'> & { files: number; brief: string })   // uploaded dossier distilled
  // ---- exhaustive-depth engine ----
  | (Ev<'motion_open'>  & { motionId: string; index: number; total: number; title: string; motion: string })
  /**
   * The chair's ruling on who speaks next and why. Marcus assigns the floor
   * rather than taking bids, so his reasoning is the only window into how the
   * room is being steered — without it a round just looks like a queue.
   */
  | (Ev<'floor_set'>    & {
      motionId: string;
      round: number;
      why: string;                                              // why this slate, in this order
      slate: { speaker: string; direction: string }[];
    })
  | (Ev<'round'>        & { motionId: string; round: number; freshArguments: number; rung?: number; rungName?: string; note?: string })
  /** Marcus's casting call: who runs on which model, and why. */
  | (Ev<'casting'>      & { casting: Casting; reason?: string })
  /** How big this session is, and what it is projected to cost, before it runs. */
  | (Ev<'scope'>        & { scope: SessionScope })
  /** A question sent to the quant desk. */
  | (Ev<'compute_started'> & { taskId: string; question: string })
  /**
   * The quant desk reporting back. The only source in the session whose
   * figures may be graded `measured`, because they were computed from the
   * founder's own files rather than argued about.
   */
  | (Ev<'compute_done'> & {
      taskId: string;
      question: string;
      answer: string;
      computable: boolean;
      figures: { label: string; value: string; source: string }[];
      method: string;
      reconciles: boolean | null;
      caveats: string[];
    })
  /** The audit gate: every figure the panel committed to, recomputed. */
  | (Ev<'audit'> & {
      checked: number;
      summary: string;
      findings: { figure: string; verdict: 'holds' | 'wrong' | 'uncheckable'; recomputed: string; impact: string }[];
    })
  | (Ev<'panel_amended'>& { persona: Persona; reason: string })   // an expert summoned mid-session
  | (Ev<'decision'>     & { decision: Decision })
  /**
   * A settled motion put back on the floor because a later motion destroyed its
   * premise. The earlier ruling is vacated by this event, not merely annotated:
   * everything that reads the record back to the room (condenseSettled) and to
   * the founder (the live decision list, the transcript PDF) has to stop
   * presenting it as decided, or the session ends up defending a conclusion it
   * proved wrong itself. Capped at one per motion in the engine.
   */
  | (Ev<'motion_reopened'> & { motionId: string; title: string; because: string })
  | (Ev<'motion_closed'>& { motionId: string; rounds: number; messages: number })
  | (Ev<'progress'>     & { messages: number; motionsClosed: number; motionsTotal: number; spentUsd: number; usage?: UsageTotals })
  | (Ev<'research_started'> & { taskId: string; question: string })
  /** `result` is the provider-neutral shape (2b-4); old events carry `summary` only. */
  | (Ev<'research_done'>    & { taskId: string; summary: string; result?: ResearchResult })
  // ---- realism engine (Phase 2b) ----
  /**
   * A side whisper between two people. Its OWN event type, never a message:
   * everything that reads messages (the shared prefix, numericClaims, the
   * report material, transcript.md) must never see it. Only the founder's
   * screen and the recipient's own suffix do.
   */
  | (Ev<'aside'>        & { id: string; from: string; to: string; text: string })
  /** A silence on the performance timeline. */
  | (Ev<'pause'>        & { ms: number; reason: 'after_concession' | 'unanswered' | 'tension' | 'chair' })
  /** The director's state at a checkpoint: who is hot, who wants the floor, the clock. */
  | (Ev<'floor'>        & { motionId: string; heat: Record<string, number>; handsUp: string[]; clock: MeetingClock })
  /** Starting stances when a motion opens. */
  | (Ev<'belief'>       & { motionId: string; beliefs: Belief[] })
  /** An expert's stance moved, with what moved it and what it cost them. */
  | (Ev<'concession'>   & { concession: Concession })
  /** The spend meter (information only), checkpointed per motion. */
  | (Ev<'budget'>       & { budget: BudgetSnapshot })
  /**
   * A provider allowance ran out and the session parked in place (`pause`
   * set), or it came back (`pause` null). Replayed on refresh, so the room
   * always says when it will resume.
   */
  | (Ev<'quota'>        & { pause: QuotaPause | null })
  | (Ev<'convergence'>  & { verdict: 'continue' | 'converged'; note: string })
  | (Ev<'report_ready'> & { path: string })
  | (Ev<'error'>        & { message: string });

// ---------- token accounting ----------

/** Cumulative agent usage for one debate, across every agent kind. */
export interface UsageTotals {
  input: number;        // uncached input tokens
  output: number;
  cacheWrite: number;   // cache_creation_input_tokens
  cacheRead: number;    // cache_read_input_tokens
  webSearches: number;
  turns: number;        // agent invocations (experts, Marcus, bids, referee, research, report)
  costUsd: number;
  /** Agent calls on the flagship tier, for the budget meter. Absent on ledgers from before Phase 2b. */
  flagshipCalls?: number;
}

export const emptyUsage = (): UsageTotals => ({
  input: 0, output: 0, cacheWrite: 0, cacheRead: 0, webSearches: 0, turns: 0, costUsd: 0,
});

// ---------- Live-only SSE frames (never persisted, no seq) ----------

/**
 * Who is working when nobody is speaking.
 *
 * Most of a motion is not speech. Marcus choosing the slate, the referee
 * judging the round, and the chair writing a ruling are each a long agent turn
 * that produces nothing until it finishes, and the room looked dead for the
 * whole of it. A stage frame says what is happening, who is doing it, and
 * streams their actual reasoning while they do it.
 */
export type StageActor = 'marcus' | 'referee' | 'chair' | 'research' | 'panel' | 'report' | 'quant';

export interface StageFrame {
  type: 'stage';
  actor: StageActor;
  /** Short label: "Marcus is choosing who speaks next". */
  label: string;
  /** One line of context: which motion, which round, what is being judged. */
  detail?: string;
  /** Live reasoning, tail-capped. Empty until the model starts thinking. */
  thinking?: string;
  /** Server clock when this stage opened, so the UI can show a real elapsed time. */
  since: number;
  /** True when the work finished and the stage should clear. */
  done?: boolean;
}

export type LiveFrame =
  | { type: 'delta'; messageId: string; speaker: string; kind: string; textDelta: string }
  | { type: 'speaking'; speaker: string | null; phase: 'thinking' | 'talking' | null }
  | { type: 'usage'; usage: UsageTotals }   // after every agent turn; snapshot, not delta
  | { type: 'budget'; budget: BudgetSnapshot } // after every agent turn on a profiled debate
  | StageFrame
  | { type: 'ping' };

export type WireFrame = DebateEvent | LiveFrame;

// ---------- REST API ----------

export interface DebateSummary {
  id: string;
  title: string;
  status: DebateStatus;
  config: DebateConfig;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** What the debate needs from its founder right now, if anything (shared/attention.ts). */
  attention?: Attention | null;
  /** Changes whenever there is a new thing to look at (a second question, the next gate). */
  attentionKey?: string | null;
}

export interface DebateDetail extends DebateSummary {
  topic: string;         // the user's original paragraph
  /** FOUNDER_NAME if set: the name on your answers in the transcript. Null means "You". */
  ownerName: string | null;
  goal: string | null;
  personas: Persona[];
  plan: Plan | null;
  events: DebateEvent[]; // events after ?since (default: all)
  pendingQuestion: (DebateEvent & { type: 'question' }) | null;
  pendingApproval: 'goal' | 'panel' | 'plan' | null;
  decisions: Decision[];        // written decisions so far, in motion order
  activeMotionId: string | null;
  hasReport: boolean;
  hasPdf: boolean;
  /** The chat-styled transcript PDF exists for download. */
  hasTranscriptPdf?: boolean;
  usage: UsageTotals;           // cumulative token/cost accounting
}

/**
 * Endpoints (all JSON). Every request passes the Host and Origin checks.
 * When ACCESS_PASSWORD is set, every route except /api/health, /api/me and
 * /api/auth/* also needs the session cookie. Every POST/DELETE needs the
 * `x-csrf-token` header from GET /api/me (except /api/auth/login).
 *
 *  GET  /api/health                  -> { ok, uptime, mock }
 *  GET  /api/me                      -> SessionInfo
 *  GET  /api/doors?fresh=1           -> DoorsInfo   readiness of the four doors, no model
 *                                       call; cached ~30s, `fresh` re-checks (and re-reads
 *                                       the API keys in .env). Booleans and plain text only.
 *  POST /api/auth/login  { password } -> { ok } + session cookie (httpOnly, SameSite=Strict)
 *  POST /api/auth/logout              -> { ok }
 *
 *  GET  /api/debates                                                 -> DebateSummary[]
 *  POST /api/debates                 { topic, config: DebateConfig } -> { id }
 *       (or multipart: topic, config as a JSON string, files)
 *  GET  /api/debates/:id?since=N                                     -> DebateDetail
 *  GET  /api/debates/:id/stream?since=N   (SSE of WireFrame)
 *  POST /api/debates/:id/answer      { questionId, answer }          -> { ok }
 *  POST /api/debates/:id/approve     { stage: 'goal'|'panel'|'plan',
 *                                      action: 'approve'|'revise',
 *                                      feedback?: string }           -> { ok }
 *  POST /api/debates/:id/end                                          -> { ok }   force wrap-up now
 *  POST /api/debates/:id/pause                                        -> { ok }
 *  POST /api/debates/:id/resume                                       -> { ok }
 *  DELETE /api/debates/:id                                            -> { ok }
 *  GET  /api/debates/:id/report      -> text/html (the standalone interactive report)
 *  GET  /api/debates/:id/report.pdf  -> application/pdf (paginated PDF)
 *  GET  /api/debates/:id/transcript.pdf -> application/pdf
 *  GET  /api/debates/:id/transcript  -> text/markdown (full verbatim transcript)
 *
 * SSE notes:
 *  - Each frame is `data: <JSON WireFrame>\n\n`.
 *  - On connect with ?since=N the server replays persisted events with seq > N,
 *    then every in-progress partial message (one synthetic 'delta' each, with
 *    the full partial text, in the order they started; two overlap when one
 *    speaker talks over another), then goes live.
 *  - 'ping' every 20s keeps the connection warm.
 */

// Reserved speaker ids that are NOT in personas[]:
export const SPEAKER_RESEARCH = 'research';
export const SPEAKER_USER = 'user';
export const MODERATOR_ID = 'marcus';
