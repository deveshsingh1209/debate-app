/**
 * Optional Telegram notifications (plan section 6.1). Off unless the user
 * sets BOTH their own TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.
 *
 * Outbound only: one `POST /bot<token>/sendMessage` per notification. No
 * polling, no webhook, no inbound commands, no login, no files. Nothing in
 * the app can be controlled from Telegram.
 *
 * Pure: everything (env, fetch, clock, log) is passed in, so the selftest
 * and the security test drive it against a local fake server and never
 * touch api.telegram.org.
 */
import { ATTENTION_KINDS, type Attention } from '../../../shared/attention.ts';

export const TELEGRAM_API = 'https://api.telegram.org';

export type TelegramDetail = 'minimal' | 'title';

export interface TelegramSettings {
  token: string;
  chatId: string;
  kinds: Set<Attention>;
  detail: TelegramDetail;
  /** Where links in the message point, without a trailing slash. */
  linkBase: string;
  apiBase: string;
}

/** True for http(s) URLs whose host is this machine. */
function isLoopbackUrl(u: URL): boolean {
  const h = u.hostname.replace(/^\[|\]$/g, '');
  return (u.protocol === 'http:' || u.protocol === 'https:') && (h === '127.0.0.1' || h === 'localhost' || h === '::1');
}

/**
 * The Telegram API base. Always api.telegram.org, except that tests may point
 * it at a fake server on this machine with TELEGRAM_API_BASE_TEST. Anything
 * else is refused (null), so a stray env var can never send the token to
 * another host.
 */
export function resolveApiBase(override: string | undefined): string | null {
  const v = (override ?? '').trim();
  if (!v) return TELEGRAM_API;
  try {
    const u = new URL(v);
    return isLoopbackUrl(u) ? u.origin : null;
  } catch {
    return null;
  }
}

/** A Telegram bot token: `<digits>:<35ish url-safe chars>`. */
const TOKEN_SHAPE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const TOKEN_ANYWHERE = /\d{5,15}:[A-Za-z0-9_-]{30,64}/g;

/**
 * Strip a token out of any text before it is logged or shown: the exact token
 * if known, anything shaped like one, and the `/bot<...>/` URL segment.
 */
export function redact(text: string, token?: string): string {
  let s = String(text);
  if (token) s = s.split(token).join('[redacted]');
  return s.replace(TOKEN_ANYWHERE, '[redacted]').replace(/\/bot[^/\s"']+/g, '/bot[redacted]');
}

/**
 * Reads the Telegram settings from an env object. Returns `{ settings: null }`
 * (off) unless both the token and chat id are set; `problem` says why a set
 * configuration was refused. Never includes the token in `problem`.
 */
export function telegramSettingsFrom(
  env: Record<string, string | undefined>,
  server: { host: string; port: number }
): { settings: TelegramSettings | null; problem: string | null } {
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const chatId = (env.TELEGRAM_CHAT_ID ?? '').trim();
  if (!token && !chatId) return { settings: null, problem: null };
  if (!token || !chatId) {
    return { settings: null, problem: `Telegram is off: set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (only ${token ? 'the token' : 'the chat id'} is set).` };
  }
  if (!TOKEN_SHAPE.test(token)) {
    return { settings: null, problem: 'Telegram is off: TELEGRAM_BOT_TOKEN does not look like a bot token from @BotFather (digits, a colon, then letters).' };
  }
  if (!/^-?\d{1,20}$/.test(chatId) && !/^@[A-Za-z0-9_]{5,64}$/.test(chatId)) {
    return { settings: null, problem: 'Telegram is off: TELEGRAM_CHAT_ID should be a number like 123456789 (or -100... for a group).' };
  }
  const apiBase = resolveApiBase(env.TELEGRAM_API_BASE_TEST);
  if (!apiBase) {
    return { settings: null, problem: 'Telegram is off: TELEGRAM_API_BASE_TEST may only point at this machine (it exists for tests).' };
  }

  const wanted = (env.TELEGRAM_NOTIFY ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const kinds = new Set<Attention>(
    wanted.length ? (wanted.filter((k) => (ATTENTION_KINDS as readonly string[]).includes(k)) as Attention[]) : ATTENTION_KINDS
  );
  const detail: TelegramDetail = (env.TELEGRAM_DETAIL ?? '').trim().toLowerCase() === 'title' ? 'title' : 'minimal';

  let linkBase = '';
  const pub = (env.PUBLIC_URL ?? '').trim();
  if (pub) {
    try {
      const u = new URL(pub);
      if (u.protocol === 'http:' || u.protocol === 'https:') linkBase = (u.origin + u.pathname).replace(/\/+$/, '');
    } catch { /* fall through to the local address */ }
  }
  if (!linkBase) {
    const h = server.host === '0.0.0.0' || server.host === '::' ? '127.0.0.1' : server.host;
    linkBase = `http://${h.includes(':') ? `[${h}]` : h}:${server.port}`;
  }

  return { settings: { token, chatId, kinds, detail, linkBase, apiBase }, problem: null };
}

const LINE: Record<Attention, string> = {
  question: 'a debate needs your answer.',
  approval: 'a debate is waiting for your approval.',
  paused: 'a debate is paused and needs you.',
  error: 'a debate stopped with an error.',
  report: 'a debate has finished and its report is ready.',
};

/**
 * The message text. Minimal (the default) carries no title, topic or content:
 * only what kind of thing is waiting and a link. `title` adds the debate title,
 * which the user opts into knowingly. Sent as plain text (no parse_mode), so a
 * title cannot inject markup.
 */
export function messageText(s: Pick<TelegramSettings, 'detail' | 'linkBase'>, debateId: string, kind: Attention, title?: string | null): string {
  const link = `${s.linkBase}/debate/${encodeURIComponent(debateId)}${kind === 'report' ? '/report' : ''}`;
  const named = s.detail === 'title' && title ? `\n"${title.replace(/\s+/g, ' ').trim().slice(0, 120)}"` : '';
  return `The Debate App: ${LINE[kind]}${named}\n${link}`;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Sends one message. Never throws: resolves to an error string (redacted)
 * or null on success.
 */
export async function sendTelegram(
  s: Pick<TelegramSettings, 'token' | 'chatId' | 'apiBase'>,
  text: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<string | null> {
  try {
    const res = await fetchImpl(`${s.apiBase}/bot${s.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: s.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return null;
    let why = '';
    try {
      why = String(JSON.parse(await res.text())?.description ?? '');
    } catch { /* not JSON */ }
    return redact(`Telegram answered ${res.status}${why ? `: ${why.slice(0, 200)}` : ''}`, s.token);
  } catch (err) {
    const e = err as any;
    return redact(`Telegram send failed: ${e?.message ?? e}${e?.cause?.message ? ` (${e.cause.message})` : ''}`, s.token);
  }
}
