/**
 * Call-level waste guards. They stop the app paying twice for the same
 * answer, never for argument: a different prompt is always a different call.
 *
 * Two things count as waste here:
 * - DUPLICATE: an identical call (same seat label, model, system, prompt and
 *   session) already in flight for the same debate. The second caller shares
 *   the first one's result instead of starting another.
 * - LOOP: an identical call that has already SUCCEEDED `maxIdenticalCalls`
 *   times in this debate. Its answer exists; running it again is the shape of
 *   a runaway loop (a stage re-entered forever re-running the same agent), so
 *   it is refused with WasteGuardError. Failed calls do not count: a turn that
 *   failed is retried within the bounds in shared/budget.ts WASTE.
 *
 * Calls without a debate id (tools, tests of the agents themselves) are not
 * guarded.
 */
import crypto from 'node:crypto';
import { WASTE } from '../../../shared/budget.ts';

export class WasteGuardError extends Error {
  constructor(label: string, times: number) {
    super(`waste guard: "${label}" already ran ${times} times with exactly the same input in this debate; not running it again`);
    this.name = 'WasteGuardError';
  }
}

export function isWasteGuard(err: unknown): boolean {
  return err instanceof WasteGuardError || (err as any)?.name === 'WasteGuardError';
}

interface CallShape {
  model: string;
  system: string;
  prompt: string;
  resume?: string;
  label?: string;
  debateId?: string;
}

const inflight = new Map<string, Promise<unknown>>();
const succeeded = new Map<string, number>();
/** Calls the guard spared, per debate: shared duplicates plus refused loops. */
const spared = new Map<string, number>();

function keyOf(o: CallShape): string {
  const h = crypto.createHash('sha256');
  for (const part of [o.label ?? '', o.model, o.resume ?? '', o.system, o.prompt]) h.update(part).update('\u0000');
  return `${o.debateId}:${h.digest('base64url')}`;
}

/**
 * Run `call` unless it is a duplicate or a loop. Wrap the outermost dispatch
 * only, so one logical call is counted once whatever retries it does inside.
 */
export function guardCall<T>(o: CallShape, call: () => Promise<T>): Promise<T> {
  if (!o.debateId) return call();
  const key = keyOf(o);
  const shared = inflight.get(key);
  if (shared) {
    spared.set(o.debateId, (spared.get(o.debateId) ?? 0) + 1);
    return shared as Promise<T>;
  }
  const done = succeeded.get(key) ?? 0;
  if (done >= WASTE.maxIdenticalCalls) {
    spared.set(o.debateId, (spared.get(o.debateId) ?? 0) + 1);
    console.log(`[waste] refused a repeat of "${o.label ?? '?'}" in ${o.debateId} (${done} identical successes)`);
    return Promise.reject(new WasteGuardError(o.label ?? 'agent call', done));
  }
  const p = call().then(
    (r) => { inflight.delete(key); succeeded.set(key, (succeeded.get(key) ?? 0) + 1); return r; },
    (err) => { inflight.delete(key); throw err; },
  );
  inflight.set(key, p);
  return p;
}

export const Waste = {
  /** How many calls the guard has spared this debate. */
  spared(debateId: string): number {
    return spared.get(debateId) ?? 0;
  },
  /** Forget a debate (deleted, or a test reset). */
  drop(debateId: string) {
    const prefix = `${debateId}:`;
    for (const k of [...succeeded.keys()]) if (k.startsWith(prefix)) succeeded.delete(k);
    spared.delete(debateId);
  },
};
