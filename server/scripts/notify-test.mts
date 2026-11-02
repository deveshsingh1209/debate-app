/**
 * Sends ONE test message to your own Telegram chat, using TELEGRAM_BOT_TOKEN
 * and TELEGRAM_CHAT_ID from the environment or .env. Your manual check that
 * Telegram notifications are set up; it talks to api.telegram.org, so CI and
 * the test suites never run it.
 *
 *   npm run notify:test
 */
import { CFG } from '../src/config.ts';
import { sendTelegram, telegramSettingsFrom } from '../src/notify/telegram.ts';

const { settings, problem } = telegramSettingsFrom(process.env, { host: CFG.host, port: CFG.port });
delete process.env.TELEGRAM_BOT_TOKEN;

if (!settings) {
  console.error(problem ?? 'Telegram is off: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env first (see README, "Notifications").');
  process.exit(1);
}

const text =
  'The Debate App: test notification. If you can read this, Telegram notifications work.\n' +
  `Links will point to ${settings.linkBase}`;
const err = await sendTelegram(settings, text);
if (err) {
  console.error(`${err}\nCheck the token (from @BotFather) and the chat id, and that you have sent your bot a message first.`);
  process.exit(1);
}
console.log(`Sent. Check Telegram. Messages will be ${settings.detail === 'title' ? 'the alert plus the debate title' : 'minimal (no titles or content)'}.`);
