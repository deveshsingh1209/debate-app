import type { ServerResponse } from 'node:http';
import { Events } from './db.ts';
import type { DebateEvent, LiveFrame, StageActor, StageFrame, WireFrame } from '../../shared/types.ts';

/**
 * SSE hub. Persisted DebateEvents go through publish() (append to DB + broadcast).
 * Ephemeral LiveFrames (deltas, speaking) go through live() (broadcast only).
 * Tracks every in-progress streaming message per debate so a client that
 * connects mid-message immediately receives the partial text. There can be
 * more than one: when someone talks over a speaker, both turns are streaming
 * at once, and a refresh must bring both back.
 */

interface Partial {
  messageId: string;
  speaker: string;
  kind: string;
  text: string;
}

const subscribers = new Map<string, Set<ServerResponse>>();

/**
 * Most live streams held open at once, per debate and in all. Each holds a
 * socket and a timer and costs a full replay on subscribe, so an unbounded
 * number of them is a way to stall the event loop. Over a limit the OLDEST
 * stream is closed: the web app reconnects by itself, so evicting a stale tab
 * costs nobody anything, while refusing the newest would lock out the tab the
 * founder just opened.
 */
export const SSE_LIMITS = { perDebate: 8, total: 64 };

/** Every open stream, oldest first, for eviction across debates. */
const openOrder: { debateId: string; res: ServerResponse }[] = [];

function evict(entry: { debateId: string; res: ServerResponse }) {
  const i = openOrder.indexOf(entry);
  if (i >= 0) openOrder.splice(i, 1);
  subscribers.get(entry.debateId)?.delete(entry.res);
  try { entry.res.end(); } catch { /* already gone */ }
}

/** Make room for one more stream on this debate. */
function makeRoom(debateId: string) {
  // Sockets that died without a close event are dropped first.
  for (const e of [...openOrder]) if (e.res.destroyed || e.res.writableEnded) evict(e);
  const mine = openOrder.filter((e) => e.debateId === debateId);
  while (mine.length >= SSE_LIMITS.perDebate) evict(mine.shift()!);
  while (openOrder.length >= SSE_LIMITS.total) evict(openOrder[0]);
}
/** Statuses in which nobody can be speaking. */
const SILENT = new Set(['reporting', 'complete', 'error', 'cancelled']);

/** debate id -> message id -> partial. Map order is start order, which replay keeps. */
const partials = new Map<string, Map<string, Partial>>();

/**
 * The stage each debate is currently on (who is working while nobody speaks).
 * Held like a partial message: ephemeral, never written to the event log, but
 * replayed on subscribe so a client joining mid-silence still knows the room is
 * working rather than dead.
 */
const stages = new Map<string, StageFrame>();

function writeFrame(res: ServerResponse, frame: WireFrame) {
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
}

function broadcast(debateId: string, frame: WireFrame) {
  const subs = subscribers.get(debateId);
  if (!subs) return;
  for (const res of subs) {
    try {
      writeFrame(res, frame);
    } catch {
      subs.delete(res);
    }
  }
}

