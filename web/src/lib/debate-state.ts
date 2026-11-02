/**
 * The debate state and the pure reducer that folds the event log and live
 * frames into it. No React, no network: stream.ts wires this to the server,
 * and debate-state.selftest.ts drives it directly.
 */
import type {
  Bid,
  BudgetSnapshot,
  Citation,
  Concession,
  DebateConfig,
  DebateDetail,
  DebateEvent,
  DebateStatus,
  DiversityFlag,
  LiveFrame,
  Casting,
  MeetingClock,
  Persona,
  Plan,
  QuotaPause,
  StageFrame,
  WireFrame,
} from '../../../shared/types';
import { emptyUsage, type UsageTotals, type Decision, type SessionScope } from '../../../shared/types';

export type MessageEv = Extract<DebateEvent, { type: 'message' }>;
export type QuestionEv = Extract<DebateEvent, { type: 'question' }>;
export type ClarifyEv = Extract<DebateEvent, { type: 'clarify' }>;

export type FeedItem =
  | { fk: 'msg'; key: string; ev: MessageEv }
  | { fk: 'phase'; key: string; status: DebateStatus; ts: number }
  | { fk: 'system'; key: string; text: string; ts: number }
  | { fk: 'answer'; key: string; text: string; ts: number }
  | { fk: 'convergence'; key: string; verdict: 'continue' | 'converged'; note: string; ts: number }
  | { fk: 'dossier'; key: string; files: number; brief: string; ts: number }
  | { fk: 'error'; key: string; text: string; ts: number }
  | { fk: 'motion'; key: string; index: number; total: number; title: string; motion: string; ts: number }
  | { fk: 'decision'; key: string; decision: Decision; ts: number }
  | { fk: 'amend'; key: string; name: string; role: string; reason: string; ts: number }
  | { fk: 'floor'; key: string; round: number; why: string; slate: { speaker: string; direction: string }[]; ts: number }
  | { fk: 'casting'; key: string; casting: Casting; ts: number }
  | {
      fk: 'compute'; key: string; question: string; answer: string; computable: boolean;
      figures: { label: string; value: string; source: string }[];
      method: string; reconciles: boolean | null; caveats: string[]; ts: number;
    }
  | {
      fk: 'audit'; key: string; checked: number; summary: string;
      findings: { figure: string; verdict: 'holds' | 'wrong' | 'uncheckable'; recomputed: string; impact: string }[];
      ts: number;
    }
  // ---- realism engine (Phase 2b) ----
  /** A side whisper. The founder sees it; the room's record never does. */
  | { fk: 'aside'; key: string; from: string; to: string; text: string; ts: number }
  | { fk: 'pause'; key: string; ms: number; reason: string; ts: number }
  | { fk: 'concession'; key: string; concession: Concession; ts: number };

export interface ResearchTask {
  taskId: string;
  question: string;
  summary?: string;
  status: 'started' | 'done';
  /** The sources behind the answer, when the desk returned a provider-neutral result (2b-4). */
  citations?: Citation[];
}

export interface ClarifyChainItem {
  ev: ClarifyEv;
  /** The answer already given (latest, if amended). Null while unanswered. */
  answer: string | null;
}

export interface StreamingMsg {
  id: string;
  speaker: string;
  kind: string;
  text: string;
}

export interface BidRound {
  round: number;
  bids: Bid[];
  winner?: string;
  at: number;
}

