/**
 * Notifications, offline (plan section 6.1, step 2b-8). Attention mapping,
 * transitions, coalescing, and the Telegram sender driven against a fake
 * Telegram API on 127.0.0.1. Global fetch is stubbed throughout and any call
 * to a host other than this machine fails the test, so nothing here can
 * reach api.telegram.org.
 *
 *   npx tsx src/notify/notify.selftest.ts
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Everything below reads its environment at import time, so set it first.
// Empty strings (not undefined) also stop a real .env from filling these in.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-notify-test-'));
process.env.DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_CHAT_ID = '';
process.env.TELEGRAM_API_BASE_TEST = '';
process.env.PUBLIC_URL = '';

// Every fetch made by the code under test is recorded; only loopback is allowed.
const realFetch = globalThis.fetch;
const fetchCalls: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  fetchCalls.push(url);
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error(`selftest: blocked egress to ${host}`);
  return realFetch(input, init);
}) as typeof fetch;

const { attentionOf, AttentionTracker, Coalescer } = await import('../../../shared/attention.ts');
const T = await import('./telegram.ts');
const { Debates } = await import('../db.ts');
const N = await import('./index.ts');

let fails = 0;
let passes = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) passes++;
  else fails++;
  console.log(`${cond ? '  ok  ' : '  FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};

const TOKEN = '987654321:AAselftestCANARYtoken_abcdefghijklmnop';
const CONFIG = { provider: 'claude', mode: 'directed', autonomy: 'interactive', profile: 'standard' } as any;
const SECRET_TOPIC = 'SECRET-TOPIC acquisition of Initech by Globex';
const SECRET_TITLE = 'SECRET-TITLE Globex x Initech';

// ---------------------------------------------------------------- attention
console.log('\nattention');
ok('clarifying is a question', attentionOf({ status: 'clarifying' })?.kind === 'question');
ok('each gate is an approval with its own key',
  attentionOf({ status: 'goal_approval' })?.key === 'approval:goal' && attentionOf({ status: 'plan_approval' })?.key === 'approval:plan');
ok('mid-debate question keyed by question id',
  attentionOf({ status: 'meeting', pendingQuestionId: 'q1' })?.key === 'question:q1');
ok('a meeting with nothing pending needs nobody', attentionOf({ status: 'meeting' }) === null);
ok('usage-limit pause needs you', attentionOf({ status: 'paused', limitPaused: true })?.kind === 'paused');
ok("the founder's own pause is not news", attentionOf({ status: 'paused' }) === null);
ok('error and report', attentionOf({ status: 'error' })?.kind === 'error' && attentionOf({ status: 'complete' })?.kind === 'report');
ok('cancelled needs nobody', attentionOf({ status: 'cancelled', pendingQuestionId: 'q' }) === null);
ok('working states need nobody', ['intake', 'panel_design', 'planning', 'wrapup', 'reporting'].every((s) => attentionOf({ status: s as any }) === null));

// ---------------------------------------------------------------- transitions
console.log('\ntransitions');
{
  const t = new AttentionTracker();
  ok('first sighting seeds silently', t.observe('a', attentionOf({ status: 'goal_approval' })) === null);
  ok('same state again is silent', t.observe('a', attentionOf({ status: 'goal_approval' }), true) === null);
  ok('leaving attention is silent', t.observe('a', null, true) === null);
  ok('entering a new gate fires', t.observe('a', attentionOf({ status: 'panel_approval' }), true)?.kind === 'approval');
  ok('gate to question directly fires', t.observe('a', attentionOf({ status: 'meeting', pendingQuestionId: 'q1' }), true)?.kind === 'question');
  ok('a second question fires', t.observe('a', attentionOf({ status: 'meeting', pendingQuestionId: 'q2' }), true)?.kind === 'question');
  ok('announceNew fires on a new debate already waiting', t.observe('b', attentionOf({ status: 'error' }), true)?.kind === 'error');
  const changes = t.observeAll([{ id: 'a', attention: attentionOf({ status: 'complete' }) }, { id: 'c', attention: attentionOf({ status: 'error' }) }]);
  ok('observeAll: one transition, new rows seeded silently', changes.length === 1 && changes[0].id === 'a' && changes[0].kind === 'report');
  ok('observeAll forgets vanished debates', t.observe('b', attentionOf({ status: 'error' })) === null);
}

// ---------------------------------------------------------------- coalescing
console.log('\ncoalescing');
function fakeClock() {
  let now = 1_000_000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimer: (id: unknown) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    advance(ms: number) {
      now += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= now) { timers.splice(timers.indexOf(t), 1); t.fn(); }
      }
    },
  };
}
{
  const clock = fakeClock();
  const sent: string[] = [];
  let wanted = true;
  const c = new Coalescer((id, kind) => sent.push(`${id}:${kind}`), { windowMs: 30_000, ...clock, stillWanted: () => wanted });
  c.push('d1', 'approval');
  ok('first send is immediate', sent.join() === 'd1:approval');
  clock.advance(5_000);
  c.push('d1', 'question');
  clock.advance(5_000);
  c.push('d1', 'approval');
  ok('inside the window nothing more is sent', sent.length === 1 && c.pendingCount() === 1);
  c.push('d2', 'error');
  ok('another debate is not held back', sent.includes('d2:error'));
  clock.advance(20_000);
  ok('one trailing send at the window edge with the latest kind', sent.length === 3 && sent[2] === 'd1:approval', sent.join());
  clock.advance(10_000);
  c.push('d1', 'question');
  wanted = false;
  clock.advance(30_000);
  ok('a coalesced send the founder already dealt with is dropped', sent.length === 3, sent.join());
  wanted = true;
  clock.advance(1_000);
  c.push('d1', 'report');
  ok('after a quiet window it is immediate again', sent[3] === 'd1:report', sent.join());
  c.push('d1', 'error');
  c.stop();
  clock.advance(60_000);
  ok('stop() cancels pending sends', sent.length === 4 && c.pendingCount() === 0);
}

// ---------------------------------------------------------------- settings
console.log('\nsettings');
const srv = { host: '127.0.0.1', port: 8794 };
ok('off with nothing set', T.telegramSettingsFrom({}, srv).settings === null && T.telegramSettingsFrom({}, srv).problem === null);
{
  const half = T.telegramSettingsFrom({ TELEGRAM_BOT_TOKEN: TOKEN }, srv);
  ok('off with only the token, and says why without the token', half.settings === null && !!half.problem && !half.problem.includes(TOKEN));
  ok('off with only the chat id', T.telegramSettingsFrom({ TELEGRAM_CHAT_ID: '42' }, srv).settings === null);
  const bad = T.telegramSettingsFrom({ TELEGRAM_BOT_TOKEN: 'not a token at all', TELEGRAM_CHAT_ID: '42' }, srv);
  ok('a malformed token is refused without echoing it', bad.settings === null && !bad.problem!.includes('not a token'));
  const s = T.telegramSettingsFrom({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' }, srv).settings!;
  ok('defaults: api.telegram.org, minimal, every kind', s.apiBase === 'https://api.telegram.org' && s.detail === 'minimal' && s.kinds.size === 5);
  ok('link base defaults to this server', s.linkBase === 'http://127.0.0.1:8794');
  const w = T.telegramSettingsFrom({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '-1001', TELEGRAM_NOTIFY: 'report, error,bogus', TELEGRAM_DETAIL: 'title', PUBLIC_URL: 'https://debate.example/app/' }, { host: '0.0.0.0', port: 1 }).settings!;
  ok('TELEGRAM_NOTIFY filters kinds and ignores junk', [...w.kinds].sort().join() === 'error,report');
  ok('TELEGRAM_DETAIL=title and PUBLIC_URL respected', w.detail === 'title' && w.linkBase === 'https://debate.example/app');
}
ok('API base: unset is api.telegram.org', T.resolveApiBase(undefined) === 'https://api.telegram.org');
ok('API base: loopback test server allowed', T.resolveApiBase('http://127.0.0.1:9/x') === 'http://127.0.0.1:9' && T.resolveApiBase('http://localhost:9') === 'http://localhost:9');
ok('API base: any other host refused', ['https://attacker.example', 'http://10.0.0.5:80', 'http://127.0.0.1.evil.example', 'file:///etc/passwd', 'nonsense']
  .every((v) => T.resolveApiBase(v) === null));
ok('a non-loopback test base turns Telegram off', T.telegramSettingsFrom({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42', TELEGRAM_API_BASE_TEST: 'https://attacker.example' }, srv).settings === null);

// ---------------------------------------------------------------- redaction + text
console.log('\nredaction and message text');
ok('redact removes the exact token', !T.redact(`boom ${TOKEN} boom`, TOKEN).includes(TOKEN));
ok('redact removes token-shaped strings without being told', !T.redact(`x 123456789:${'A'.repeat(35)} y`).includes('A'.repeat(35)));
ok('redact removes the /bot segment of a URL', T.redact('POST https://api.telegram.org/botWHATEVER/sendMessage') === 'POST https://api.telegram.org/bot[redacted]/sendMessage');
{
  const minimal = T.messageText({ detail: 'minimal', linkBase: 'http://127.0.0.1:8794' }, 'd_abc', 'question', SECRET_TITLE);
  ok('minimal: fixed wording plus a link, no title', minimal === 'The Debate App: a debate needs your answer.\nhttp://127.0.0.1:8794/debate/d_abc', minimal);
  const titled = T.messageText({ detail: 'title', linkBase: 'http://x' }, 'd_abc', 'report', `${SECRET_TITLE}\n\nwith   spaces`);
  ok('title mode adds the title on one line; report links to the report', titled.includes(`"${SECRET_TITLE} with spaces"`) && titled.endsWith('/debate/d_abc/report'), titled);
}

// ---------------------------------------------------------------- fake Telegram API
console.log('\nsender against a fake Telegram API on 127.0.0.1');
const received: { method: string; url: string; body: string }[] = [];
let failNext = 0;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ method: req.method ?? '', url: req.url ?? '', body });
    if (failNext > 0) {
      failNext--;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, description: `Unauthorized for bot${TOKEN}` }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true,"result":{}}');
  });
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(fake.address() as any).port}`;
const settings = T.telegramSettingsFrom(
  { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '4242', TELEGRAM_API_BASE_TEST: base },
  srv
).settings!;
{
  const err = await T.sendTelegram(settings, 'hello');
  const r = received.at(-1)!;
  ok('one POST to /bot<token>/sendMessage', err === null && r.method === 'POST' && r.url === `/bot${TOKEN}/sendMessage`, `${err} ${r?.url}`);
  const j = JSON.parse(r.body);
  ok('body: chat id, text, no parse_mode, no link preview', j.chat_id === '4242' && j.text === 'hello' && !('parse_mode' in j) && j.disable_web_page_preview === true);
  failNext = 1;
  const e2 = await T.sendTelegram(settings, 'x');
  ok('an API error is reported, redacted', !!e2 && e2.includes('401') && !e2.includes(TOKEN), e2 ?? '');
  const dead = await T.sendTelegram({ ...settings, apiBase: 'http://127.0.0.1:1' }, 'x');
  ok('a network failure never throws and is redacted', !!dead && !dead.includes(TOKEN), dead ?? '');
}

// ---------------------------------------------------------------- notifier on the real store
console.log('\nnotifier on the debate store');
{
  const clock = fakeClock();
  const logs: string[] = [];
  const pre = Debates.create('d_preexisting', SECRET_TOPIC, CONFIG);
  Debates.patch(pre.id, { status: 'goal_approval', title: SECRET_TITLE });
  const n = N.createNotifier({ settings, getRow: (id) => Debates.get(id), log: (l) => logs.push(l), ...clock });
  n.seed([pre.id]);
  const before = received.length;
  n.observe(pre.id);
  ok('a debate already waiting at boot is not re-announced', received.length === before);

  const d = Debates.create('d_notifytest1', SECRET_TOPIC, CONFIG);
  Debates.patch(d.id, { title: SECRET_TITLE });
  n.observe(d.id);
  const meta = Debates.get(d.id)!.meta;
  Debates.patch(d.id, { status: 'clarifying' });
  n.observe(d.id);
  await n.drain();
  ok('clarify batch sends one message', received.length === before + 1);
  const sentText = JSON.parse(received.at(-1)!.body).text as string;
  ok('minimal mode sends no debate text', !sentText.includes('SECRET') && !sentText.includes('Globex') && sentText.includes('/debate/d_notifytest1'), sentText);

  Debates.patch(d.id, { status: 'intake' }); n.observe(d.id);
  Debates.patch(d.id, { status: 'goal_approval' }); n.observe(d.id);
  Debates.patch(d.id, { status: 'panel_design' }); n.observe(d.id);
  Debates.patch(d.id, { status: 'panel_approval' }); n.observe(d.id);
  await n.drain();
  ok('two gates within 30s: nothing more yet', received.length === before + 1);
  clock.advance(30_000);
  await n.drain();
  ok('one coalesced message at the window edge', received.length === before + 2 && JSON.parse(received.at(-1)!.body).text.includes('approval'));

  meta.pendingQuestionId = 'uq_1';
  Debates.patch(d.id, { status: 'meeting', meta });
  n.observe(d.id);
  meta.pendingQuestionId = null;
  Debates.patch(d.id, { meta });
  n.observe(d.id);
  clock.advance(30_000);
  await n.drain();
  ok('a question answered inside the window is never sent', received.length === before + 2);

  clock.advance(30_000);
  failNext = 2;
  Debates.patch(d.id, { status: 'error' }); n.observe(d.id);
  await n.drain();
  clock.advance(31_000);
  Debates.patch(d.id, { status: 'complete' }); n.observe(d.id);
  await n.drain();
  ok('a failed send logs once, redacted', logs.length === 1 && !logs[0].includes(TOKEN), JSON.stringify(logs));
  clock.advance(31_000);
  Debates.patch(d.id, { status: 'meeting' }); n.observe(d.id);
  Debates.patch(d.id, { status: 'complete' }); n.observe(d.id);
  await n.drain();
  ok('the next success clears the failure state silently', logs.length === 1 && JSON.parse(received.at(-1)!.body).text.includes('report'));

  const t = Debates.create('d_notifytest2', SECRET_TOPIC, CONFIG);
  const titled = N.createNotifier({ settings: { ...settings, detail: 'title' }, getRow: (id) => Debates.get(id), ...fakeClock() });
  Debates.patch(t.id, { title: SECRET_TITLE }); titled.observe(t.id);
  Debates.patch(t.id, { status: 'error' }); titled.observe(t.id);
  await titled.drain();
  ok('title mode carries the title but never the topic', JSON.parse(received.at(-1)!.body).text.includes(SECRET_TITLE) && !received.at(-1)!.body.includes('SECRET-TOPIC'));

  const only = N.createNotifier({ settings: { ...settings, kinds: new Set(['report'] as const) }, getRow: (id) => Debates.get(id), ...fakeClock() });
  const o = Debates.create('d_notifytest3', SECRET_TOPIC, CONFIG);
  only.observe(o.id);
  const k0 = received.length;
  Debates.patch(o.id, { status: 'goal_approval' }); only.observe(o.id);
  await only.drain();
  ok('TELEGRAM_NOTIFY=report skips approvals', received.length === k0);
  n.stop(); titled.stop(); only.stop();
}

// ---------------------------------------------------------------- env unset
console.log('\nwith the env unset');
{
  ok('telegramEnabled() is false', N.telegramEnabled() === false);
  const calls0 = fetchCalls.length;
  const recv0 = received.length;
  N.startNotifications();
  const d = Debates.create('d_notifytest4', SECRET_TOPIC, CONFIG);
  for (const s of ['clarifying', 'goal_approval', 'error', 'complete'] as const) Debates.patch(d.id, { status: s });
  await new Promise((r) => setTimeout(r, 50));
  ok('no request of any kind is made (fetch stub untouched)', fetchCalls.length === calls0 && received.length === recv0, fetchCalls.slice(calls0).join());
  ok('the token env var was removed at import', process.env.TELEGRAM_BOT_TOKEN === undefined);
}
ok('every request in this test went to 127.0.0.1', fetchCalls.every((u) => new URL(u).hostname === '127.0.0.1'), fetchCalls.join());

fake.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\nnotify selftest: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
