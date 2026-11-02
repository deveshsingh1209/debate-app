/**
 * Codex (ChatGPT-subscription) provider selftest — runs WITHOUT a real
 * credential, WITHOUT the network, and WITHOUT touching the config or the
 * database.
 *
 *   npx tsx server/src/agents/codex.selftest.ts     (from the repo root)
 *
 * What it is for. The interesting parts of this provider are not the happy
 * path — that was verified end to end against a real ChatGPT credential on
 * 8 Aug 2026 — they are the parts that only misbehave when something goes
 * wrong, and that would be expensive or impossible to trigger on demand: a
 * token rotating mid-session, two seats colliding on one credential, an
 * expired login, a plan limit, a JWT leaking into a log line. Every one of
 * those is forced here against a MOCK Codex and asserted.
 *
 * Imports ONLY codex.ts (which imports openai.ts, which has no runtime
 * imports), so this file cannot trip config.ts's side effects — no data
 * directory is created, no .env is read. CODEX_HOME is materialised in a
 * throwaway temp directory that is removed at the end.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ThreadEvent } from '@openai/codex-sdk';
import {
  CodexCreds,
  wireCodex,
  runAgentCodex,
  runJsonAgentCodex,
  parseCodexAuth,
  validateCodexAuth,
  codexIdentity,
  codexIsNewer,
  codexEffortFor,
  codexEnv,
  codexConfigOverrides,
  codexThreadOptions,
  materialiseCodexHome,
  readBackCredential,
  composeInput,
  redactSecrets,
  looksLikeCodexAuth,
  withCredentialLock,
  abortCodexDebate,
  bindLocalCodex,
  writeBackLocalCodexAuth,
  type CodexClientOptions,
  type CodexLike,
  type CodexThreadLike,
} from './codex.ts';
import { CredentialError } from './openai.ts';
import { modelFor, providerOfConfig } from '../../../shared/models.ts';
import type { AgentTurnOpts } from './sdk.ts';

// ---- tiny harness ----

let passed = 0;
let failed = 0;
const fails: string[] = [];

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    fails.push(name);
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(name, g === w, `got ${g}, want ${w}`);
}

// ---- fixtures ----

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-codex-selftest-'));
const DEBATE = 'selftest-debate';
const DEBATE_B = 'selftest-debate-b';

/**
 * A structurally real auth.json with structurally real (unsigned, fake) JWTs.
 * The bodies matter — plan type, account id, subject, expiry are all read out
 * of them — the signatures never are, because nothing here verifies one.
 */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.SELFTEST_FAKE_SIGNATURE_NOT_A_REAL_JWT`;
}

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

function authJson(opts: {
  plan?: string;
  refresh?: string | null;
  lastRefresh?: string;
  idExp?: number;
  accessExp?: number;
  account?: string;
} = {}): string {
  const tokens: Record<string, unknown> = {
    id_token: jwt({
      sub: 'user-selftest-0001',
      email: 'selftest@example.com',
      // Real id_tokens live ONE HOUR and are expired on almost every paste.
      exp: opts.idExp ?? PAST,
      'https://api.openai.com/auth': {
        chatgpt_account_id: opts.account ?? 'acct-selftest-aaaa',
        chatgpt_plan_type: opts.plan ?? 'plus',
        user_id: 'user-selftest-0001',
      },
    }),
    access_token: jwt({ sub: 'user-selftest-0001', exp: opts.accessExp ?? FAR_FUTURE, scp: 'openid profile' }),
    // Opaque, not a JWT — measured on the real file.
    account_id: opts.account ?? 'acct-selftest-aaaa',
  };
  if (opts.refresh !== null) tokens.refresh_token = opts.refresh ?? 'RT_SELFTEST_ORIGINAL';
  return JSON.stringify(
    { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens, last_refresh: opts.lastRefresh ?? '2026-08-08T10:00:00.000Z' },
    null,
    2
  );
}

const CRED = authJson();
const CRED_ROTATED = authJson({
  refresh: 'RT_SELFTEST_ROTATED',
  lastRefresh: '2026-08-08T12:00:00.000Z',
});

/** Every JWT in the fixture, for the "nothing leaks" assertions. */
const SECRETS = [
  JSON.parse(CRED).tokens.id_token,
  JSON.parse(CRED).tokens.access_token,
  JSON.parse(CRED).tokens.refresh_token,
] as string[];

// ---- mock Codex ----

interface Spawn {
  options: CodexClientOptions;
  threadOptions: any;
  resumedFrom: string | null;
  input: string;
  outputSchema: unknown;
}
const spawns: Spawn[] = [];
/** The auth.json each spawned turn actually saw in its CODEX_HOME. */
const seenAuth: string[] = [];

/** Scripted turns: each mock run shifts one script off the queue. */
type Script = { events: ThreadEvent[]; throws?: Error; rotateCredential?: string; holdMs?: number };
let scripts: Script[] = [];

/** Ordered log of lock acquisition/release, for the serialisation assertions. */
const lockTrace: string[] = [];

function makeMockCodex(options: CodexClientOptions): CodexLike {
  const build = (resumedFrom: string | null, threadOptions: any): CodexThreadLike => {
    let id: string | null = resumedFrom;
    return {
      get id() { return id; },
      async runStreamed(input, turnOptions) {
        const script = scripts.shift();
        if (!script) throw new Error('mock codex: script queue empty');
        spawns.push({ options, threadOptions, resumedFrom, input, outputSchema: turnOptions?.outputSchema });
        try { seenAuth.push(fs.readFileSync(path.join(options.env.HOME!, 'auth.json'), 'utf8')); } catch { seenAuth.push(''); }
        lockTrace.push(`start:${spawns.length}`);
        if (script.holdMs) await new Promise((r) => setTimeout(r, script.holdMs));

        /**
         * The mock rewrites auth.json inside CODEX_HOME exactly as the real
         * CLI does when it refreshes — that write is the whole reason the
         * read-back path exists, so faking anything less would test nothing.
         */
        if (script.rotateCredential) {
          fs.writeFileSync(path.join(options.env.HOME!, 'auth.json'), script.rotateCredential);
        }
        lockTrace.push(`end:${spawns.length}`);
        if (script.throws) throw script.throws;

        const events = script.events;
        for (const ev of events) if (ev.type === 'thread.started') id = ev.thread_id;
        return {
          events: (async function* () {
            for (const ev of events) yield ev;
          })(),
        };
      },
    };
  };
  return {
    startThread: (o) => build(null, o),
    resumeThread: (tid, o) => build(tid, o),
  };
}

const happy = (threadId: string, text: string, usage?: any): ThreadEvent[] => [
  { type: 'thread.started', thread_id: threadId },
  { type: 'turn.started' },
  // Measured on a real run: an `error` item can appear alongside a perfectly
  // good answer. It must NOT be treated as a failure.
  { type: 'item.completed', item: { id: 'err_1', type: 'error', message: 'benign non-fatal notice' } },
  { type: 'item.completed', item: { id: 'rs_1', type: 'reasoning', text: 'Weighing the options.' } },
  { type: 'item.completed', item: { id: 'msg_1', type: 'agent_message', text } },
  {
    type: 'turn.completed',
    usage: usage ?? {
      input_tokens: 11_000,
      cached_input_tokens: 1_000,
      cache_write_input_tokens: 500,
      output_tokens: 350,
      reasoning_output_tokens: 300,
    },
  },
];

// ---- wiring ----

const bumps: any[] = [];
const roles: any[] = [];
wireCodex({
  defaultTimeoutMs: 30_000,
  maxConcurrent: 3,
  debateDir: (id) => {
    const dir = path.join(TMP, id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  },
  codexFactory: async (opts) => makeMockCodex(opts),
  usage: {
    bump: (id, turn) => bumps.push({ id, ...turn }),
    role: (id, label, usd) => roles.push({ id, label, usd }),
  },
});

const baseOpts: AgentTurnOpts = {
  model: 'gpt-6.1-sol',
  system: 'You are Priya, a consumer-psychology expert.',
  prompt: 'State your position.',
  debateId: DEBATE,
  label: 'selftest:floor',
  thinking: 24_000,
};

// ---- tests ----

async function main() {
  console.log('\n[1] credential parsing and identity');
  check('looksLikeCodexAuth', looksLikeCodexAuth(CRED) && !looksLikeCodexAuth('sk-proj-abc'));
  const parsed = parseCodexAuth(CRED);
  check('parses a real-shaped auth.json', parsed.ok);
  eq('plan type read from the id_token', parsed.ok && parsed.auth.planType, 'plus');
  eq('account id read from tokens', parsed.ok && parsed.auth.accountId, 'acct-selftest-aaaa');
  eq('codex door seats come from shared/models.ts', [modelFor('codex', 'chair'), modelFor('codex', 'research'), modelFor('codex', 'react')], ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna']);
  eq('legacy codex config reads as the codex provider', providerOfConfig({ model: 'codex-gpt-6-astra' }), 'codex');

  console.log('\n[2] identity survives token rotation (the whole account depends on it)');
  eq('identity is stable across a rotated file', codexIdentity(CRED), codexIdentity(CRED_ROTATED));
  check('identity is not a hash of the document', CRED !== CRED_ROTATED);
  check('rotated file is recognised as newer', codexIsNewer(CRED_ROTATED, CRED));
  check('older file is not', !codexIsNewer(CRED, CRED_ROTATED));

  console.log('\n[3] intake refusals name the file the user is holding');
  const configFile = parseCodexAuth('{"model":"gpt-6.1-sol","model_reasoning_effort":"xhigh"}');
  check('config.toml-as-json is named', !configFile.ok && /config file, not auth\.json/i.test((configFile as any).error));
  const apiKeyMode = parseCodexAuth(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-proj-x', tokens: null }));
  check('api-key mode is named and redirected', !apiKeyMode.ok && /API-key mode/i.test((apiKeyMode as any).error));
  const noAccount = parseCodexAuth(JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  check('missing account_id is named', !noAccount.ok && /account_id/i.test((noAccount as any).error));
  check('garbage json is refused', !parseCodexAuth('{not json').ok);

  /**
   * THE REGRESSION THIS SECTION EXISTS FOR.
   *
   * The first version of validateCodexAuth refused any credential whose
   * id_token had expired. Measured against a real account: the id_token lives
   * ONE HOUR, so it is expired on virtually every paste, while the same file
   * ran real Codex turns perfectly. That check rejected working credentials
   * and was caught only by an end-to-end run. It must never come back.
   */
  const staleId = validateCodexAuth(authJson({ idExp: PAST }));
  check('an expired id_token is NOT a refusal (it lives one hour; every paste has one)', staleId.ok === true);
  check('and it raises no warning either', staleId.ok === true && (staleId as any).warning === null);

  const staleAccess = validateCodexAuth(authJson({ accessExp: PAST }));
  check('an expired access token with a refresh token is allowed', staleAccess.ok === true);
  check('but it is flagged as stale', staleAccess.ok === true && /stale|lapsed/i.test(String((staleAccess as any).warning)));

  const unrecoverable = validateCodexAuth(authJson({ accessExp: PAST, refresh: null }));
  check(
    'expired access token AND no refresh token is the one genuine refusal',
    !unrecoverable.ok && /expired/i.test((unrecoverable as any).error)
  );

  const free = validateCodexAuth(authJson({ plan: 'free' }));
  check('a free plan is WARNED, not blocked', free.ok === true && !!(free as any).warning);
  const plus = validateCodexAuth(CRED);
  check('a plus plan gets no warning', plus.ok === true && (plus as any).warning === null);

  console.log('\n[4] thinking budget -> reasoning effort');
  eq('fast-tier calls floor at low (minimal is unsupported by this family)', codexEffortFor(1_024), 'low');
  eq('steer', codexEffortFor(8_000), 'low');
  eq('floor', codexEffortFor(24_000), 'medium');
  eq('referee/chair', codexEffortFor(32_000), 'medium');
  eq('heavy', codexEffortFor(60_000), 'xhigh');

  console.log('\n[5] CODEX_HOME materialisation and permissions');
  CodexCreds.use(DEBATE, CRED, () => {});
  const home = materialiseCodexHome(DEBATE, CRED);
  const dirMode = fs.statSync(home.dir).mode & 0o777;
  const fileMode = fs.statSync(home.authPath).mode & 0o777;
  eq('CODEX_HOME is 0700', dirMode.toString(8), '700');
  eq('auth.json is 0600', fileMode.toString(8), '600');
  eq('auth.json holds the credential verbatim', fs.readFileSync(home.authPath, 'utf8'), CRED);
  check('the home lives under the debate dir', home.dir.startsWith(path.join(TMP, DEBATE)));
  check('the work dir is separate from the home', home.workDir !== home.dir);
  eq('work dir is empty (nothing to read)', fs.readdirSync(home.workDir).length, 0);

  console.log('\n[6] environment isolation: three variables, no inheritance, no token');
  process.env.SELFTEST_HOST_SECRET = 'HOST_BOT_TOKEN_LOOKALIKE';
  const env = codexEnv(home);
  eq('exactly three variables', Object.keys(env).sort(), ['CODEX_HOME', 'HOME', 'PATH']);
  eq('HOME is redirected into the debate', env.HOME, home.dir);
  eq('CODEX_HOME is the same private dir', env.CODEX_HOME, home.dir);
  check('no host secret is inherited', !Object.values(env).some((v) => v.includes('HOST_BOT_TOKEN_LOOKALIKE')));
  check(
    'the credential is NOT in the environment (it is a 0600 file)',
    !Object.values(env).some((v) => SECRETS.some((s) => v.includes(s)) || v.includes('refresh_token'))
  );
  delete process.env.SELFTEST_HOST_SECRET;

  console.log('\n[7] sandbox posture (a permission profile, NOT --sandbox)');
  const threadOpts: any = codexThreadOptions('gpt-6-astra', 24_000, home.workDir);
  check(
    'sandboxMode is ABSENT — passing it silently disables the permission profile',
    !('sandboxMode' in threadOpts)
  );
  eq('never asks for approval', threadOpts.approvalPolicy, 'never');
  eq('no network', threadOpts.networkAccessEnabled, false);
  eq('no web search', [threadOpts.webSearchEnabled, threadOpts.webSearchMode], [false, 'disabled']);
  eq('runs in the debate work dir', threadOpts.workingDirectory, home.workDir);
  eq('git repo check skipped', threadOpts.skipGitRepoCheck, true);
  eq('the model id is passed through unchanged', threadOpts.model, 'gpt-6-astra');
  const cfg: any = codexConfigOverrides();
  eq('a default permission profile is named', typeof cfg.default_permissions, 'string');
  eq('the profile denies the whole filesystem', cfg.permissions[cfg.default_permissions].filesystem[':root'], 'deny');

  console.log('\n[8] a whole turn: whole-message delivery, usage, zero cost');
  spawns.length = 0; bumps.length = 0; roles.length = 0;
  scripts = [{ events: happy('thr_1', 'Position: hold the line.') }];
  const deltas: string[] = [];
  const thinking: string[] = [];
  const r1 = await runAgentCodex({ ...baseOpts, onDelta: (t) => deltas.push(t), onThinking: (t) => thinking.push(t) });
  eq('text returned', r1.text, 'Position: hold the line.');
  eq('thread id becomes the session id', r1.sessionId, 'thr_1');
  eq('onDelta fired ONCE with the whole message', deltas, ['Position: hold the line.']);
  check('delta stream and stored text agree exactly', deltas.join('\n\n') === r1.text);
  eq('reasoning fed to onThinking', thinking, ['Weighing the options.']);
  eq('an error ITEM did not fail the turn', r1.text.length > 0, true);
  eq('usage: uncached input, cache split kept', r1.usage, { input: 10_000, output: 350, cacheWrite: 500, cacheRead: 1_000 });
  eq('cost is zero — a subscription has no marginal charge', r1.costUsd, 0);
  eq('no tools were used, and it says so', r1.toolCalls, []);
  eq('ledger recorded the tokens', { input: bumps[0].input, output: bumps[0].output, cacheRead: bumps[0].cacheRead }, { input: 10_000, output: 350, cacheRead: 1_000 });
  eq('ledger recorded zero spend', bumps[0].costUsd, 0);
  eq('role spend attributed', roles[0].label, 'selftest:floor');
  eq('system prompt prepended on a fresh thread', spawns[0].input.startsWith(baseOpts.system), true);
  check('capability note stated on the fresh thread', /NO web access/.test(spawns[0].input));
  check('the prompt itself is there', spawns[0].input.includes('State your position.'));

  console.log('\n[9] resume: the persona is not re-sent, a CHANGED one is');
  spawns.length = 0;
  scripts = [{ events: happy('thr_1', 'Second turn.') }];
  await runAgentCodex({ ...baseOpts, resume: 'thr_1', prompt: 'Respond to Rajesh.' });
  eq('resumed the same thread', spawns[0].resumedFrom, 'thr_1');
  eq('system prompt NOT re-sent (the thread holds it)', spawns[0].input, 'Respond to Rajesh.');
  spawns.length = 0;
  scripts = [{ events: happy('thr_1', 'Recast turn.') }];
  await runAgentCodex({ ...baseOpts, resume: 'thr_1', system: 'You are Rajesh, a pricing strategist.', prompt: 'Go.' });
  check('a CHANGED system prompt IS re-sent', spawns[0].input.startsWith('You are Rajesh'));

  console.log('\n[10] credential refresh write-back (without this, every account dies)');
  spawns.length = 0;
  const refreshed: string[] = [];
  CodexCreds.use(DEBATE, CRED, (updated) => refreshed.push(updated));
  scripts = [{ events: happy('thr_2', 'Turn during which the token rotated.'), rotateCredential: CRED_ROTATED }];
  await runAgentCodex({ ...baseOpts });
  eq('the rotated file was handed to the re-seal callback exactly once', refreshed.length, 1);
  eq('and it is the new document', refreshed[0], CRED_ROTATED.trim());
  // The next turn must spawn with the NEW credential on disk, not the old one.
  spawns.length = 0;
  scripts = [{ events: happy('thr_3', 'Next turn.') }];
  await runAgentCodex({ ...baseOpts });
  eq('the next turn spawned with the refreshed credential', JSON.parse(seenAuth.at(-1)!).tokens.refresh_token, 'RT_SELFTEST_ROTATED');

  console.log('\n[11] refresh is read back even when the turn FAILED');
  /**
   * A SEPARATE ChatGPT account, because the registry is keyed by account and
   * the one above is already holding the rotated document — re-binding it with
   * the older fixture is correctly ignored (see [15]). Sharing the account
   * here would test the staleness guard a second time instead of the
   * failed-turn write-back.
   */
  const FAIL_ACCT = 'acct-selftest-fail';
  const failCred = authJson({ account: FAIL_ACCT });
  const failRotated = authJson({ account: FAIL_ACCT, refresh: 'RT_SELFTEST_ROTATED', lastRefresh: '2026-08-08T12:00:00.000Z' });
  const refreshed2: string[] = [];
  CodexCreds.use('selftest-failing', failCred, (updated) => refreshed2.push(updated));
  scripts = [
    { events: [], throws: new Error('Codex Exec exited with code 1: something went wrong'), rotateCredential: failRotated },
    { events: [], throws: new Error('Codex Exec exited with code 1: something went wrong again') },
  ];
  await runAgentCodex({ ...baseOpts, debateId: 'selftest-failing' }).catch(() => {});
  check(
    'a failed turn still persisted the refresh',
    refreshed2.length >= 1 && refreshed2[0] === failRotated.trim(),
    `got ${refreshed2.length} callback(s)`
  );

  console.log('\n[12] readBackCredential ignores non-rotations');
  const stableHome = materialiseCodexHome('selftest-stable', CRED);
  eq('identical file is not a rotation', readBackCredential(stableHome, CRED), null);
  fs.writeFileSync(stableHome.authPath, '{ broken');
  eq('an unparseable rewrite is never adopted', readBackCredential(stableHome, CRED), null);
  fs.writeFileSync(stableHome.authPath, CRED_ROTATED);
  eq('a real rotation is adopted', readBackCredential(stableHome, CRED), CRED_ROTATED.trim());

  console.log('\n[13] SERIALISATION: one turn at a time per credential (OpenAI requires it)');
  // Two debates, ONE ChatGPT account — the case that would corrupt a
  // single-use refresh token if the two ran at once.
  CodexCreds.use(DEBATE, CRED, () => {});
  CodexCreds.use(DEBATE_B, CRED, () => {});
  spawns.length = 0; lockTrace.length = 0;
  scripts = [
    { events: happy('thr_p1', 'A'), holdMs: 60 },
    { events: happy('thr_p2', 'B'), holdMs: 10 },
    { events: happy('thr_p3', 'C'), holdMs: 10 },
  ];
  await Promise.all([
    runAgentCodex({ ...baseOpts, label: 'a' }),
    runAgentCodex({ ...baseOpts, label: 'b' }),
    runAgentCodex({ ...baseOpts, debateId: DEBATE_B, label: 'c' }),
  ]);
  // Strictly interleaved start/end pairs mean no two runs overlapped.
  const interleaved = lockTrace.every((e, i) => (i % 2 === 0 ? e.startsWith('start:') : e.startsWith('end:')));
  check('three concurrent calls on one credential ran strictly one at a time', interleaved, lockTrace.join(' '));
  eq('all three still ran (queued, never rejected)', spawns.length, 3);
  check(
    'two debates on the same ChatGPT account share one lock',
    CodexCreds.peekIdentity(DEBATE) === CodexCreds.peekIdentity(DEBATE_B)
  );

  console.log('\n[14] different credentials are NOT serialised against each other');
  const otherCred = authJson({ account: 'acct-selftest-bbbb' });
  CodexCreds.use('selftest-other', otherCred, () => {});
  check('a different account is a different lock', codexIdentity(otherCred) !== codexIdentity(CRED));
  let order: string[] = [];
  await Promise.all([
    withCredentialLock('k1', async () => { await new Promise((r) => setTimeout(r, 40)); order.push('slow'); }),
    withCredentialLock('k2', async () => { order.push('fast'); }),
  ]);
  eq('independent credentials run in parallel', order, ['fast', 'slow']);
  // A rejected turn must not wedge the queue behind it.
  order = [];
  await withCredentialLock('k3', async () => { throw new Error('boom'); }).catch(() => order.push('failed'));
  await withCredentialLock('k3', async () => { order.push('after'); });
  eq('a failed turn does not wedge that credential\'s queue', order, ['failed', 'after']);

  console.log('\n[15] a stale re-bind never overwrites a fresher credential');
  CodexCreds.use('selftest-stale', CRED_ROTATED, () => {});
  CodexCreds.use('selftest-stale', CRED, () => {});   // an older copy re-bound later
  spawns.length = 0;
  scripts = [{ events: happy('thr_s', 'ok') }];
  await runAgentCodex({ ...baseOpts, debateId: 'selftest-stale' });
  eq(
    'the fresher document survived the stale re-bind',
    JSON.parse(seenAuth.at(-1)!).tokens.refresh_token,
    'RT_SELFTEST_ROTATED'
  );

  console.log('\n[16] strict JSON via --output-schema, and retry-on-invalid');
  spawns.length = 0;
  const schema = {
    name: 'verdict',
    schema: { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false },
  };
  scripts = [{ events: happy('thr_j1', '{"answer":42}') }];
  const j1 = await runJsonAgentCodex<{ answer: number }>({ ...baseOpts, schema }, (v) => {
    if (typeof v.answer !== 'number') throw new Error('bad answer');
    return v;
  });
  eq('outputSchema handed to the CLI', spawns[0].outputSchema, schema.schema);
  eq('json parsed', j1.value, { answer: 42 });
  eq('json session id', j1.sessionId, 'thr_j1');

  spawns.length = 0;
  scripts = [
    { events: happy('thr_j2', 'sorry, prose instead of JSON') },
    { events: happy('thr_j2', '{"answer":7}') },
  ];
  const j2 = await runJsonAgentCodex<{ answer: number }>({ ...baseOpts });
  eq('no schema means no outputSchema flag', spawns[0].outputSchema, undefined);
  eq('retried exactly once', spawns.length, 2);
  eq('the retry resumed the SAME thread', spawns[1].resumedFrom, 'thr_j2');
  check('the retry states the parse error', spawns[1].input.includes('could not be used'));
  eq('repaired value', j2.value, { answer: 7 });

  console.log('\n[17] error classification');
  const cases: { name: string; message: string; expect: 'credential' | 'limit' | 'other' }[] = [
    { name: 'expired login', message: 'Your access token could not be refreshed. Please log out and sign in again.', expect: 'credential' },
    { name: 'refresh token rejected', message: 'OAuth refresh token was rejected: invalid_grant', expect: 'credential' },
    { name: 'reused refresh token', message: 'refresh token was reused', expect: 'credential' },
    { name: '401', message: 'Codex Exec exited with code 1: HTTP 401 Unauthorized', expect: 'credential' },
    { name: 'plan usage limit', message: "You've hit your usage limit. Upgrade to Plus to continue using Codex", expect: 'limit' },
    { name: 'usage limit for window', message: "You've hit your usage limit for gpt-6-astra", expect: 'limit' },
    { name: '429', message: 'Codex Exec exited with code 1: 429 too many requests', expect: 'limit' },
    { name: 'unrelated crash', message: 'Codex Exec exited with signal SIGSEGV', expect: 'other' },
  ];
  for (const c of cases) {
    CodexCreds.use('selftest-err', CRED, () => {});
    scripts = [{ events: [], throws: new Error(c.message) }, { events: [], throws: new Error(c.message) }];
    let got: any = null;
    await runAgentCodex({ ...baseOpts, debateId: 'selftest-err' }).catch((e) => { got = e; });
    const msg = String(got?.message ?? '');
    const kind =
      got instanceof CredentialError ? 'credential'
        : /\b429\b|usage limit|rate limit/i.test(msg) ? 'limit'
          : 'other';
    eq(`${c.name} -> ${c.expect}`, kind, c.expect);
    if (c.expect === 'limit') {
      /**
       * The exact contract sdk.asUsageLimit() matches on. If this drifts, a
       * plan limit stops PARKING the session and starts KILLING it, which is
       * how hours of argument get thrown away.
       */
      check(
        `${c.name} is worded so asUsageLimit() parks the session`,
        /usage limit|rate limit|limit reached|too many requests|\b429\b/i.test(msg)
      );
    }
  }

  console.log('\n[18] no JWT ever reaches an error message, a log line, or a thrown value');
  const leaky =
    `request failed: Bearer ${SECRETS[1]} rejected; body {"access_token":"${SECRETS[1]}",` +
    `"refresh_token":"${SECRETS[2]}"} at ${TMP}/x/codex-home/auth.json`;
  const scrubbed = redactSecrets(leaky);
  for (const s of SECRETS) check(`redactSecrets removes a JWT (${s.slice(0, 12)}…)`, !scrubbed.includes(s));
  check('redactSecrets hides the credential path', !/codex-home\/auth\.json/.test(scrubbed));
  check('redactSecrets keeps the useful part', /request failed/.test(scrubbed));

  CodexCreds.use('selftest-leak', CRED, () => {});
  scripts = [
    { events: [], throws: new Error(`Codex Exec exited with code 1: 500 from api, sent Bearer ${SECRETS[1]}`) },
    { events: [], throws: new Error(`Codex Exec exited with code 1: 500 from api, sent Bearer ${SECRETS[1]}`) },
  ];
  let leaked: any = null;
  await runAgentCodex({ ...baseOpts, debateId: 'selftest-leak' }).catch((e) => { leaked = e; });
  const thrown = `${leaked?.message ?? ''} ${leaked?.stack ?? ''}`;
  for (const s of SECRETS) check(`thrown error carries no JWT (${s.slice(0, 12)}…)`, !thrown.includes(s));

  // And the same for a turn.failed event, which is the other way a message
  // from OpenAI reaches us.
  CodexCreds.use('selftest-leak2', CRED, () => {});
  scripts = [
    { events: [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.failed', error: { message: `auth blew up with ${SECRETS[0]}` } }] },
    { events: [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.failed', error: { message: `auth blew up with ${SECRETS[0]}` } }] },
  ];
  let leaked2: any = null;
  await runAgentCodex({ ...baseOpts, debateId: 'selftest-leak2' }).catch((e) => { leaked2 = e; });
  check('turn.failed message is scrubbed too', !String(leaked2?.message ?? '').includes(SECRETS[0]));

  console.log('\n[19] missing credential fails as a credential problem, before any spawn');
  spawns.length = 0;
  let noCred: any = null;
  await runAgentCodex({ ...baseOpts, debateId: 'selftest-unbound' }).catch((e) => { noCred = e; });
  check('CredentialError', noCred instanceof CredentialError, String(noCred?.name));
  eq('nothing was spawned', spawns.length, 0);

  console.log('\n[20] a stop request kills QUEUED turns, not just the running one');
  /**
   * The failure mode serialisation introduces. Six seats queue behind one
   * credential; the user presses stop. Without a queue ticket, the running
   * turn dies and the five behind it each start in sequence, spending the
   * user's usage window on a room that was told to be quiet.
   */
  CodexCreds.use('selftest-stop', CRED, () => {});
  spawns.length = 0;
  scripts = [
    { events: happy('thr_stop1', 'first'), holdMs: 80 },
    { events: happy('thr_stop2', 'second') },
    { events: happy('thr_stop3', 'third') },
    { events: happy('thr_stop4', 'fourth') },
  ];
  const stopOpts = { ...baseOpts, debateId: 'selftest-stop' };
  const queued = [
    runAgentCodex({ ...stopOpts, label: 's1' }),
    runAgentCodex({ ...stopOpts, label: 's2' }),
    runAgentCodex({ ...stopOpts, label: 's3' }),
    runAgentCodex({ ...stopOpts, label: 's4' }),
  ].map((p) => p.then(() => 'ran', (e) => (e?.name === 'AbortError' ? 'aborted' : `error:${e?.message}`)));
  await new Promise((r) => setTimeout(r, 20));   // let the first one get into the CLI
  const killed = abortCodexDebate('selftest-stop');
  const outcomes = await Promise.all(queued);
  check('the stop reported killing every seat, queued included', killed >= 4, `killed=${killed}`);
  check(
    'the queued seats aborted instead of spawning',
    outcomes.filter((o) => o === 'aborted').length >= 3,
    outcomes.join(',')
  );
  check('at most one turn actually reached the CLI', spawns.length <= 1, `spawns=${spawns.length}`);

  console.log('\n[21] composeInput never drops the prompt');
  const composed = composeInput({ ...baseOpts, resume: 'unknown-thread' });
  check('an unknown resumed thread re-sends the system prompt (fail safe)', composed.startsWith(baseOpts.system));
  check('and still carries the prompt', composed.includes('State your position.'));

  console.log('\n[22] the local `codex login`: read per turn, rotation written back, no copy left behind');
  const localDir = path.join(TMP, 'local-codex-home');
  fs.mkdirSync(localDir, { recursive: true });
  const localPath = path.join(localDir, 'auth.json');
  const LOCAL = authJson({ account: 'acct-local-1111', refresh: 'RT_LOCAL_ORIGINAL', lastRefresh: '2026-10-01T10:00:00.000Z' });
  const LOCAL_ROTATED = authJson({ account: 'acct-local-1111', refresh: 'RT_LOCAL_ROTATED', lastRefresh: '2026-10-01T11:00:00.000Z' });
  const LOCAL_NEWER = authJson({ account: 'acct-local-1111', refresh: 'RT_LOCAL_BY_USER_CLI', lastRefresh: '2026-10-01T12:00:00.000Z' });
  check('no login file -> not bound', !bindLocalCodex('selftest-local', path.join(localDir, 'missing.json')));
  fs.writeFileSync(localPath, LOCAL, { mode: 0o600 });
  check('login file -> bound', bindLocalCodex('selftest-local', localPath));

  scripts = [{ events: happy('th_local_1', 'Local turn.'), rotateCredential: LOCAL_ROTATED }];
  await runAgentCodex({ ...baseOpts, debateId: 'selftest-local' });
  eq('a rotation during our turn is written back to the user\'s auth.json',
    JSON.parse(fs.readFileSync(localPath, 'utf8')).tokens.refresh_token, 'RT_LOCAL_ROTATED');
  eq('the written-back file is 0600', fs.statSync(localPath).mode & 0o777, 0o600);
  check('no credential copy stays in the debate directory after the turn',
    !fs.existsSync(path.join(TMP, 'selftest-local', 'codex-home', 'auth.json')));

  fs.writeFileSync(localPath, LOCAL_NEWER, { mode: 0o600 });   // the user's own CLI refreshed meanwhile
  scripts = [{ events: happy('th_local_2', 'Second local turn.') }];
  await runAgentCodex({ ...baseOpts, debateId: 'selftest-local' });
  eq('the next turn picks up the user\'s newer login', JSON.parse(seenAuth.at(-1)!).tokens.refresh_token, 'RT_LOCAL_BY_USER_CLI');

  writeBackLocalCodexAuth(localPath, LOCAL_ROTATED);
  eq('an older rotation never overwrites a newer login on disk',
    JSON.parse(fs.readFileSync(localPath, 'utf8')).tokens.refresh_token, 'RT_LOCAL_BY_USER_CLI');
  CodexCreds.drop('selftest-local');

  // ---- summary ----
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed${failed ? `: ${fails.join(', ')}` : ''}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* nothing to clean */ }
  console.error('selftest crashed:', e);
  process.exit(1);
});
