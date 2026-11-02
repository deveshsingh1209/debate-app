/**
 * The belief ledger (docs/PHASE2-PLAN.md, 2c): per expert, per motion, where
 * they stand, and every time that moves, what moved it and what it cost.
 *
 * A pure reducer. `reduceLedger(state, input)` returns a new state and the
 * things the engine should do about it: persist a `belief` or `concession`
 * event, or raise a flag (an unexplained move, a herd, a missing trailer) for
 * the referee or the chair. No model, no engine, no I/O; the same inputs in
 * the same order always give the same state and the same emits.
 *
 * Inputs come from places that already exist or are planned:
 *   open        motion opens; starting stances from the clerk call or first trailers
 *   turn        a spoken turn; `report` is the parsed STANCE trailer line, absent if forgotten
 *   evidence    research landed or the quant desk computed something
 *   attribute   the referee names the cause of a move the trailer did not explain
 *   audit       the referee's stated-vs-revealed read of an expert
 *   checkpoint  a referee checkpoint: herd and drift detection over the window
 *
 * Privacy: the ledger never goes into the shared prefix. `ownBelief` gives an
 * expert their own belief for their voice card, and nobody else's.
 */
import type { Belief, Concession, Confidence, Stance } from '../../../shared/types.ts';

// ---------- rules ----------

export const LEDGER_RULES = {
  /** At or above this stubbornness, an unexplained concession is a chair trigger. */
  stubbornTrigger: 0.6,
  /** Consecutive turns without a trailer before the referee is asked to fill the gap. */
  missFlagAfter: 2,
  /** Distinct experts moving the same way inside one checkpoint, with no evidence between, is a herd. */
  herdSize: 3,
  /** A move reversed within this many of the expert's own turns, with no new cause, was tactical. */
  tacticalWindowTurns: 3,
  /** Polarisation falling to this share of its opening value (from at least 1.0) is drift to the middle. */
  driftShare: 0.5,
  /** Stated and revealed stance this far apart (or on opposite sides) is flagged. */
  auditGap: 2,
} as const;

export type Cause = Concession['movedBy']['kind'];
export const CAUSES: readonly Cause[] = ['evidence', 'computation', 'argument', 'falsifier', 'founder', 'social', 'unexplained'];

/**
 * Which causes count as a real reason for a person this stubborn to move on
 * their thesis. Enforced socially (a flag, a chair question), never by editing
 * what they said.
 */
export function allowedCauses(stubbornness: number): Cause[] {
  if (stubbornness >= 0.7) return ['evidence', 'computation', 'falsifier'];
  if (stubbornness >= 0.4) return ['evidence', 'computation', 'falsifier', 'argument', 'founder'];
  return ['evidence', 'computation', 'falsifier', 'argument', 'founder', 'social'];
}

// ---------- the STANCE trailer line ----------

/** One parsed STANCE trailer line. The 2b-3 trailer splitter hands the line's value to `parseStanceLine`. */
export interface StanceReport {
  stance: Stance;
  confidence: Confidence;
  crux?: string;
  reasons?: string[];
  movedBy?: Concession['movedBy'];
  kind?: Concession['kind'];
  cost?: string;
}

const STANCE_WORDS: Record<string, Stance> = {
  'against-2': -2, 'against-1': -1, 'against': -1, '0': 0, 'neutral': 0, 'undecided': 0, 'for+1': 1, 'for': 1, 'for+2': 2,
  '-2': -2, '-1': -1, '+1': 1, '1': 1, '+2': 2, '2': 2,
};

/** Human words for a stance, for summaries and voice cards. */
export const STANCE_LABEL: Record<Stance, string> = {
  [-2]: 'firmly against', [-1]: 'leaning against', 0: 'undecided', 1: 'leaning for', 2: 'firmly for',
};

/**
 * Parse the value of a STANCE line, e.g.
 *   `for+1 | confidence: medium | crux: first-cohort churn under 3% | moved: evidence c_ab12 | cost: my pilot budget`
 * Returns null when the stance itself cannot be read (the turn then counts as
 * a missing trailer and the last stance carries forward). Unknown keys are
 * ignored; a bad confidence defaults to 'medium'.
 */