export interface DebateState {
  usage: UsageTotals;
  decisions: Decision[];
  activeMotion: { motionId: string; index: number; total: number; title: string; motion: string } | null;
  motionRound: { round: number; rung: number; rungName: string } | null;
  amendments: { persona: Persona; reason: string }[];
  loaded: boolean;
  fatal: string | null;
  connection: 'connecting' | 'live' | 'reconnecting';
  id: string;
  title: string;
  topic: string;
  status: DebateStatus;
  config: DebateConfig | null;
  createdAt: number;
  updatedAt: number;
  goal: { title: string; goal: string } | null;
  /** Whose debate this is. The label on every answer the human gives. */
  ownerName: string | null;
  personas: Record<string, Persona>;
  personaOrder: string[];
  panelRationale: string | null;
  /** What the room knows about each expert (dossiers, 2b-5), by persona id. Empty on older panels. */
  reputations: Record<string, string>;
  /** The dossier diversity check, when the proposed panel carried one. */
  panelDiversity: DiversityFlag | null;
  plan: Plan | null;
  planPulse: number;
  feed: FeedItem[];
  /**
   * Every message streaming right now, in the order it started. Usually one;
   * two when someone talks over a speaker. A refresh replays all of them.
   */
  streams: StreamingMsg[];
  /** The spend meter (information only); null on unprofiled (older) debates. */
  budget: BudgetSnapshot | null;
  /** Set while a spent provider allowance has the session parked; says when it resumes. */
  quotaPause: QuotaPause | null;
  /** The floor director's last checkpoint: heat, hands up, the meeting clock. */
  floor: { motionId: string; heat: Record<string, number>; handsUp: string[]; clock: MeetingClock } | null;
  /**
   * Where each expert stands on the open motion, -2..+2: seeded by the
   * `belief` event when a motion opens, moved by each concession. Empty on
   * debates from before the belief ledger.
   */
  beliefs: Record<string, { motionId: string; stance: number; confidence: string }>;
  speaking: { speaker: string | null; phase: 'thinking' | 'talking' | null };
  /** What the room is doing while nobody is speaking. Never persisted. */
  stage: StageFrame | null;
  /** Marcus's model assignments, once he has cast. */
  casting: Casting | null;
  /** The sized session and its projected cost, set at intake. */
  scope: SessionScope | null;
  lastBids: BidRound | null;
  pendingQuestion: QuestionEv | null;
  pendingClarify: ClarifyEv[];  // queue: multiple clarify questions can be open at once
  /**
   * The full clarify batch — answered items included — so the dock can show
   * "Question 2 of 3" and let the founder walk Back to an answer he already
   * gave. `pendingClarify` loses each item the moment it is answered, which is
   * exactly why the old UI presented a batch as N surprise modals with no
   * sense of place. Null when no batch is open; dropped when the engine
   * consumes the answers (status leaves 'clarifying').
   */
  clarifyChain: ClarifyChainItem[] | null;
  pendingApproval: 'goal' | 'panel' | 'plan' | null;
  assumptions: string[];
  research: Record<string, ResearchTask>;
  researchOrder: string[];
  dossier: { files: number; brief: string } | null;
  reportPath: string | null;
  messageCount: number;
  lastSeq: number;
}

export const initialState: DebateState = {
  loaded: false,
  fatal: null,
  connection: 'connecting',
  id: '',
  title: '',
  topic: '',
  status: 'intake',
  config: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  goal: null,
  ownerName: null,
  personas: {},
  personaOrder: [],
  panelRationale: null,
  reputations: {},
  panelDiversity: null,
  plan: null,
  planPulse: 0,
  feed: [],
  streams: [],
  budget: null,
  quotaPause: null,
  floor: null,
  beliefs: {},
  speaking: { speaker: null, phase: null },
  stage: null,
  casting: null,
  scope: null,
  lastBids: null,
  pendingQuestion: null,
  pendingClarify: [],
  clarifyChain: null,
  usage: emptyUsage(),
  decisions: [],
  activeMotion: null,
  motionRound: null,
  amendments: [],
  pendingApproval: null,
  assumptions: [],
  research: {},
  researchOrder: [],
  dossier: null,
  reportPath: null,
  messageCount: 0,
  lastSeq: 0,
};

/** Statuses that get a divider line in the feed. */
const PHASE_DIVIDERS: Partial<Record<DebateStatus, true>> = {
  intake: true,
  panel_design: true,
  planning: true,
  meeting: true,
  wrapup: true,
  reporting: true,
  complete: true,
  paused: true,
  cancelled: true,
  error: true,
};

const APPROVAL_BY_STATUS: Partial<Record<DebateStatus, 'goal' | 'panel' | 'plan'>> = {
  goal_approval: 'goal',
  panel_approval: 'panel',
  plan_approval: 'plan',
};

/** Past these, the room is closed and no answer can change anything. */
const QUESTIONS_CLOSED = new Set<DebateStatus>(['wrapup', 'reporting', 'complete', 'error', 'cancelled']);

