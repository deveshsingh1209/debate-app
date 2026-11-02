import fs from 'node:fs';
import path from 'node:path';
import { CFG } from './config.ts';
import { emptyUsage, type UsageTotals } from '../../shared/types.ts';
import type { BudgetProfile, BudgetSnapshot, Casting, Citation, ComplexityRead, DebateConfig, DebateEvent, DebateStatus, Persona, Plan, PositionCard, ResearchResult, SessionScope, DebateSummary, Decision } from '../../shared/types.ts';
import type { ResearchRequest } from './research/types.ts';
import type { DiversityFlag, Dossier, FloorState } from '../../shared/types.ts';
import type { MarkedStakes } from './realism/stakes.ts';
import type { LedgerState } from './realism/ledger.ts';
import { attentionOf } from '../../shared/attention.ts';
import { openDb, transaction } from './sqlite.ts';

const db = openDb(path.join(CFG.dataDir, 'debate.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS debates (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'UNTITLED DEBATE',
  topic TEXT NOT NULL,
  goal TEXT,
  status TEXT NOT NULL,
  config TEXT NOT NULL,
  personas TEXT,
  plan TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  debate_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (debate_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_debate ON events(debate_id, seq);
`);

/**
 * Databases created by earlier, multi-user versions of this app also hold
 * accounts, auth_codes and grant_requests tables and a debates.account_id
 * column. They are left untouched and never read: single-user local mode has
 * no accounts. `npm run import-backup` copies debates and events only.
 */

/**
 * Engine scratch state persisted per debate so a process restart can resume.
 * sessions: personaId -> Agent SDK session id (also 'marcus', '_intake', '_architect')
 * lastSeen: personaId -> last event seq that persona has been shown
 */
export interface DebateMeta {
  sessions: Record<string, string>;
  lastSeen: Record<string, number>;
  /**
   * Every research answer. `summary` is all old rows have; from 2b-4 each
   * also carries its citations and the provider-neutral result.
   */
  researchBriefs: {
    question: string;
    summary: string;
    citations?: Citation[];
    status?: ResearchResult['status'];
    askedBy?: string;
    motionId?: string | null;
    /** The request it answered (from the cost fix), so a reuse can say what it reused. */
    requestId?: string;
  }[];
  pendingApproval: 'goal' | 'panel' | 'plan' | null;
  pendingClarify: string[]; // unanswered clarify questionIds
  clarifyQs: { id: string; question: string }[];
  clarifyAnswers: Record<string, string>;
  /** Amend count per clarify question; see AMEND_LIMIT. */
  amendCounts?: Record<string, number>;
  pendingQuestionId: string | null;
  architectResearchQs: string[];
  /**
   * The architect's web pass on the domain, written from the topic and goal
   * only (never the uploads), handed to the tool-free designer. Undefined
   * until it has run; '' when it ran and found nothing usable.
   */
  architectLandscape?: string;
  /**
   * The same pass as a research brief (it runs on the research desk), kept
   * apart from researchBriefs because the room never heard it. Later
   * research reuses it instead of searching the same ground.
   */
  architectScout?: { requestId: string; question: string; summary: string; citations: Citation[]; status: ResearchResult['status'] };
  reviseFeedback: string | null;    // goal revision feedback
  architectFeedback: string | null; // panel revision feedback
  planFeedback: string | null;      // plan revision feedback
  preResearchDone: boolean;
  contextFiles: number;             // files in the uploaded dossier (0 = none)
  contextBrief: string | null;      // dossier analyst's distillation
  closedExperts: string[];          // who already gave a closing statement
  lastSpeaker: string | null;
  floorCount: number;
  round: number;
  endedByUser?: boolean;
  /** The driver has already re-entered once after a stop; it may not loop again. */
  wrapupRetried?: boolean;
  /**
   * The provider's usage allowance ran out and the session is waiting for it to
   * reset. Persisted so a deploy or crash does not forget to come back.
   */
  limitPause?: {
    since: number;
    resetAt: number | null;
    kind: 'session' | 'weekly' | 'unknown';
    attempts: number;
    /** When the next try is due, so a restart keeps the same schedule. */
    nextTryAt?: number;
    /** The status to go back to (a limit can land in setup, the meeting, wrap-up or the report). */
    resumeTo?: DebateStatus;
  } | null;
  /**
   * The motion in progress, persisted after every round. Before this existed
   * MotionState lived only in memory, so every deploy or crash re-argued the
   * open motion from round one — real money and twenty minutes, spent on
   * repeating an argument the room had already had. A restart now resumes at
   * the top of the next round with the claims ledger intact.
   */
  motionCheckpoint?: MotionCheckpoint | null;
  /**
   * The founder pressed Pause (P4). The status is `paused`; `resumeTo` is the
   * step Resume goes back to. A step already running when the founder paused
   * finishes its in-flight call, and where it would have gone next is
   * recorded here instead of being entered.
   */
  founderPause?: { since: number; resumeTo: DebateStatus } | null;
  /** How far the report step got (P4), so a pause or restart does not write or attack it twice. Cleared when the report is done. */
  reportProgress?: {
    audit?: { kind: 'ok'; audit: any } | { kind: 'skipped' } | { kind: 'failed'; reason: string };
    written?: any;
    writerSession?: string | null;
    attacked?: boolean;
    findings?: any[];
    revised?: boolean;
  } | null;
  /** Per-file upload outcomes worth telling the founder (skips, extractions). */
  contextNotes?: string[];
  // ---- exhaustive-depth engine ----
  decisions: Decision[];            // written rulings, one per closed motion
  closedMotions: string[];          // agenda item ids already ruled on
  /**
   * Motions Marcus has put back on the floor after ruling them, one entry each.
   * The cap is the whole point: a chair who can reopen without limit can loop a
   * session forever, so a second attempt at the same motion is recorded as a
   * standing objection on the existing ruling instead of re-arguing it.
   */
  reopenedMotions?: string[];
  spentUsd: number;                 // running agent spend for this debate
  summonedCount: number;            // experts seated mid-session (cap 3)
  usage: UsageTotals;               // cumulative tokens/cost across every agent kind
  /** Verdict of the print-layout check on this session's report. */
  printQa?: { ok: boolean; summary: string; at: number } | null;
  /** Marcus's model assignments. Null until he casts, after the agenda is set. */
  casting: Casting | null;
  /**
   * How big this session is, decided from the topic at intake and approved by
   * the founder before a panel is designed. Null on rows created before scope
   * existed; the engine falls back to a standard shape for those.
   */
  scope: SessionScope | null;
  /** The intake analyst's read of the ask, kept so a re-size can be explained. */
  complexity: ComplexityRead | null;
  /**
   * Spend per role, in USD, accumulated live. Makes "where did the money go"
   * answerable from the app's own data, and lets the cost projection be
   * recalibrated from reality instead of a constant.
   */
  spendByRole: Record<string, { usd: number; turns: number }>;
  /**
   * Everything the quant desk actually computed from the founder's files.
   * Kept separate from researchBriefs because these are the only figures in
   * the session that were measured rather than argued, and the ruling, the
   * audit and the report all need to be able to tell the difference.
   */
  computations: ComputationRecord[];
  /**
   * The position each expert wrote before the first motion opened, keyed by
   * persona id. Persisted because they are the only asymmetry in a room whose
   * system prompt is byte-identical for everyone: regenerating them after a
   * restart would hand the room a different set of convictions half way
   * through a debate that had already been argued against the first set.
   * Experts whose card call failed are simply absent from the map.
   */
  positionCards?: Record<string, PositionCard> | null;
  // ---- budget (Phase 2b); absent on unprofiled rows ----
  /** The meter's last reading. Information only. */
  budget?: BudgetSnapshot | null;
  /** Legacy (capped era, 2b-2): written by old builds, read by nothing now. */
  budgetState?: 'ok' | 'wind_down' | 'closing';
  /** Research requests spent against the profile's research cap. */
  researchCount?: number;
  // ---- the turn trailer (Phase 2b-3); absent on older rows ----
  /**
   * Each expert's latest stated stance per motion, from their turn trailers.
   * Server-side only: the room hears speech, never anyone's stance line. The
   * linter reads it to tell a real concession from a courtesy one, and the
   * belief ledger (2b-6) builds on it.
   */
  stances?: Record<string, Record<string, { stance: number; confidence: string; crux: string; seq: number }>>;
  // ---- research (Phase 2b-4); absent on older rows ----
  /**
   * Research requests sent and not yet answered. Persisted so a restart
   * re-issues them instead of losing them (the in-memory counter it replaces
   * forgot every one on a deploy).
   */
  researchInflight?: ResearchRequest[];
  /** Research requests spent per motion, against the profile's per-motion allowance. */
  researchByMotion?: Record<string, number>;
  /** Research that has landed and that the chair has not yet put to the room. */
  researchLanded?: { motionId: string; askedBy: string; question: string; spoken: string; hits: { expert: string; effect: 'supports' | 'undermines' }[]; floored?: boolean }[];
  // ---- budget redesign; absent on older rows ----
  /** The profile this debate runs as, when 'auto' (the intake) or the founder chose it after setup. */
  profilePick?: { profile: BudgetProfile; source: 'auto' | 'founder'; reason: string } | null;
  /** The founder's ceiling after they extended it at the ceiling question. */
  ceilingUsd?: number | null;
  // ---- dossiers, stakes, the belief ledger (Phase 2b-5); absent on older rows ----
  /**
   * Each expert's dossier, by persona id. Only `publicReputation` ever reaches
   * the shared prefix; the rest rides in that expert's own suffix.
   */
  dossiers?: Record<string, Dossier>;
  /** Who the dossiers were written for, so a roster revision rewrites only the seats that changed. */
  dossierRoster?: { id: string; name: string; role: string }[];
  /** The panel diversity check as it stood when the panel was proposed. */
  diversity?: DiversityFlag | null;
  /** The session's stakes, with per-field provenance (assumed fields say so). */
  stakes?: MarkedStakes | null;
  /** The belief ledger (realism/ledger.ts). Server-side only, never in a prompt for another seat. */
  ledger?: LedgerState | null;
  /** Experts whose crux a research finding hit, per motion (2b-7 relevance rule). */
  cruxHits?: Record<string, string[]>;
  /** The last ledger chair trigger already put to the chair, per motion, so each is raised once. */
  ledgerTriggerSeq?: Record<string, number>;
  /** Times each expert used each of their verbal habits, per motion: motionId -> expert -> habit -> count. */
  ticUse?: Record<string, Record<string, Record<string, number>>>;
}

export interface MotionCheckpoint {
  motionId: string;
  round: number;
  messages: number;
  dryStreak: number;
  claims: string[];
  unresolved: string[];
  positionChanges: string[];
  startSeq: number;
  rung: number;
  redTeamed?: boolean;
  staleRun?: number;
  /** The floor director's state (2b-7). Absent on checkpoints from the round engine. */
  floor?: FloorState;
  /**
   * A turn written and planned but not yet fully performed (server-side only:
   * it holds the whole text, unsaid remainder included). A restart performs it
   * again, with no new model call; it never reaches an event as written.
   */
  performing?: { turn: any; plan: any } | null;
  /** Where the motion stands (P4); see MotionState in engine/motions.ts. */
  open?: any;
  pressure?: string | null;
  closing?: string | null;
  ruling?: Decision | null;
  challenge?: any;
}

export interface ComputationRecord {
  question: string;
  answer: string;
  computable: boolean;
  figures: { label: string; value: string; source: string }[];
  method: string;
  caveats: string[];
  motionId: string | null;
}

export const emptyMeta = (): DebateMeta => ({
  sessions: {},
  lastSeen: {},
  researchBriefs: [],
  pendingApproval: null,
  pendingClarify: [],
  clarifyQs: [],
  clarifyAnswers: {},
  pendingQuestionId: null,
  architectResearchQs: [],
  reviseFeedback: null,
  architectFeedback: null,
  planFeedback: null,
  preResearchDone: false,
  contextFiles: 0,
  contextBrief: null,
  closedExperts: [],
  lastSpeaker: null,
  floorCount: 0,
  round: 0,
  decisions: [],
  closedMotions: [],
  spentUsd: 0,
  summonedCount: 0,
  usage: emptyUsage(),
  computations: [],
  scope: null,
  complexity: null,
  spendByRole: {},
  casting: null,
});

export interface DebateRow {
  id: string;
  title: string;
  topic: string;
  goal: string | null;
  status: DebateStatus;
  config: DebateConfig;
  personas: Persona[];
  plan: Plan | null;
  meta: DebateMeta;
  createdAt: number;
  updatedAt: number;
}

const rowToDebate = (r: any): DebateRow => ({
  id: r.id,
  title: r.title,
  topic: r.topic,
  goal: r.goal,
  status: r.status,
  config: JSON.parse(r.config),
  personas: r.personas ? JSON.parse(r.personas) : [],
  plan: r.plan ? JSON.parse(r.plan) : null,
  meta: { ...emptyMeta(), ...JSON.parse(r.meta || '{}') },
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Called with the debate id after any status or meta write. Used by notifications (notify/index.ts). */
const patchListeners = new Set<(id: string) => void>();
export function onDebatePatched(fn: (id: string) => void): () => void {
  patchListeners.add(fn);
  return () => patchListeners.delete(fn);
}

/**
 * The name to show for a debate. Until intake names it, the stored title is
 * the placeholder; a list of four "UNTITLED DEBATE" rows tells the founder
 * nothing, so the opening words of their own topic stand in.
 */
export function displayTitle(title: string, topic: string): string {
  if (title !== 'UNTITLED DEBATE') return title;
  const t = (topic ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return 'New debate';
  return t.length > 80 ? `${t.slice(0, 80).replace(/\s+\S*$/, '')}…` : t;
}

/** What a stored debate needs from its founder right now (shared/attention.ts). */
export function rowAttention(row: DebateRow) {
  return attentionOf({
    status: row.status,
    pendingApproval: row.meta.pendingApproval,
    pendingQuestionId: row.meta.pendingQuestionId,
    limitPaused: !!row.meta.limitPause,
  });
}

export const Debates = {
  create(id: string, topic: string, config: DebateConfig): DebateRow {
    const now = Date.now();
    db.prepare(
      `INSERT INTO debates (id, topic, status, config, meta, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`
    ).run(id, topic, 'intake', JSON.stringify(config), JSON.stringify(emptyMeta()), now, now);
    return this.get(id)!;
  },
  get(id: string): DebateRow | null {
    const r = db.prepare(`SELECT * FROM debates WHERE id = ?`).get(id);
    return r ? rowToDebate(r) : null;
  },
  list(): DebateSummary[] {
    // Only the three meta fields attention reads, not the whole (large) meta blob.
    const rows = db.prepare(
      `SELECT id, title, status, config, created_at, updated_at, substr(topic, 1, 200) AS topic_head,
              json_extract(meta, '$.pendingApproval') AS pa,
              json_extract(meta, '$.pendingQuestionId') AS pq,
              json_extract(meta, '$.limitPause') IS NOT NULL AS lp
         FROM debates ORDER BY created_at DESC`
    ).all();
    const counts = db.prepare(`SELECT debate_id, COUNT(*) c FROM events WHERE type='message' GROUP BY debate_id`).all() as any[];
    const byId = new Map(counts.map((c) => [c.debate_id, c.c]));
    return rows.map((r: any) => {
      const att = attentionOf({ status: r.status, pendingApproval: r.pa, pendingQuestionId: r.pq, limitPaused: !!r.lp });
      return {
        id: r.id,
        title: displayTitle(r.title, r.topic_head),
        status: r.status,
        config: JSON.parse(r.config),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        messageCount: byId.get(r.id) ?? 0,
        attention: att?.kind ?? null,
        attentionKey: att?.key ?? null,
      };
    });
  },
  patch(id: string, fields: Partial<{ title: string; goal: string; status: DebateStatus; personas: Persona[]; plan: Plan; meta: DebateMeta }>) {
    const sets: string[] = ['updated_at = ?'];
    const vals: any[] = [Date.now()];
    if (fields.title !== undefined) { sets.push('title = ?'); vals.push(fields.title); }
    if (fields.goal !== undefined) { sets.push('goal = ?'); vals.push(fields.goal); }
    if (fields.status !== undefined) { sets.push('status = ?'); vals.push(fields.status); }
    if (fields.personas !== undefined) { sets.push('personas = ?'); vals.push(JSON.stringify(fields.personas)); }
    if (fields.plan !== undefined) { sets.push('plan = ?'); vals.push(JSON.stringify(fields.plan)); }
    if (fields.meta !== undefined) { sets.push('meta = ?'); vals.push(JSON.stringify(fields.meta)); }
    vals.push(id);
    db.prepare(`UPDATE debates SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    if (fields.status !== undefined || fields.meta !== undefined) {
      for (const fn of patchListeners) {
        try { fn(id); } catch { /* an observer (notifications) must never affect the debate */ }
      }
    }
  },
  remove(id: string) {
    db.prepare(`DELETE FROM events WHERE debate_id = ?`).run(id);
    db.prepare(`DELETE FROM debates WHERE id = ?`).run(id);
  },
};

const insertEvent = db.prepare(
  `INSERT INTO events (debate_id, seq, ts, type, payload) VALUES (?,?,?,?,?)`
);
const nextSeqStmt = db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM events WHERE debate_id = ?`);

export const Events = {
  /** Appends an event, assigning seq + ts. Returns the completed event. */
  append: transaction(db, <T extends Omit<DebateEvent, 'seq' | 'ts'>>(debateId: string, ev: T): DebateEvent => {
    const seq = (nextSeqStmt.get(debateId) as any).s as number;
    const full = { ...ev, seq, ts: Date.now() } as unknown as DebateEvent;
    insertEvent.run(debateId, seq, full.ts, full.type, JSON.stringify(full));
    return full;
  }) as <T extends Omit<DebateEvent, 'seq' | 'ts'>>(debateId: string, ev: T) => DebateEvent,

  since(debateId: string, after = 0): DebateEvent[] {
    const rows = db.prepare(`SELECT payload FROM events WHERE debate_id = ? AND seq > ? ORDER BY seq`).all(debateId, after) as any[];
    return rows.map((r) => JSON.parse(r.payload));
  },
  /** Last n events in chronological order (avoids full-log scans in hot paths). */
  recent(debateId: string, n: number): DebateEvent[] {
    const rows = db.prepare(`SELECT payload FROM events WHERE debate_id = ? ORDER BY seq DESC LIMIT ?`).all(debateId, n) as any[];
    return rows.map((r) => JSON.parse(r.payload)).reverse();
  },
  lastSeq(debateId: string): number {
    return (nextSeqStmt.get(debateId) as any).s - 1;
  },
};

export default db;

/**
 * Snapshot the database to a rotating set of files.
 *
 * Everything the app has ever produced lives in one SQLite file: every debate,
 * every ruling, every event. Until now nothing copied it. A bad
 * disk, a stray `rm`, or a botched migration would take all of it, and the
 * transcripts and reports on disk would survive without the index that makes
 * them findable.
 *
 * VACUUM INTO (not a file copy) is the right tool: it takes a consistent
 * snapshot of a live WAL database without stopping writers, and it compacts as
 * it goes. Snapshots are kept alongside the data, which protects against
 * everything except losing the whole volume; off-box copies are a deploy
 * concern, not this function's.
 */
export function backupDb(keep = 7): { file: string; bytes: number } | null {
  const dir = path.join(CFG.dataDir, 'backups');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(dir, `debate-${stamp}.db`);
    // The path is interpolated because VACUUM INTO takes no bind parameters.
    // It is built from a timestamp and CFG.dataDir, never from user input.
    db.prepare(`VACUUM INTO '${file.replace(/'/g, "''")}'`).run();

    const olds = fs.readdirSync(dir)
      .filter((f) => f.startsWith('debate-') && f.endsWith('.db'))
      .sort()
      .slice(0, -keep);
    for (const f of olds) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* leave it; a stale backup is harmless */ }
    }
    return { file, bytes: fs.statSync(file).size };
  } catch (err) {
    // A failed backup must never take the server down with it.
    console.error('[db] backup failed:', err);
    return null;
  }
}

/**
 * Runs a snapshot at boot and daily thereafter. Boot matters more than the
 * schedule: the riskiest moment for this file is a deploy, and a deploy is
 * exactly when the process restarts.
 */
export function startBackups(intervalMs = 24 * 3600_000) {
  const run = () => {
    const r = backupDb();
    if (r) console.log(`[db] backup ${path.basename(r.file)} (${Math.round(r.bytes / 1024)} KB)`);
  };
  run();
  const t = setInterval(run, intervalMs);
  t.unref();
}