export function parseStanceLine(value: string): StanceReport | null {
  const parts = value.replace(/^\s*\**\s*stance\s*:\s*/i, '').split('|').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const key = parts[0].toLowerCase().replace(/\*+/g, '').replace(/\s+/g, '');
  const stance = STANCE_WORDS[key];
  if (stance === undefined) return null;
  const out: StanceReport = { stance, confidence: 'medium' };
  for (const p of parts.slice(1)) {
    const m = /^([a-z ]+?)\s*:\s*(.+)$/i.exec(p);
    if (!m) continue;
    const k = m[1].trim().toLowerCase();
    const v = m[2].trim();
    if (k === 'confidence' && ['low', 'medium', 'high'].includes(v.toLowerCase())) out.confidence = v.toLowerCase() as Confidence;
    else if (k === 'crux') out.crux = v;
    else if (k === 'reasons' || k === 'reason') out.reasons = v.split(/;\s*/).filter(Boolean);
    else if (k === 'cost') out.cost = v;
    else if (k === 'kind' && ['full', 'partial', 'conditional', 'tactical'].includes(v.toLowerCase())) out.kind = v.toLowerCase() as Concession['kind'];
    else if (k === 'moved' || k === 'moved by') {
      const mm = /^(\w+)(?:\s+(?!by\b)(\S+))?(?:\s+by\s+(\S+))?/i.exec(v);
      const kind = mm?.[1].toLowerCase() as Cause | undefined;
      if (kind && CAUSES.includes(kind)) {
        out.movedBy = { kind, ...(mm![2] ? { ref: mm![2] } : {}), ...(mm![3] ? { who: mm![3] } : {}) };
      }
    }
  }
  return out;
}

// ---------- state ----------

export interface ExpertTraits {
  /** 0..1 from the dossier. Absent: 0.5. */
  stubbornness: number;
  /** Walking this back is the cost of a full concession. */
  priorPublicStance?: string;
}

/** A concession as the ledger keeps it: the persisted shape plus where it sits in the log. */
export interface LedgerConcession extends Concession {
  seq: number;
}

/** Moving further out on one's own side. Not a concession; tracked for the summary and herd detection. */
export interface Hardening {
  expert: string;
  from: Stance;
  to: Stance;
  seq: number;
  messageId: string;
  movedBy?: Concession['movedBy'];
}

export type LedgerFlag =
  | { kind: 'unexplained_move'; motionId: string; expert: string; messageId: string; seq: number; stubbornness: number; chairTrigger: boolean; candidates: string[]; resolved?: boolean }
  | { kind: 'weak_cause'; motionId: string; expert: string; messageId: string; seq: number; cause: Cause; allowed: Cause[]; chairTrigger: boolean }
  | { kind: 'unknown_ref'; motionId: string; expert: string; messageId: string; ref: string }
  | { kind: 'missing_trailer'; motionId: string; expert: string; seq: number; misses: number }
  | { kind: 'no_stance'; motionId: string; expert: string; seq: number }
  | { kind: 'herd'; motionId: string; seq: number; sinceSeq: number; direction: 1 | -1; experts: string[]; chairTrigger: true }
  | { kind: 'drift_to_middle'; motionId: string; seq: number; from: number; to: number; chairTrigger: true }
  | { kind: 'stated_vs_revealed'; motionId: string; expert: string; seq: number; stated: Stance; revealed: Stance; note?: string }
  | { kind: 'tactical_reversal'; motionId: string; expert: string; messageId: string; seq: number };

export interface MotionLedger {
  motionId: string;
  openSeq: number;
  /** Seq of the last checkpoint: the herd window starts here. */
  windowSeq: number;
  opening: Record<string, Belief>;
  beliefs: Record<string, Belief>;
  concessions: LedgerConcession[];
  hardenings: Hardening[];
  evidence: { seq: number; kind: 'evidence' | 'computation'; ref: string }[];
  /** Consecutive turns without a readable trailer, per expert. */
  misses: Record<string, number>;
  /** Turns spoken per expert in this motion (tactical-reversal window). */
  turns: Record<string, number>;
  /** The expert's own turn count at each concession, keyed by message id. */
  concessionTurn: Record<string, number>;
  flags: LedgerFlag[];
  driftFlagged: boolean;
}

export interface LedgerState {
  traits: Record<string, ExpertTraits>;
  motions: Record<string, MotionLedger>;
}