function setPersonas(s: DebateState, personas: Persona[]): DebateState {
  const map: Record<string, Persona> = {};
  const order: string[] = [];
  const sorted = [...personas].sort((a, b) => Number(b.isModerator ?? false) - Number(a.isModerator ?? false));
  for (const p of sorted) {
    map[p.id] = p;
    order.push(p.id);
  }
  return { ...s, personas: map, personaOrder: order };
}

function foldEvent(s: DebateState, ev: DebateEvent): DebateState {
  if (ev.seq <= s.lastSeq) return s; // replay overlap guard
  s = { ...s, lastSeq: ev.seq, updatedAt: ev.ts };

  switch (ev.type) {
    case 'status': {
      const pendingApproval = APPROVAL_BY_STATUS[ev.status] ?? null;
      const next: DebateState = { ...s, status: ev.status, pendingApproval };
      // A quota pause only describes a parked room.
      if (ev.status !== 'paused') next.quotaPause = null;
      /**
       * A question cannot outlive the room that asked it.
       *
       * The dock is a modal over the transcript, and it only ever closed on an
       * `answer` event naming the same question. So any path that left the
       * meeting without one leaves it stuck: the founder pressing END
       * mid-question, an autonomous session deciding for itself, an engine
       * fault. Each one left a
       * finished debate permanently behind a prompt for a call nobody is
       * waiting on, with the transcript unreadable underneath it. Reaching a
       * status past the meeting is itself the answer: there is nothing left to
       * ask about.
       */
      // Nobody is mid-sentence once the room has stopped; a stream the server
      // never finalized must not sit on screen with a blinking caret forever.
      // (Not 'paused': a pause lets the turn in flight finish.)
      if (ev.status === 'reporting' || ev.status === 'complete' || ev.status === 'error' || ev.status === 'cancelled') {
        next.streams = [];
      }
      if (QUESTIONS_CLOSED.has(ev.status)) {
        next.pendingQuestion = null;
        next.pendingClarify = [];
        next.clarifyChain = null;
      }
      /**
       * Leaving 'clarifying' means the engine has consumed the batch: the
       * chain is closed and no answer in it can be amended any more. Dropping
       * it on this transition (not only on QUESTIONS_CLOSED) is what stops a
       * finished batch from offering Back/amend on answers the intake agent
       * has already read — and what lets the next batch start clean.
       */
      if (s.status === 'clarifying' && ev.status !== 'clarifying') {
        next.clarifyChain = null;
      }
      if (PHASE_DIVIDERS[ev.status] && ev.status !== s.status) {
        next.feed = [...s.feed, { fk: 'phase', key: `ph-${ev.seq}`, status: ev.status, ts: ev.ts }];
      }
      return next;
    }
    case 'system':
      return { ...s, feed: [...s.feed, { fk: 'system', key: `sy-${ev.seq}`, text: ev.text, ts: ev.ts }] };
    case 'clarify':
      return {
        ...s,
        pendingClarify: [...s.pendingClarify, ev],
        clarifyChain: [...(s.clarifyChain ?? []), { ev, answer: null }],
      };
    case 'goal':
      // The goal names the debate: the room's title stops reading "Untitled" the moment it lands.
      return { ...s, goal: { title: ev.title, goal: ev.goal }, title: ev.title || s.title };
    case 'panel':
      return setPersonas({ ...s, panelRationale: ev.rationale, reputations: ev.publicReputation ?? {}, panelDiversity: ev.diversity ?? null }, ev.personas);
    case 'plan': {
      const bumped = s.plan !== null && ev.plan.revision > s.plan.revision;
      return { ...s, plan: ev.plan, planPulse: bumped ? s.planPulse + 1 : s.planPulse };
    }
    case 'message': {
      // Only THIS message's stream ends; a turn it overlapped may still be going.
      const streams = s.streams.some((m) => m.id === ev.id) ? s.streams.filter((m) => m.id !== ev.id) : s.streams;
      /**
       * The quant desk speaks into the event log so every persona's next turn
       * reads its figures, but it does NOT get a speech bubble: the compute_done
       * card is the same content rendered as what it actually is. Two copies
       * would read as the desk repeating itself.
       */
      if (ev.speaker === 'quant') return { ...s, streams };
      /**
       * Every other kind, 'reaction' included ("On what base?", "No."), is a
       * real turn in the room and goes in the feed. A reaction is decided
       * here, not fallen into: the bubble renders it short.
       */
      return {
        ...s,
        streams,
        messageCount: s.messageCount + 1,
        feed: [...s.feed, { fk: 'msg', key: ev.id, ev }],
      };
    }
    case 'aside':
      return { ...s, feed: [...s.feed, { fk: 'aside', key: `as-${ev.seq}`, from: ev.from, to: ev.to, text: ev.text, ts: ev.ts }] };
    case 'pause':
      return { ...s, feed: [...s.feed, { fk: 'pause', key: `pa-${ev.seq}`, ms: ev.ms, reason: ev.reason, ts: ev.ts }] };
    case 'concession': {
      const c = ev.concession;
      /**
       * Append-only on the server: when the referee later names the cause of a
       * move, or a reversal makes it tactical, a second event arrives with the
       * same messageId. The latest one replaces the chip in place.
       */
      const at = c.messageId ? s.feed.findIndex((f) => f.fk === 'concession' && f.concession.messageId === c.messageId) : -1;
      const feed = at >= 0
        ? s.feed.map((f, i) => (i === at ? { ...f, concession: c } as FeedItem : f))
        : [...s.feed, { fk: 'concession' as const, key: `co-${ev.seq}`, concession: c, ts: ev.ts }];
      return {
        ...s,
        beliefs: { ...s.beliefs, [c.expert]: { motionId: c.motionId, stance: c.to.stance, confidence: c.to.confidence } },
        feed,
      };
    }
    case 'floor':
      return { ...s, floor: { motionId: ev.motionId, heat: ev.heat, handsUp: ev.handsUp, clock: ev.clock } };
    case 'belief': {
      // The ledger's starting point for a motion: replaces the last motion's stances.
      const beliefs: DebateState['beliefs'] = {};
      for (const b of ev.beliefs) beliefs[b.expert] = { motionId: b.motionId, stance: b.stance, confidence: b.confidence };
      return { ...s, beliefs };
    }
    case 'budget':
      return { ...s, budget: ev.budget };
    case 'quota':
      return { ...s, quotaPause: ev.pause };
    case 'bids':
      return { ...s, lastBids: { round: ev.round, bids: ev.bids, winner: ev.winner, at: ev.ts } };
    case 'scope':
      return { ...s, scope: ev.scope };
    case 'casting':
      return {
        ...s,
        casting: ev.casting,
        feed: [...s.feed, { fk: 'casting', key: `ca-${ev.seq}`, casting: ev.casting, ts: ev.ts }],
      };
    case 'floor_set':
      // The chair's note. Marcus assigns the floor instead of taking bids, so
      // this is the only visible account of how the room is being steered.
      return {
        ...s,
        feed: [...s.feed, { fk: 'floor', key: `fl-${ev.seq}`, round: ev.round, why: ev.why, slate: ev.slate, ts: ev.ts }],
      };
    case 'question':
      return { ...s, pendingQuestion: ev };
    case 'answer': {
      const next: DebateState = { ...s };
      if (s.pendingQuestion?.questionId === ev.questionId) next.pendingQuestion = null;
      next.pendingClarify = s.pendingClarify.filter((c) => c.questionId !== ev.questionId);
      // The chain keeps the item and records the answer (latest wins, so an
      // amended answer republished by the server lands here too). Replay
      // rebuilds this on refresh: Back still shows what was said.
      if (s.clarifyChain?.some((it) => it.ev.questionId === ev.questionId)) {
        next.clarifyChain = s.clarifyChain.map((it) =>
          it.ev.questionId === ev.questionId ? { ...it, answer: ev.answer } : it,
        );
      }
      next.feed = [...s.feed, { fk: 'answer', key: `an-${ev.seq}`, text: ev.answer, ts: ev.ts }];
      return next;
    }
    case 'assumption':
      return { ...s, assumptions: [...s.assumptions, ev.text] };
    case 'research_started': {
      const research = { ...s.research, [ev.taskId]: { taskId: ev.taskId, question: ev.question, status: 'started' as const } };
      const researchOrder = s.researchOrder.includes(ev.taskId) ? s.researchOrder : [...s.researchOrder, ev.taskId];
      return { ...s, research, researchOrder };
    }
    case 'research_done': {
      const prev = s.research[ev.taskId];
      const research = {
        ...s.research,
        [ev.taskId]: {
          taskId: ev.taskId,
          question: prev?.question ?? '',
          summary: ev.result?.summary || ev.summary,
          status: 'done' as const,
          ...(ev.result?.citations?.length ? { citations: ev.result.citations } : {}),
        },
      };
      const researchOrder = s.researchOrder.includes(ev.taskId) ? s.researchOrder : [...s.researchOrder, ev.taskId];
      return { ...s, research, researchOrder };
    }
    /**
     * The quant desk's answer lands in the feed as a card, not a bubble. It is
     * not another opinion and it must not look like one: it is the only thing
     * in the transcript that was computed rather than argued.
     */
    case 'compute_done':
      return {
        ...s,
        feed: [...s.feed, {
          fk: 'compute', key: `cq-${ev.seq}`, question: ev.question, answer: ev.answer,
          computable: ev.computable, figures: ev.figures, method: ev.method,
          reconciles: ev.reconciles, caveats: ev.caveats, ts: ev.ts,
        }],
      };
    case 'compute_started':
      return s;   // the stage panel already shows the desk working
    case 'audit':
      return {
        ...s,
        feed: [...s.feed, { fk: 'audit', key: `au-${ev.seq}`, checked: ev.checked, summary: ev.summary, findings: ev.findings, ts: ev.ts }],
      };
    case 'convergence':
      return { ...s, feed: [...s.feed, { fk: 'convergence', key: `cv-${ev.seq}`, verdict: ev.verdict, note: ev.note, ts: ev.ts }] };
    case 'context_brief':
      return {
        ...s,
        dossier: { files: ev.files, brief: ev.brief },
        feed: [...s.feed, { fk: 'dossier', key: `dx-${ev.seq}`, files: ev.files, brief: ev.brief, ts: ev.ts }],
      };
    case 'motion_open':
      return {
        ...s,
        activeMotion: { motionId: ev.motionId, index: ev.index, total: ev.total, title: ev.title, motion: ev.motion },
        motionRound: null,
        feed: [...s.feed, { fk: 'motion', key: `mo-${ev.seq}`, index: ev.index, total: ev.total, title: ev.title, motion: ev.motion, ts: ev.ts }],
      };
    case 'round':
      return { ...s, motionRound: { round: ev.round, rung: ev.rung ?? 0, rungName: ev.rungName ?? '' } };
    case 'decision':
      return {
        ...s,
        decisions: [...s.decisions, ev.decision],
        feed: [...s.feed, { fk: 'decision', key: `dc-${ev.seq}`, decision: ev.decision, ts: ev.ts }],
      };
    case 'motion_closed':
      return { ...s, activeMotion: null, motionRound: null };
    /**
     * A ruling the room later disproved is pulled from the decision list rather
     * than left sitting there with a note: the founder reads that list as what
     * has been settled, and a vacated ruling in it is worse than no ruling. The
     * feed keeps the history, because the fact that the room reversed itself is
     * itself worth watching.
     */
    case 'motion_reopened':
      return {
        ...s,
        decisions: s.decisions.filter((d) => d.motionId !== ev.motionId),
        feed: [...s.feed, {
          fk: 'system',
          key: `ro-${ev.seq}`,
          text: `Motion reopened: "${ev.title}". ${ev.because} The earlier ruling is vacated and the room will argue it again.`,
          ts: ev.ts,
        }],
      };
    case 'panel_amended': {
      const next = setPersonas(s, [...s.personaOrder.map((id) => s.personas[id]).filter(Boolean), ev.persona]);
      return {
        ...next,
        amendments: [...s.amendments, { persona: ev.persona, reason: ev.reason }],
        feed: [...s.feed, { fk: 'amend', key: `am-${ev.seq}`, name: ev.persona.name, role: ev.persona.role, reason: ev.reason, ts: ev.ts }],
      };
    }
    case 'progress':
      return ev.usage ? { ...s, usage: ev.usage } : s;
    case 'report_ready':
      return { ...s, reportPath: ev.path };
    case 'error':
      return { ...s, feed: [...s.feed, { fk: 'error', key: `er-${ev.seq}`, text: ev.message, ts: ev.ts }] };
    default:
      // Unknown / future event types must never crash the reducer.
      return s;
  }
}