export const Hub = {
  /** Persist + broadcast a debate event. */
  publish(debateId: string, ev: Omit<DebateEvent, 'seq' | 'ts'>): DebateEvent {
    const full = Events.append(debateId, ev);
    if (full.type === 'message') partials.get(debateId)?.delete(full.id); // that message is finalized
    // Once the room has stopped talking, nothing can still be mid-sentence. This
    // also clears a partial orphaned by a turn that died without cleanup, which
    // would otherwise be replayed to every new subscriber for good.
    if (full.type === 'status' && SILENT.has(full.status)) partials.delete(debateId);
    broadcast(debateId, full);
    return full;
  },

  /** Broadcast-only live frame. Deltas also accumulate into the partial buffers. */
  live(debateId: string, frame: LiveFrame) {
    if (frame.type === 'delta') {
      let byId = partials.get(debateId);
      if (!byId) partials.set(debateId, (byId = new Map()));
      const p = byId.get(frame.messageId);
      if (p) {
        p.text += frame.textDelta;
      } else {
        byId.set(frame.messageId, {
          messageId: frame.messageId,
          speaker: frame.speaker,
          kind: frame.kind,
          text: frame.textDelta,
        });
      }
    }
    broadcast(debateId, frame);
  },

  /**
   * Discard a partial buffer (a turn was aborted before finalizing). With no
   * message id, every partial of the debate goes.
   */
  dropPartial(debateId: string, messageId?: string) {
    if (messageId) partials.get(debateId)?.delete(messageId);
    else partials.delete(debateId);
  },

  /** The partials a newly connected client would be replayed. For tests. */
  partials(debateId: string): Partial[] {
    return [...(partials.get(debateId)?.values() ?? [])].map((p) => ({ ...p }));
  },

  /**
   * Opens a stage: the room is working, and this is what it is working on.
   * Returns a handle that streams reasoning into it and closes it. Closing is
   * unconditional — a stage that outlived its work would be a lie on screen,
   * so callers close it in a finally.
   */
  stage(debateId: string, actor: StageActor, label: string, detail?: string) {
    const frame: StageFrame = { type: 'stage', actor, label, detail, since: Date.now(), thinking: '' };
    stages.set(debateId, frame);
    broadcast(debateId, frame);

    let buf = '';
    let lastPush = 0;
    let closed = false;
    return {
      /** Feed real reasoning in. Throttled: thinking arrives far faster than anyone reads. */
      think(textDelta: string) {
        const live = stages.get(debateId);
        if (live !== frame) return;              // superseded by a newer stage
        buf = (buf + textDelta).slice(-1200);    // tail only; this is a status line, not a log
        const now = Date.now();
        if (now - lastPush < 500) return;
        lastPush = now;
        frame.thinking = buf;
        broadcast(debateId, { ...frame });
      },
      /**
       * Idempotent: a caller may close early to hand the stage to a longer step
       * and still run its own finally. A second broadcast of `done` would race
       * ahead of whatever opened in between and blank the panel.
       */
      close() {
        if (closed) return;
        closed = true;
        if (stages.get(debateId) === frame) stages.delete(debateId);
        broadcast(debateId, { ...frame, thinking: '', done: true });
      },
    };
  },

  /** Clears any open stage (session ended, or the engine is handing off). */
  clearStage(debateId: string) {
    const live = stages.get(debateId);
    if (!live) return;
    stages.delete(debateId);
    broadcast(debateId, { ...live, thinking: '', done: true });
  },

  /** How many streams are open, for one debate or in all. For tests. */
  subscriberCount(debateId?: string): number {
    return debateId ? (subscribers.get(debateId)?.size ?? 0) : openOrder.length;
  },

  subscribe(debateId: string, res: ServerResponse, since: number) {
    makeRoom(debateId);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(':ok\n\n');

    // Replay persisted history, then every current partial, then the open stage, then live.
    for (const ev of Events.since(debateId, since)) writeFrame(res, ev);
    for (const p of partials.get(debateId)?.values() ?? []) {
      if (p.text) writeFrame(res, { type: 'delta', messageId: p.messageId, speaker: p.speaker, kind: p.kind, textDelta: p.text });
    }
    const stage = stages.get(debateId);
    if (stage) writeFrame(res, stage);

    let subs = subscribers.get(debateId);
    if (!subs) subscribers.set(debateId, (subs = new Set()));
    subs.add(res);
    const entry = { debateId, res };
    openOrder.push(entry);

    const ping = setInterval(() => {
      try {
        writeFrame(res, { type: 'ping' });
      } catch {
        cleanup();
      }
    }, 20_000);

    const cleanup = () => {
      clearInterval(ping);
      subs!.delete(res);
      const i = openOrder.indexOf(entry);
      if (i >= 0) openOrder.splice(i, 1);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
  },
};