export function newLedger(traits: Record<string, Partial<ExpertTraits>> = {}): LedgerState {
  const t: Record<string, ExpertTraits> = {};
  for (const [id, x] of Object.entries(traits)) t[id] = { stubbornness: x.stubbornness ?? 0.5, ...(x.priorPublicStance ? { priorPublicStance: x.priorPublicStance } : {}) };
  return { traits: t, motions: {} };
}

// ---------- inputs and outputs ----------

export type LedgerInput =
  | { type: 'open'; motionId: string; seq: number; beliefs: Belief[] }
  | { type: 'turn'; motionId: string; seq: number; expert: string; messageId: string; report?: StanceReport | null }
  | { type: 'evidence'; motionId: string; seq: number; kind: 'evidence' | 'computation'; ref: string }
  | { type: 'attribute'; motionId: string; messageId: string; movedBy: Concession['movedBy'] }
  | { type: 'audit'; motionId: string; seq: number; expert: string; revealed: Stance; note?: string }
  | { type: 'checkpoint'; motionId: string; seq: number };

export type LedgerEmit =
  /** Persist as a `belief` event (starting stances). */
  | { type: 'belief'; motionId: string; beliefs: Belief[] }
  /** Persist as a `concession` event. */
  | { type: 'concession'; concession: Concession }
  /** The referee filled in a cause, or a reversal reclassified it. Persist as a new `concession` event with the same messageId; readers keep the latest per messageId. */
  | { type: 'concession_update'; concession: Concession }
  /** For the referee and the chair's triggers. */
  | { type: 'flag'; flag: LedgerFlag };

export interface LedgerStep {
  state: LedgerState;
  emits: LedgerEmit[];
}

// ---------- helpers ----------

const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const stubOf = (s: LedgerState, id: string) => s.traits[id]?.stubbornness ?? 0.5;

function motion(s: LedgerState, motionId: string, seq: number): MotionLedger {
  return (s.motions[motionId] ??= {
    motionId, openSeq: seq, windowSeq: seq, opening: {}, beliefs: {}, concessions: [], hardenings: [], evidence: [],
    misses: {}, turns: {}, concessionTurn: {}, flags: [], driftFlagged: false,
  });
}

/** Moving further from zero on the side one was already on. */
export const isHardening = (from: number, to: number) => sign(from) !== 0 && sign(from) === sign(to) && Math.abs(to) > Math.abs(from);

/**
 * What kind of concession a move is, when the trailer does not say:
 * crossing to the other side (or from a firm side to undecided and beyond) is
 * full; anything shorter is partial. 'conditional' and 'tactical' come from
 * the trailer or from a later reversal.
 */
export function classifyMove(from: Stance, to: Stance): Concession['kind'] {
  return sign(from) !== 0 && sign(to) === -sign(from) ? 'full' : 'partial';
}

function costOf(kind: Concession['kind'], from: Stance, to: Stance, traits?: ExpertTraits): string {
  if (kind === 'full' && traits?.priorPublicStance) return `walks back a public stance: ${traits.priorPublicStance}`;
  if (kind === 'full') return 'gives up their opening side';
  if (Math.abs(from) === 2) return 'gives up a firm position';
  return 'face';
}

const strip = (c: LedgerConcession): Concession => {
  const { seq: _seq, ...rest } = c;
  return rest;
};

const polarisation = (beliefs: Record<string, Belief>) => {
  const v = Object.values(beliefs);
  return v.length ? v.reduce((a, b) => a + Math.abs(b.stance), 0) / v.length : 0;
};

// ---------- the reducer ----------