function foldLive(s: DebateState, f: LiveFrame): DebateState {
  switch (f.type) {
    case 'delta': {
      if (s.streams.some((m) => m.id === f.messageId)) {
        return { ...s, streams: s.streams.map((m) => (m.id === f.messageId ? { ...m, text: m.text + f.textDelta } : m)) };
      }
      // New (or synthetic full-partial) streaming message, alongside any already going.
      if (s.feed.some((it) => it.fk === 'msg' && it.key === f.messageId)) return s; // already finalized
      return { ...s, streams: [...s.streams, { id: f.messageId, speaker: f.speaker, kind: f.kind, text: f.textDelta }] };
    }
    case 'budget':
      return { ...s, budget: f.budget };
    case 'speaking':
      return { ...s, speaking: { speaker: f.speaker, phase: f.phase } };
    case 'usage':
      return { ...s, usage: f.usage };
    case 'stage':
      // `done` clears the stage; anything else replaces it. A stage is never
      // merged into the feed: it is what the room is doing NOW, not history.
      return { ...s, stage: f.done ? null : f };
    case 'ping':
      return s;
    default:
      return s; // unknown live frames are ignored, never fatal
  }
}

/**
 * Overlay the authoritative snapshot fields from DebateDetail.
 * Pending clarify state is rebuilt by the event replay itself (clarify events
 * without a matching answer), since DebateDetail has no field for it.
 */
