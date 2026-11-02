/**
 * Server-side notifications: watches every debate's attention state and,
 * when Telegram is configured, sends one short message on a transition into
 * a new attention state (plan section 6.1). Browser notifications live in the
 * web app; this module only serves Telegram, the gap a closed tab leaves.
 *
 * The token is read once here at boot and deleted from process.env (the
 * Phase-1 credential pattern), so nothing that later copies the environment,
 * such as an agent subprocess, can carry it along. It is never logged and
 * never returned by any route: /api/me reports a boolean only.
 */
import { CFG } from '../config.ts';
import { Debates, onDebatePatched, rowAttention, type DebateRow } from '../db.ts';
import { AttentionTracker, Coalescer } from '../../../shared/attention.ts';
import { TELEGRAM_API, messageText, sendTelegram, telegramSettingsFrom, type FetchLike, type TelegramSettings } from './telegram.ts';

const boot = telegramSettingsFrom(process.env, { host: CFG.host, port: CFG.port });
delete process.env.TELEGRAM_BOT_TOKEN;

/** Telegram is configured and valid. Safe to expose: a boolean. */
export const telegramEnabled = (): boolean => !!boot.settings;

/** At most one message per debate per 30 seconds; the rest coalesce into one. */
export const TELEGRAM_WINDOW_MS = 30_000;

export interface NotifierDeps {
  settings: TelegramSettings;
  getRow: (id: string) => DebateRow | null;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  windowMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export function createNotifier(d: NotifierDeps) {
  const log = d.log ?? ((l: string) => console.log(l));
  const tracker = new AttentionTracker();
  let failing = false;
  const inFlight = new Set<Promise<void>>();

  const attentionNow = (id: string) => {
    const row = d.getRow(id);
    return row ? rowAttention(row) : null;
  };

  const coalescer = new Coalescer(
    (id, kind) => {
      const p = (async () => {
        const text = messageText(d.settings, id, kind, d.getRow(id)?.title);
        const err = await sendTelegram(d.settings, text, d.fetchImpl);
        if (err && !failing) log(`[notify] ${err}. Further failures stay quiet until one succeeds; debates carry on regardless.`);
        failing = !!err;
      })().catch(() => { /* sendTelegram never throws; belt and braces */ });
      inFlight.add(p);
      p.finally(() => inFlight.delete(p));
    },
    {
      windowMs: d.windowMs ?? TELEGRAM_WINDOW_MS,
      now: d.now,
      setTimer: d.setTimer,
      clearTimer: d.clearTimer,
      // A coalesced message is dropped if the founder already dealt with it.
      stillWanted: (id) => attentionNow(id) !== null,
    }
  );

  return {
    /** Remember the current state of existing debates without announcing anything. */
    seed(ids: string[]) {
      for (const id of ids) tracker.observe(id, attentionNow(id));
    },
    /** Called after a debate's status or meta changed. */
    observe(id: string) {
      const change = tracker.observe(id, attentionNow(id), true);
      if (change && d.settings.kinds.has(change.kind)) coalescer.push(id, change.kind);
    },
    stop() {
      coalescer.stop();
    },
    /** Sends started and not yet finished, for tests. */
    async drain() {
      await Promise.all([...inFlight]);
    },
  };
}

/** Wire Telegram to the debate store. A no-op (no listener, no request, ever) when Telegram is off. */
export function startNotifications(): void {
  if (boot.problem) console.warn(`[notify] ${boot.problem}`);
  if (!boot.settings) return;
  const s = boot.settings;
  const n = createNotifier({ settings: s, getRow: (id) => Debates.get(id) });
  n.seed(Debates.list().map((r) => r.id));
  onDebatePatched((id) => n.observe(id));
  const kinds = [...s.kinds].join(', ') || 'nothing (TELEGRAM_NOTIFY matched no kind)';
  console.log(`[notify] Telegram on: ${s.detail} messages for ${kinds}${s.apiBase === TELEGRAM_API ? '' : ' (test API on this machine)'}`);
}