export function reduceLedger(prev: LedgerState, input: LedgerInput): LedgerStep {
  const s = structuredClone(prev);
  const emits: LedgerEmit[] = [];
  const flag = (m: MotionLedger, f: LedgerFlag) => {
    m.flags.push(f);
    emits.push({ type: 'flag', flag: f });
  };

  switch (input.type) {
    case 'open': {
      const m = motion(s, input.motionId, input.seq);
      for (const b of input.beliefs) {
        if (b.motionId !== input.motionId || m.beliefs[b.expert]) continue;
        const belief = { ...b, reasons: [...b.reasons], sinceSeq: b.sinceSeq ?? input.seq };
        m.opening[b.expert] = belief;
        m.beliefs[b.expert] = structuredClone(belief);
      }
      emits.push({ type: 'belief', motionId: input.motionId, beliefs: Object.values(m.opening).map((b) => structuredClone(b)) });
      break;
    }

    case 'evidence': {
      const m = motion(s, input.motionId, input.seq);
      m.evidence.push({ seq: input.seq, kind: input.kind, ref: input.ref });
      break;
    }

    case 'turn': {
      const m = motion(s, input.motionId, input.seq);
      const { expert, seq, messageId, report } = input;
      m.turns[expert] = (m.turns[expert] ?? 0) + 1;
      const cur = m.beliefs[expert];

      if (!report) {
        // Carry forward: the last stance stands; the referee fills gaps.
        m.misses[expert] = (m.misses[expert] ?? 0) + 1;
        if (!cur) {
          if (!m.flags.some((f) => f.kind === 'no_stance' && f.expert === expert)) flag(m, { kind: 'no_stance', motionId: m.motionId, expert, seq });
        } else if (m.misses[expert] === LEDGER_RULES.missFlagAfter) {
          flag(m, { kind: 'missing_trailer', motionId: m.motionId, expert, seq, misses: m.misses[expert] });
        }
        break;
      }
      m.misses[expert] = 0;

      if (!cur) {
        // First stance heard in this motion: it is their starting belief.
        const b: Belief = { expert, motionId: m.motionId, stance: report.stance, confidence: report.confidence, crux: report.crux ?? '', reasons: report.reasons ?? [], sinceSeq: seq };
        m.opening[expert] = b;
        m.beliefs[expert] = structuredClone(b);
        emits.push({ type: 'belief', motionId: m.motionId, beliefs: [structuredClone(b)] });
        break;
      }

      const from = cur.stance;
      const to = report.stance;
      const next: Belief = {
        ...cur,
        stance: to,
        confidence: report.confidence,
        crux: report.crux ?? cur.crux,
        reasons: report.reasons ?? cur.reasons,
        sinceSeq: from === to ? cur.sinceSeq : seq,
      };
      m.beliefs[expert] = next;
      if (from === to) break;

      if (isHardening(from, to)) {
        m.hardenings.push({ expert, from, to, seq, messageId, ...(report.movedBy ? { movedBy: report.movedBy } : {}) });
        // Back out to where they were right after conceding, with no new cause: the concession was tactical.
        const last = [...m.concessions].reverse().find((c) => c.expert === expert);
        const strong = report.movedBy && ['evidence', 'computation', 'falsifier'].includes(report.movedBy.kind);
        if (last && last.kind !== 'tactical' && !strong && last.from.stance === to &&
            m.turns[expert] - (m.concessionTurn[last.messageId] ?? 0) <= LEDGER_RULES.tacticalWindowTurns) {
          last.kind = 'tactical';
          emits.push({ type: 'concession_update', concession: strip(last) });
          flag(m, { kind: 'tactical_reversal', motionId: m.motionId, expert, messageId: last.messageId, seq });
        }
        break;
      }

      // A concession: a move toward the other side, or off the fence.
      const traits = s.traits[expert];
      const kind = report.kind ?? classifyMove(from, to);
      const movedBy: Concession['movedBy'] = report.movedBy ?? { kind: 'unexplained' };
      const c: LedgerConcession = {
        motionId: m.motionId,
        expert,
        from: { stance: from, confidence: cur.confidence },
        to: { stance: to, confidence: report.confidence },
        kind,
        movedBy,
        cost: report.cost ?? costOf(kind, from, to, traits),
        messageId,
        seq,
      };
      m.concessions.push(c);
      m.concessionTurn[messageId] = m.turns[expert];
      emits.push({ type: 'concession', concession: strip(c) });

      const stub = stubOf(s, expert);
      if (movedBy.kind === 'unexplained') {
        const candidates = m.evidence.filter((e) => e.seq > cur.sinceSeq && e.seq <= seq).map((e) => e.ref);
        flag(m, { kind: 'unexplained_move', motionId: m.motionId, expert, messageId, seq, stubbornness: stub, chairTrigger: stub >= LEDGER_RULES.stubbornTrigger, candidates });
      } else {
        checkCause(m, c, stub, flag);
      }
      break;
    }

    case 'attribute': {
      const m = s.motions[input.motionId];
      const c = m?.concessions.find((x) => x.messageId === input.messageId);
      if (!m || !c) break;
      c.movedBy = { ...input.movedBy };
      for (const f of m.flags) if (f.kind === 'unexplained_move' && f.messageId === c.messageId) f.resolved = input.movedBy.kind !== 'unexplained';
      emits.push({ type: 'concession_update', concession: strip(c) });
      if (input.movedBy.kind !== 'unexplained') checkCause(m, c, stubOf(s, c.expert), flag);
      break;
    }

    case 'audit': {
      const m = s.motions[input.motionId];
      const b = m?.beliefs[input.expert];
      if (!m || !b) break;
      const gap = Math.abs(b.stance - input.revealed);
      if (gap >= LEDGER_RULES.auditGap || sign(b.stance) * sign(input.revealed) < 0) {
        flag(m, { kind: 'stated_vs_revealed', motionId: m.motionId, expert: input.expert, seq: input.seq, stated: b.stance, revealed: input.revealed, ...(input.note ? { note: input.note } : {}) });
      }
      break;
    }

    case 'checkpoint': {
      const m = motion(s, input.motionId, input.seq);
      const herd = detectHerd(m, m.windowSeq, input.seq);
      if (herd) flag(m, { kind: 'herd', motionId: m.motionId, seq: input.seq, sinceSeq: m.windowSeq, direction: herd.direction, experts: herd.experts, chairTrigger: true });
      const p0 = polarisation(m.opening);
      const p1 = polarisation(m.beliefs);
      if (!m.driftFlagged && p0 >= 1 && p1 <= p0 * LEDGER_RULES.driftShare) {
        m.driftFlagged = true;
        flag(m, { kind: 'drift_to_middle', motionId: m.motionId, seq: input.seq, from: p0, to: p1, chairTrigger: true });
      }
      m.windowSeq = input.seq;
      break;
    }
  }
  return { state: s, emits };
}