function overlayPendings(s: DebateState, detail: DebateDetail): DebateState {
  return {
    ...s,
    pendingQuestion: detail.pendingQuestion ?? s.pendingQuestion,
    pendingApproval: detail.pendingApproval ?? APPROVAL_BY_STATUS[detail.status] ?? null,
  };
}

export type Action =
  | { type: 'bootstrap'; detail: DebateDetail }
  | { type: 'merge'; detail: DebateDetail }
  | { type: 'frame'; frame: WireFrame }
  | { type: 'conn'; v: DebateState['connection'] }
  | { type: 'fatal'; message: string };

function isPersisted(f: WireFrame): f is DebateEvent {
  return 'seq' in f;
}

export function reducer(s: DebateState, a: Action): DebateState {
  switch (a.type) {
    case 'bootstrap': {
      const d = a.detail;
      let next: DebateState = {
        ...initialState,
        loaded: true,
        connection: s.connection,
        id: d.id,
        title: d.title,
        topic: d.topic,
        status: d.status,
        config: d.config,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        goal: d.goal ? { title: 'Mission goal', goal: d.goal } : null,
        ownerName: d.ownerName ?? null,
      };
      next = setPersonas(next, d.personas);
      for (const ev of d.events) next = foldEvent(next, ev);
      // Detail fields are authoritative for the snapshot.
      next.status = d.status;
      next.plan = d.plan ?? next.plan;
      next.messageCount = Math.max(next.messageCount, d.messageCount);
      if (d.decisions?.length) next.decisions = d.decisions;
      if (d.usage) next.usage = d.usage;
      next.planPulse = 0;
      next = overlayPendings(next, d);
      return next;
    }
    case 'merge': {
      let next = s;
      for (const ev of a.detail.events) next = foldEvent(next, ev);
      // Keep the owner name fresh: a merge is a full re-read of the snapshot,
      // and a rename between polls must not leave a stale label on screen.
      next = { ...next, status: a.detail.status, ownerName: a.detail.ownerName ?? next.ownerName };
      next = overlayPendings(next, a.detail);
      return next;
    }
    case 'frame':
      return isPersisted(a.frame) ? foldEvent(s, a.frame) : foldLive(s, a.frame);
    case 'conn':
      return s.connection === a.v ? s : { ...s, connection: a.v };
    case 'fatal':
      return { ...s, fatal: a.message, loaded: true };
  }
}
