/**
 * Attention: the few moments a debate needs its founder (plan section 6.1).
 *
 * A clarify batch, an approval gate, a mid-debate question, a pause for a
 * usage limit, an error, and the report being ready. Nothing else: the user
 * must not be nagged per motion. Pure and shared, so the server (Telegram)
 * and the browser (Web Notifications, title, favicon) agree on what counts
 * and both are unit-tested by the same selftest.
 */
import type { DebateStatus } from './types.ts';

export type Attention = 'question' | 'approval' | 'paused' | 'error' | 'report';

export const ATTENTION_KINDS: readonly Attention[] = ['question', 'approval', 'paused', 'error', 'report'];

/** The parts of a debate row attention is derived from. */
export interface AttentionInput {
  status: DebateStatus;
  pendingApproval?: 'goal' | 'panel' | 'plan' | null;
  pendingQuestionId?: string | null;
  /** True when the pause is the provider's usage limit, not the founder's own pause button. */
  limitPaused?: boolean;
}

const APPROVAL_STATUS: Partial<Record<DebateStatus, 'goal' | 'panel' | 'plan'>> = {
  goal_approval: 'goal',
  panel_approval: 'panel',
  plan_approval: 'plan',
};

/**
 * What the debate needs from its founder right now, plus a key that changes
 * whenever it is a new thing to look at (a second question is a new key even
 * though the kind is the same). Null when it needs nothing.
 */
export function attentionOf(d: AttentionInput): { kind: Attention; key: string } | null {
  switch (d.status) {
    case 'clarifying':
      return { kind: 'question', key: 'clarify' };
    case 'error':
      return { kind: 'error', key: 'error' };
    case 'complete':
      return { kind: 'report', key: 'report' };
    case 'paused':
      // The founder's own pause is not news to the founder.
      return d.limitPaused ? { kind: 'paused', key: 'paused' } : null;
    case 'cancelled':
      return null;
  }
  const stage = APPROVAL_STATUS[d.status] ?? d.pendingApproval ?? null;
  if (stage) return { kind: 'approval', key: `approval:${stage}` };
  if (d.pendingQuestionId) return { kind: 'question', key: `question:${d.pendingQuestionId}` };
  return null;
}

export interface AttentionChange {
  id: string;
  kind: Attention;
}

/**
 * Remembers each debate's last attention key and reports only transitions
 * into a new attention state. The first sighting of a debate seeds silently
 * unless `announceNew` is set, so a restart or a page load never replays
 * every debate that was already waiting.
 */
export class AttentionTracker {
  private last = new Map<string, string | null>();

  /** Feed one debate's current state. Returns the change to announce, if any. */
  observe(id: string, att: { kind: Attention; key: string } | null, announceNew = false): AttentionChange | null {
    const seen = this.last.has(id);
    const prev = this.last.get(id) ?? null;
    const key = att?.key ?? null;
    this.last.set(id, key);
    if (!att || key === prev) return null;
    if (!seen && !announceNew) return null;
    return { id, kind: att.kind };
  }

  /** Feed a full list (the deck poll). Debates no longer listed are forgotten. */
  observeAll(rows: { id: string; attention?: { kind: Attention; key: string } | null }[], announceNew = false): AttentionChange[] {
    const out: AttentionChange[] = [];
    const ids = new Set<string>();
    for (const r of rows) {
      ids.add(r.id);
      const c = this.observe(r.id, r.attention ?? null, announceNew);
      if (c) out.push(c);
    }
    for (const id of [...this.last.keys()]) if (!ids.has(id)) this.last.delete(id);
    return out;
  }

  forget(id: string) {
    this.last.delete(id);
  }
}

/**
 * At most one notification per debate per window; anything inside the window
 * is coalesced into a single trailing send carrying the latest kind. Time and
 * timers are injected so tests run without waiting.
 */
export class Coalescer {
  private lastSent = new Map<string, number>();
  private pending = new Map<string, { kind: Attention; timer: unknown }>();

  constructor(
    private send: (id: string, kind: Attention) => void,
    private opts: {
      windowMs: number;
      now?: () => number;
      setTimer?: (fn: () => void, ms: number) => unknown;
      clearTimer?: (t: unknown) => void;
      /** Checked when a coalesced send comes due: drop it if the debate no longer needs anyone. */
      stillWanted?: (id: string, kind: Attention) => boolean;
    }
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  push(id: string, kind: Attention) {
    const since = this.now() - (this.lastSent.get(id) ?? -Infinity);
    if (since >= this.opts.windowMs && !this.pending.has(id)) {
      this.fire(id, kind);
      return;
    }
    const p = this.pending.get(id);
    if (p) {
      p.kind = kind; // latest wins; the timer already exists
      return;
    }
    const setT = this.opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const wait = Math.max(0, this.opts.windowMs - since);
    const entry = { kind, timer: null as unknown };
    this.pending.set(id, entry);
    entry.timer = setT(() => {
      this.pending.delete(id);
      if (this.opts.stillWanted && !this.opts.stillWanted(id, entry.kind)) return;
      this.fire(id, entry.kind);
    }, wait);
  }

  private fire(id: string, kind: Attention) {
    this.lastSent.set(id, this.now());
    this.send(id, kind);
  }

  /** Pending coalesced sends, for tests and shutdown. */
  pendingCount() {
    return this.pending.size;
  }

  stop() {
    const clear = this.opts.clearTimer ?? ((t) => clearTimeout(t as any));
    for (const p of this.pending.values()) clear(p.timer);
    this.pending.clear();
  }
}