function checkCause(m: MotionLedger, c: LedgerConcession, stub: number, flag: (m: MotionLedger, f: LedgerFlag) => void) {
  const allowed = allowedCauses(stub);
  if (!allowed.includes(c.movedBy.kind)) {
    flag(m, { kind: 'weak_cause', motionId: m.motionId, expert: c.expert, messageId: c.messageId, seq: c.seq, cause: c.movedBy.kind, allowed, chairTrigger: stub >= 0.7 });
  }
  if ((c.movedBy.kind === 'evidence' || c.movedBy.kind === 'computation') && c.movedBy.ref && !m.evidence.some((e) => e.ref === c.movedBy.ref)) {
    flag(m, { kind: 'unknown_ref', motionId: m.motionId, expert: c.expert, messageId: c.messageId, ref: c.movedBy.ref });
  }
}

/**
 * Herding: at least `herdSize` distinct experts moved the same way in
 * (sinceSeq, uptoSeq], and no evidence or computation landed in that window
 * up to the last of those moves. Moves that themselves cite evidence or a
 * computation do not count. Hardenings count: moving further out in the same
 * direction as the crowd is joining it.
 */
export function detectHerd(m: MotionLedger, sinceSeq: number, uptoSeq: number): { direction: 1 | -1; experts: string[] } | null {
  type Move = { expert: string; dir: number; seq: number };
  const moves: Move[] = [
    ...m.concessions
      .filter((c) => c.seq > sinceSeq && c.seq <= uptoSeq && !['evidence', 'computation'].includes(c.movedBy.kind))
      .map((c) => ({ expert: c.expert, dir: sign(c.to.stance - c.from.stance), seq: c.seq })),
    ...m.hardenings
      .filter((h) => h.seq > sinceSeq && h.seq <= uptoSeq && !['evidence', 'computation'].includes(h.movedBy?.kind ?? ''))
      .map((h) => ({ expert: h.expert, dir: sign(h.to - h.from), seq: h.seq })),
  ];
  for (const dir of [1, -1] as const) {
    const same = moves.filter((x) => x.dir === dir);
    // Net direction per expert inside the window: someone who moved both ways is not herding.
    const experts = [...new Set(same.map((x) => x.expert))].filter((e) => !moves.some((x) => x.expert === e && x.dir === -dir)).sort();
    if (experts.length < LEDGER_RULES.herdSize) continue;
    const lastSeq = Math.max(...same.filter((x) => experts.includes(x.expert)).map((x) => x.seq));
    if (m.evidence.some((e) => e.seq > sinceSeq && e.seq <= lastSeq)) continue;
    return { direction: dir, experts };
  }
  return null;
}

