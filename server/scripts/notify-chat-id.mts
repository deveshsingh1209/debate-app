/**
 * Prints the chat id(s) that have messaged your bot, so you can set
 * TELEGRAM_CHAT_ID. Calls Telegram's getUpdates once with your own
 * TELEGRAM_BOT_TOKEN and exits; nothing is stored. Run it yourself after
 * sending your bot any message (for example /start). CI never runs it.
 *
 *   TELEGRAM_BOT_TOKEN=123:abc npm run notify:chat-id
 */
import { TELEGRAM_API, redact } from '../src/notify/telegram.ts';

const token = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
delete process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Set TELEGRAM_BOT_TOKEN first, for example: TELEGRAM_BOT_TOKEN=123456:ABC... npm run notify:chat-id');
  process.exit(1);
}

try {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/getUpdates`, { signal: AbortSignal.timeout(10_000) });
  const body = (await res.json()) as any;
  if (!res.ok || !body?.ok) {
    console.error(redact(`Telegram answered ${res.status}: ${body?.description ?? 'unknown error'}. Is the token right?`, token));
    process.exit(1);
  }
  const chats = new Map<string, string>();
  for (const u of body.result ?? []) {
    const c = (u.message ?? u.edited_message ?? u.channel_post ?? u.my_chat_member)?.chat;
    if (c?.id !== undefined) chats.set(String(c.id), c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '');
  }
  if (!chats.size) {
    console.log('No messages yet. Open your bot in Telegram, send it any message (for example /start), then run this again.');
    process.exit(1);
  }
  for (const [id, name] of chats) console.log(`TELEGRAM_CHAT_ID=${id}${name ? `   # ${name}` : ''}`);
} catch (e: any) {
  console.error(redact(`Could not reach Telegram: ${e?.message ?? e}`, token));
  process.exit(1);
}