/** Fold a whole input sequence. Handy for tests, replays and rebuilding from the event log. */
export function foldLedger(state: LedgerState, inputs: readonly LedgerInput[]): LedgerStep {
  let st = state;
  const emits: LedgerEmit[] = [];
  for (const i of inputs) {
    const r = reduceLedger(st, i);
    st = r.state;
    emits.push(...r.emits);
  }
  return { state: st, emits };
}

/** An expert's own current belief on a motion, for their voice card. Never anyone else's. */
export function ownBelief(s: LedgerState, motionId: string, expert: string): Belief | undefined {
  const b = s.motions[motionId]?.beliefs[expert];
  return b ? structuredClone(b) : undefined;
}

/** Open chair triggers from the ledger: unresolved unexplained moves by stubborn experts, herds, drift. */
export function ledgerChairTriggers(s: LedgerState, motionId: string, sinceSeq = -Infinity): LedgerFlag[] {
  const m = s.motions[motionId];
  if (!m) return [];
  return m.flags.filter((f) => {
    if (!('chairTrigger' in f) || !f.chairTrigger) return false;
    if (f.kind === 'unexplained_move' && f.resolved) return false;
    return 'seq' in f && f.seq > sinceSeq;
  });
}

// ---------- "how minds changed": summary data for the report ----------

export interface MindMove {
  from: Stance;
  to: Stance;
  kind: Concession['kind'];
  movedBy: Concession['movedBy'];
  cost: string;
  messageId: string;
  seq: number;
}

export interface ExpertMindChange {
  expert: string;
  start?: { stance: Stance; confidence: Confidence };
  end?: { stance: Stance; confidence: Confidence };
  /** end - start, in stance points. */
  net: number;
  /** Crossed to the other side, or moved two or more points net toward it. */
  changedMind: boolean;
  moves: MindMove[];
  hardened: number;
  unexplained: number;
  /** Never conceded a point. */
  heldFirm: boolean;
}

export interface MindChangeSummary {
  motionId: string;
  experts: ExpertMindChange[];
  /** Experts whose mind changed, in seat order. */
  changedMinds: string[];
  heldFirm: string[];
  /** Evidence and computations that moved someone, with who they moved. */
  evidenceThatMoved: { ref: string; kind: 'evidence' | 'computation'; moved: string[] }[];
  /** Arguments by a named colleague that moved someone. */
  persuaders: { who: string; moved: string[] }[];
  causes: Record<Cause, number>;
  /** Share of concessions with a recorded cause (target at least 0.8). */
  causedShare: number;
  concessions: number;
  herds: number;
  unexplainedOpen: number;
  polarisation: { start: number; end: number };
}

/** The data behind the report section "how minds changed", for one motion. Seat order follows `order` if given. */
export function mindChanges(s: LedgerState, motionId: string, order?: readonly string[]): MindChangeSummary {
  const m = s.motions[motionId];
  const causes = Object.fromEntries(CAUSES.map((c) => [c, 0])) as Record<Cause, number>;
  if (!m) {
    return { motionId, experts: [], changedMinds: [], heldFirm: [], evidenceThatMoved: [], persuaders: [], causes, causedShare: 0, concessions: 0, herds: 0, unexplainedOpen: 0, polarisation: { start: 0, end: 0 } };
  }
  const ids = [...new Set([...(order ?? []), ...Object.keys(m.opening), ...Object.keys(m.beliefs)])].filter((id) => m.beliefs[id] || m.opening[id]);
  const experts: ExpertMindChange[] = ids.map((expert) => {
    const st = m.opening[expert];
    const en = m.beliefs[expert];
    const moves = m.concessions.filter((c) => c.expert === expert).map((c) => ({
      from: c.from.stance as Stance, to: c.to.stance as Stance, kind: c.kind, movedBy: c.movedBy, cost: c.cost, messageId: c.messageId, seq: c.seq,
    }));
    const net = st && en ? en.stance - st.stance : 0;
    const crossed = !!st && !!en && sign(st.stance) !== 0 && sign(en.stance) === -sign(st.stance);
    const towardOther = !!st && sign(st.stance) !== 0 ? -sign(st.stance) * net : Math.abs(net);
    return {
      expert,
      ...(st ? { start: { stance: st.stance, confidence: st.confidence } } : {}),
      ...(en ? { end: { stance: en.stance, confidence: en.confidence } } : {}),
      net,
      changedMind: crossed || towardOther >= 2,
      moves,
      hardened: m.hardenings.filter((h) => h.expert === expert).length,
      unexplained: moves.filter((x) => x.movedBy.kind === 'unexplained').length,
      heldFirm: moves.length === 0,
    };
  });
  const ev = new Map<string, { ref: string; kind: 'evidence' | 'computation'; moved: string[] }>();
  const pers = new Map<string, string[]>();
  for (const c of m.concessions) {
    causes[c.movedBy.kind]++;
    if ((c.movedBy.kind === 'evidence' || c.movedBy.kind === 'computation') && c.movedBy.ref) {
      const e = ev.get(c.movedBy.ref) ?? { ref: c.movedBy.ref, kind: c.movedBy.kind, moved: [] };
      if (!e.moved.includes(c.expert)) e.moved.push(c.expert);
      ev.set(c.movedBy.ref, e);
    }
    if (c.movedBy.who && c.movedBy.who !== c.expert) {
      const l = pers.get(c.movedBy.who) ?? [];
      if (!l.includes(c.expert)) l.push(c.expert);
      pers.set(c.movedBy.who, l);
    }
  }
  const n = m.concessions.length;
  return {
    motionId,
    experts,
    changedMinds: experts.filter((e) => e.changedMind).map((e) => e.expert),
    heldFirm: experts.filter((e) => e.heldFirm).map((e) => e.expert),
    evidenceThatMoved: [...ev.values()],
    persuaders: [...pers.entries()].map(([who, moved]) => ({ who, moved })),
    causes,
    causedShare: n ? (n - causes.unexplained) / n : 1,
    concessions: n,
    herds: m.flags.filter((f) => f.kind === 'herd').length,
    unexplainedOpen: m.flags.filter((f) => f.kind === 'unexplained_move' && !f.resolved).length,
    polarisation: { start: polarisation(m.opening), end: polarisation(m.beliefs) },
  };
}

const causeText = (b: Concession['movedBy'], nameOf: (id: string) => string) => {
  const by = b.who ? ` from ${nameOf(b.who)}` : '';
  switch (b.kind) {
    case 'evidence': return `evidence${b.ref ? ` [${b.ref}]` : ''}${by}`;
    case 'computation': return `a computed figure${b.ref ? ` [${b.ref}]` : ''}${by}`;
    case 'argument': return `an argument${by}`;
    case 'falsifier': return 'the observation they had said would flip them';
    case 'founder': return "the founder's answer";
    case 'social': return `pressure from the room${by}`;
    case 'unexplained': return 'nothing on the record';
  }
};

/**
 * Plain text of "how minds changed" for one motion: who changed their mind,
 * what moved them, what it cost; who held firm; the evidence that moved the
 * room. Neutral wording, no pronouns.
 */
export function renderMindChanges(sum: MindChangeSummary, nameOf: (id: string) => string = (id) => id): string {
  const lines: string[] = [];
  for (const e of sum.experts) {
    if (!e.moves.length) continue;
    const route = e.start && e.end ? `${STANCE_LABEL[e.start.stance]} to ${STANCE_LABEL[e.end.stance]}` : 'moved';
    const steps = e.moves.map((mv) => `${STANCE_LABEL[mv.from]} to ${STANCE_LABEL[mv.to]} (${mv.kind}), moved by ${causeText(mv.movedBy, nameOf)}; cost: ${mv.cost}`);
    lines.push(`${nameOf(e.expert)}${e.changedMind ? ' changed their mind' : ' gave ground'}: ${route}. ${steps.join('. ')}.`);
  }
  if (sum.heldFirm.length) lines.push(`Held firm: ${sum.heldFirm.map(nameOf).join(', ')}.`);
  for (const ev of sum.evidenceThatMoved) lines.push(`${ev.kind === 'evidence' ? 'Evidence' : 'Computation'} [${ev.ref}] moved ${ev.moved.map(nameOf).join(', ')}.`);
  if (sum.unexplainedOpen) lines.push(`${sum.unexplainedOpen} move${sum.unexplainedOpen === 1 ? '' : 's'} with no recorded cause.`);
  if (sum.herds) lines.push(`The room herded ${sum.herds} time${sum.herds === 1 ? '' : 's'} without new evidence.`);
  return lines.length ? lines.join('\n') : 'Nobody changed position on this motion.';
}
