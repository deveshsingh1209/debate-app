/**
 * The four doors, offline: readiness probes against fake machines, fake
 * `claude` and `codex` executables on disk, the Claude API key reaching the
 * Claude child and nothing else, and no secret in any status. No model call,
 * no network, nothing outside a temp dir.
 *
 *   npx tsx src/doors/doors.selftest.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-doors-test-'));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);

/**
 * Fake CLIs. Each answers only the status commands the probe uses and
 * records every call, so the test can prove nothing else (no prompt, no
 * model call) was ever asked of them. Their mood comes from a file, so one
 * process can flip them between states.
 */
const calls = path.join(tmp, 'calls.log');
const mood = (name: string) => path.join(tmp, `${name}.mood`);
const script = (name: string, body: string) => {
  const f = path.join(bin, name);
  fs.writeFileSync(f, `#!/bin/sh\necho "${name} $*" >> "${calls}"\nMOOD=$(cat "${mood(name)}" 2>/dev/null)\n${body}\n`, { mode: 0o755 });
  return f;
};
const fakeClaude = script('claude', `
case "$1 $2" in
  "--version ") echo "9.9.9 (Claude Code)"; exit 0;;
  "--setting-sources= auth")
    if [ -n "$ANTHROPIC_API_KEY$OPENAI_API_KEY" ]; then echo "LEAK: key in probe env" >> "${calls}"; exit 3; fi
    case "$MOOD" in
      in) echo '{"loggedIn": true, "authMethod": "claude.ai", "email": "owner@example.com"}'; exit 0;;
      old) echo "error: unknown command 'auth'"; exit 1;;
      *) echo '{"loggedIn": false}'; exit 1;;
    esac;;
esac
echo "unexpected call: $*"; exit 2`);
script('codex', `
if [ "$1 $2" = "login status" ]; then
  case "$MOOD" in
    chatgpt) echo "Logged in using ChatGPT"; exit 0;;
    apikey) echo "Logged in using an API key - sk-proj-***SECRET"; exit 0;;
    *) echo "Not logged in"; exit 1;;
  esac
fi
echo "unexpected call: $*"; exit 2`);

const codexHome = path.join(tmp, 'codex-home');
fs.mkdirSync(codexHome);
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.MOCK = '';
process.env.CODEX_HOME = codexHome;
process.env.AGENT_CLI_PATH = fakeClaude;
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.CLAUDE_CODE_OAUTH_TOKEN = '';
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
const AKEY = 'sk-ant-api03-CANARY-anthropic-0123456789';
const OKEY = 'sk-CANARY-openai-0123456789';
process.env.ANTHROPIC_API_KEY = AKEY;
delete process.env.OPENAI_API_KEY;

const { probeDoor, probeDoors, readClaudeStatus, readCodexStatus, openEnvCommand } = await import('./probe.ts');
type ProbeEnv = import('./probe.ts').ProbeEnv;
type CmdResult = import('./probe.ts').CmdResult;
const { CFG } = await import('../config.ts');
const sdk = await import('../agents/sdk.ts');
const { doorStatuses, doorsInfo, liveProbeEnv, wireDoors, reloadKeys: rereadKeys } = await import('./index.ts');
const { CredentialError } = await import('../agents/openai.ts');
const { modelFor, MODEL_IDS, PROVIDERS, claudeEngine, providerOfConfig } = await import('../../../shared/models.ts');

let fails = 0;
let passes = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) passes++;
  else {
    fails++;
    console.log(`  FAIL ${name}${detail ? `\n       ${detail.slice(0, 400)}` : ''}`);
  }
};
const noSecret = (label: string, v: unknown) => {
  const s = JSON.stringify(v);
  ok(`${label}: no secret in the status`, ![AKEY, OKEY, 'CANARY', 'owner@example.com', 'SECRET', 'eyJ'].some((x) => s.includes(x)), s);
};

const goodCodex = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'a.b.c', refresh_token: 'r', account_id: 'acct' }, last_refresh: '2026-10-01T00:00:00Z' });

function fake(over: Partial<ProbeEnv> & { cmds?: Record<string, CmdResult>; files?: Record<string, string> } = {}): ProbeEnv {
  const cmds = over.cmds ?? {};
  const files = over.files ?? {};
  return {
    env: {},
    anthropicKey: '',
    openaiKey: '',
    claudeCli: { cmd: 'claude', args: [] },
    codexCli: { cmd: 'codex', args: [] },
    codexAuthFile: '/home/u/.codex/auth.json',
    readFile: (f) => files[f] ?? null,
    run: (cmd, args) => cmds[`${cmd} ${args.join(' ')}`] ?? { found: false, code: null, out: '' },
    envFile: '/home/u/debate/.env',
    platform: 'darwin',
    now: 1_790_000_000_000,
    ...over,
  };
}
const CLAUDE_V = { 'claude --version': { found: true, code: 0, out: '9.9.9' } };

// ---------- 1: the model mapping ----------
console.log('[1] model mapping: the Claude API door casts the same Claude models');
ok('four doors, in order', JSON.stringify(PROVIDERS) === JSON.stringify(['claude', 'anthropic', 'codex', 'openai']));
for (const seat of ['chair', 'floor', 'referee', 'research', 'lint'] as const) {
  ok(`anthropic ${seat} = claude ${seat}`, modelFor('anthropic', seat) === modelFor('claude', seat));
}
ok('chair is Opus 5.5 on both Claude doors', MODEL_IDS.anthropic.flagship === 'claude-opus-5-5');
ok('claudeEngine covers exactly the two Claude doors', claudeEngine('claude') && claudeEngine('anthropic') && !claudeEngine('codex') && !claudeEngine('openai'));
ok('a stored anthropic config reads back as anthropic', providerOfConfig({ provider: 'anthropic' }) === 'anthropic');

// ---------- 2: claude (sign in), fake machines ----------
console.log('[2] Claude sign-in door');
{
  const none = await probeDoor('claude', fake({ claudeCli: null }));
  ok('no CLI: needs setup, fix installs it', none.state === 'needs_setup' && /npm install -g @anthropic-ai\/claude-code/.test(none.fix ?? ''), JSON.stringify(none));
  const missing = await probeDoor('claude', fake());
  ok('CLI not found when run: needs setup', missing.state === 'needs_setup');
  const signedIn = await probeDoor('claude', fake({ cmds: { 'claude --setting-sources= auth status': { found: true, code: 0, out: '{"loggedIn": true, "email": "owner@example.com"}' } } }));
  ok('signed in: ready, no fix', signedIn.state === 'ready' && signedIn.fix === null);
  noSecret('signed in', signedIn);
  const out = await probeDoor('claude', fake({ cmds: { 'claude --setting-sources= auth status': { found: true, code: 1, out: '{"loggedIn": false}' } } }));
  ok('signed out: needs setup, fix says run claude', out.state === 'needs_setup' && /run `claude`/.test(out.fix ?? ''));
  const slow = await probeDoor('claude', fake({ cmds: { 'claude --setting-sources= auth status': { found: true, code: null, out: '', timedOut: true } } }));
  ok('timed out: problem', slow.state === 'problem' && !!slow.fix);
  const old = await probeDoor('claude', fake({ cmds: { 'claude --setting-sources= auth status': { found: true, code: 1, out: 'unknown command' } } }));
  ok('old CLI: problem, fix updates it', old.state === 'problem' && /Update/.test(old.fix ?? ''));
  const tok = await probeDoor('claude', fake({ claudeCli: null, env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-SECRET' } }));
  ok('CLAUDE_CODE_OAUTH_TOKEN: ready', tok.state === 'ready');
  noSecret('oauth token', tok);
  ok('readClaudeStatus: plain text signed out', readClaudeStatus({ found: true, code: 0, out: 'Not logged in. Please run /login' }) === 'out');
  ok('steps carry a copy for the install and for `claude`', signedIn.steps.some((s) => s.copy === 'claude') && signedIn.steps.some((s) => /claude-code/.test(s.copy ?? '')));
}

// ---------- 3: anthropic (API key), fake machines ----------
console.log('[3] Claude API key door');
{
  const none = await probeDoor('anthropic', fake({ cmds: CLAUDE_V }));
  ok('no key: needs setup, fix names ANTHROPIC_API_KEY', none.state === 'needs_setup' && /ANTHROPIC_API_KEY/.test(none.fix ?? ''));
  const good = await probeDoor('anthropic', fake({ anthropicKey: AKEY, cmds: CLAUDE_V }));
  ok('key + CLI: ready', good.state === 'ready', JSON.stringify(good));
  noSecret('ready key', good);
  const noCli = await probeDoor('anthropic', fake({ anthropicKey: AKEY, claudeCli: null }));
  ok('key, no Claude Code: problem, fix installs it without sign-in', noCli.state === 'problem' && /claude-code/.test(noCli.fix ?? '') && /do not need to sign in/.test(noCli.fix ?? ''));
  const cases: [string, RegExp][] = [
    ['sk-ant-oat01-SECRETTOKEN', /sign-in token/],
    ['sk-ant-admin01-SECRETADMIN', /Admin key/],
    ['sk-proj-SECRETOPENAI', /OpenAI key/],
    ['hello-SECRET', /does not look like/],
    ['sk-ant-api03 SECRET', /space or line break/],
  ];
  for (const [k, re] of cases) {
    const d = await probeDoor('anthropic', fake({ anthropicKey: k, cmds: CLAUDE_V }));
    ok(`malformed key (${re}): problem`, d.state === 'problem' && re.test(d.summary), d.summary);
    noSecret(`malformed ${re}`, d);
  }
  ok('the signed-in door is not made ready by the key', (await probeDoor('claude', fake({ anthropicKey: AKEY, cmds: CLAUDE_V }))).state !== 'ready');
  const steps = good.steps.map((s) => s.copy ?? '').join('\n');
  ok('steps: console link, open .env, the exact line', /console\.anthropic\.com/.test(steps) && /open -e/.test(steps) && /^ANTHROPIC_API_KEY=$/m.test(steps));
}

// ---------- 4: codex (sign in), fake machines ----------
console.log('[4] Codex sign-in door');
{
  const file = '/home/u/.codex/auth.json';
  const good = await probeDoor('codex', fake({ files: { [file]: goodCodex } }));
  ok('ChatGPT login file: ready', good.state === 'ready', JSON.stringify(good));
  noSecret('codex ready', good);
  const apiFile = await probeDoor('codex', fake({ files: { [file]: '{"auth_mode":"apikey","OPENAI_API_KEY":"sk-SECRET"}' } }));
  ok('API-key-mode file: problem, fix is Sign in with ChatGPT', apiFile.state === 'problem' && /Sign in with ChatGPT/.test(apiFile.fix ?? ''));
  noSecret('codex apikey file', apiFile);
  const junk = await probeDoor('codex', fake({ files: { [file]: 'not json' } }));
  ok('junk file: problem', junk.state === 'problem');
  const notInstalled = await probeDoor('codex', fake());
  ok('no file, no CLI: needs setup, fix installs Codex', notInstalled.state === 'needs_setup' && /@openai\/codex/.test(notInstalled.fix ?? ''));
  const out = await probeDoor('codex', fake({ cmds: { 'codex login status': { found: true, code: 1, out: 'Not logged in' } } }));
  ok('no file, CLI signed out: needs setup, fix is codex login', out.state === 'needs_setup' && /codex login/.test(out.fix ?? ''));
  const keyring = await probeDoor('codex', fake({ cmds: { 'codex login status': { found: true, code: 0, out: 'Logged in using ChatGPT' } } }));
  ok('no file, CLI signed in: problem (keychain), fix names the file store', keyring.state === 'problem' && /cli_auth_credentials_store/.test(keyring.fix ?? ''));
  const apikey = await probeDoor('codex', fake({ cmds: { 'codex login status': { found: true, code: 0, out: 'Logged in using an API key - sk-proj-***SECRET' } } }));
  ok('no file, CLI on an API key: problem', apikey.state === 'problem' && /API key/.test(apikey.summary));
  noSecret('codex apikey status', apikey);
  ok('readCodexStatus', readCodexStatus({ found: false, code: null, out: '' }) === 'missing' && readCodexStatus({ found: true, code: 1, out: 'Not logged in' }) === 'out');
}

// ---------- 5: openai (API key), fake machines ----------
console.log('[5] OpenAI API key door');
{
  const none = await probeDoor('openai', fake());
  ok('no key: needs setup', none.state === 'needs_setup' && /OPENAI_API_KEY/.test(none.fix ?? ''));
  const good = await probeDoor('openai', fake({ openaiKey: OKEY }));
  ok('key: ready', good.state === 'ready');
  noSecret('openai ready', good);
  const swapped = await probeDoor('openai', fake({ openaiKey: AKEY }));
  ok('an Anthropic key in OPENAI_API_KEY: problem that says where it belongs', swapped.state === 'problem' && /ANTHROPIC_API_KEY/.test(swapped.fix ?? ''));
  noSecret('openai swapped', swapped);
  const odd = await probeDoor('openai', fake({ openaiKey: 'SECRETnotakey' }));
  ok('a non-key: problem', odd.state === 'problem');
}

// ---------- 6: shape of every status, every platform ----------
console.log('[6] every status is complete and secret-free');
{
  const all = await probeDoors(fake({ anthropicKey: AKEY, openaiKey: OKEY, env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-SECRET' } }));
  ok('four statuses, in door order', all.map((d) => d.id).join() === PROVIDERS.join());
  for (const d of all) {
    ok(`${d.id}: title, blurb, summary, steps`, !!d.title && !!d.blurb && !!d.summary && d.steps.length >= 3);
    ok(`${d.id}: a fix exactly when not ready`, (d.state === 'ready') === (d.fix === null));
  }
  noSecret('all four', all);
  const broken = await probeDoor('claude', fake({ run: () => { throw new Error('boom SECRET'); } }));
  ok('a probe that throws is a problem, not a crash', broken.state === 'problem');
  noSecret('broken probe', broken);
  ok('open .env: macOS', openEnvCommand('/a b/.env', 'darwin') === 'touch "/a b/.env" && open -e "/a b/.env"');
  ok('open .env: Windows', openEnvCommand('C:\\x\\.env', 'win32') === 'notepad "C:\\x\\.env"');
  ok('open .env: Linux', /xdg-open/.test(openEnvCommand('/x/.env', 'linux')));
}

// ---------- 7: the live probe against fake executables on disk ----------
console.log('[7] live probe, fake `claude` and `codex` on disk');
{
  ok('config took the API key and removed it from process.env', CFG.anthropicApiKey === AKEY && process.env.ANTHROPIC_API_KEY === undefined);
  ok('config detected the fake claude', CFG.cliPath === fakeClaude, CFG.cliPath);
  fs.writeFileSync(mood('claude'), 'out');
  fs.writeFileSync(mood('codex'), 'out');
  let doors = await doorStatuses(true);
  const st = (id: string) => doors.find((d) => d.id === id)!;
  ok('signed-out claude: needs setup', st('claude').state === 'needs_setup', JSON.stringify(st('claude')));
  ok('anthropic key + fake CLI: ready', st('anthropic').state === 'ready', JSON.stringify(st('anthropic')));
  ok('codex signed out: needs setup', st('codex').state === 'needs_setup', JSON.stringify(st('codex')));
  ok('no OpenAI key: needs setup', st('openai').state === 'needs_setup');

  fs.writeFileSync(mood('claude'), 'in');
  doors = await doorStatuses();
  ok('cached for 30 s: a change is not seen without a re-check', st('claude').state === 'needs_setup');
  await new Promise((r) => setTimeout(r, 2_100));
  doors = await doorStatuses(true);
  ok('Re-check sees the sign-in', st('claude').state === 'ready', JSON.stringify(st('claude')));
  noSecret('live statuses', doors);

  fs.writeFileSync(mood('codex'), 'chatgpt');
  await new Promise((r) => setTimeout(r, 2_100));
  doors = await doorStatuses(true);
  ok('codex signed in to the keychain: problem', st('codex').state === 'problem');
  fs.writeFileSync(path.join(codexHome, 'auth.json'), goodCodex);
  await new Promise((r) => setTimeout(r, 2_100));
  doors = await doorStatuses(true);
  ok('codex auth.json written: ready', st('codex').state === 'ready');

  fs.writeFileSync(mood('claude'), 'old');
  await new Promise((r) => setTimeout(r, 2_100));
  doors = await doorStatuses(true);
  ok('an old claude: problem', st('claude').state === 'problem');

  const log = fs.readFileSync(calls, 'utf8').trim().split('\n');
  ok('the fake CLIs were only ever asked for status and version', log.length > 0 && log.every((l) => /^claude (--version|--setting-sources= auth status)$|^codex login status$/.test(l)), log.join(' | '));
  ok('the probe never handed an API key to a CLI', !log.some((l) => /LEAK/.test(l)));

  const info = await doorsInfo();
  ok('doorsInfo names the .env file, not its contents', info.envFile === CFG.envFile && !info.mock);
  noSecret('doorsInfo', info);
}

// ---------- 8: a key pasted into .env is picked up by Re-check, no restart ----------
console.log('[8] Re-check re-reads the keys in .env');
{
  const envFile = path.join(tmp, '.env');
  fs.writeFileSync(envFile, '# nothing yet\n');
  ok('unchanged file: nothing changes', !rereadKeys(envFile).openai && CFG.openaiApiKey === '');
  fs.writeFileSync(envFile, `OPENAI_API_KEY=${OKEY}\n`);
  const ch = rereadKeys(envFile);
  ok('added key: picked up', ch.openai && CFG.openaiApiKey === OKEY);
  ok('and bindable now', sdk.AgentAuth.bind('d_reread', 'openai'));
  fs.writeFileSync(envFile, '');
  rereadKeys(envFile);
  ok('removed key: dropped', CFG.openaiApiKey === '');
  ok('a real environment key is not overridden by an untouched file', CFG.anthropicApiKey === AKEY);
}

// ---------- 9: the key reaches the Claude child of an API-key debate, and nothing else ----------
console.log('[9] the Claude API key goes only to its own debate\'s Claude child');
{
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-SUBSCRIPTION';
  ok('bind anthropic', sdk.AgentAuth.bind('d_key', 'anthropic'));
  ok('bind claude', sdk.AgentAuth.bind('d_login', 'claude'));
  const keyEnv = sdk.claudeChildEnv('d_key');
  const loginEnv = sdk.claudeChildEnv('d_login');
  ok('API-key debate: the key is in its child env', keyEnv.ANTHROPIC_API_KEY === AKEY);
  ok('API-key debate: the sign-in token is withheld', keyEnv.CLAUDE_CODE_OAUTH_TOKEN === undefined);
  ok('login debate: no key', loginEnv.ANTHROPIC_API_KEY === undefined && loginEnv.CLAUDE_CODE_OAUTH_TOKEN === 'sk-ant-oat01-SUBSCRIPTION');
  ok('no debate (probes): no key', sdk.claudeChildEnv().ANTHROPIC_API_KEY === undefined);
  ok('every Claude child: claude.ai connectors off', keyEnv.ENABLE_CLAUDEAI_MCP_SERVERS === 'false' && loginEnv.ENABLE_CLAUDEAI_MCP_SERVERS === 'false');
  ok('the key is not in this process\'s environment', !Object.values(process.env).includes(AKEY));
  ok('capability family is Claude for the key door', sdk.debateProvider('d_key') === 'claude');
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

  // Through the real dispatch, with the Agent SDK's query swapped for a recorder.
  const seen: { env: Record<string, string>; model: string }[] = [];
  let failWith: string | null = null;
  let errorResult: string | null = null;
  sdk.wireClaude({
    queryImpl: (({ options }: any) => {
      seen.push({ env: options.env, model: options.model });
      return (async function* () {
        if (failWith) throw new Error(failWith);
        if (errorResult) {
          yield { type: 'result', subtype: 'success', is_error: true, result: errorResult, usage: { input_tokens: 0, output_tokens: 0 } } as any;
          return;
        }
        yield { type: 'result', subtype: 'success', result: 'Fine.', session_id: 's1', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } } as any;
      })();
    }) as any,
  });
  const r = await sdk.runAgent({ model: modelFor('anthropic', 'chair'), system: 'You are a test.', prompt: 'Say fine.', debateId: 'd_key', label: 'marcus:chair' });
  ok('a turn runs on the key door', r.text === 'Fine.');
  ok('its child got the key, and Opus 5.5', seen[0]?.env.ANTHROPIC_API_KEY === AKEY && seen[0]?.model === 'claude-opus-5-5');
  await sdk.runAgent({ model: modelFor('claude', 'chair'), system: 'You are a test.', prompt: 'Say fine, login door.', debateId: 'd_login', label: 'marcus:chair' });
  ok('a login-door turn never sees the key', seen[1]?.env.ANTHROPIC_API_KEY === undefined);

  failWith = `401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}} key=${AKEY}`;
  let err: unknown = null;
  try {
    await sdk.runAgent({ model: modelFor('anthropic', 'referee'), system: 'You are a test.', prompt: 'Refused key.', debateId: 'd_key', label: 'referee' });
  } catch (e) { err = e; }
  ok('a refused key is a CredentialError (the runner parks, no retry storm)', err instanceof CredentialError, String(err));
  ok('...whose message never carries the key', !String((err as Error)?.message).includes(AKEY));
  ok('...and was not retried', seen.length === 3, String(seen.length));

  failWith = `boom: something unrelated happened with ${AKEY} in it`;
  err = null;
  try {
    await sdk.runAgent({ model: modelFor('anthropic', 'lint'), system: 'You are a test.', prompt: 'Other failure.', debateId: 'd_key', label: 'lint', timeoutMs: 5_000 });
  } catch (e) { err = e; }
  ok('any other failure is redacted before it is thrown', !!err && !String((err as Error).message).includes(AKEY) && /\[redacted-key\]/.test(String((err as Error).message)), String(err));

  ok('redactClaudeSecrets strikes any sk-ant- shape', !/sk-ant-api03-OTHER/.test(sdk.redactClaudeSecrets('x sk-ant-api03-OTHERKEY123 y')));
  ok('credit exhausted reads as a credential problem, with the fix', /credit/.test(sdk.claudeCredentialRefusal('Your credit balance is too low to access the Anthropic API', true)?.message ?? ''));
  ok('a usage limit is NOT a credential problem (it pauses instead)', sdk.claudeCredentialRefusal("You've hit your session limit · resets 5pm", true) === null);
  ok('login door: "please run /login" is a credential problem', !!sdk.claudeCredentialRefusal('Invalid API key · Please run /login', false));
  ok('expired OAuth is a login credential problem', !!sdk.claudeCredentialRefusal('OAuth session expired and could not be refreshed', false));

  failWith = null;
  errorResult = `provider refused the request; key=${AKEY}`;
  err = null;
  try {
    await sdk.runAgent({ model: modelFor('claude', 'chair'), system: 'You are a test.', prompt: 'Failed result.', debateId: 'd_login', label: 'chair', timeoutMs: 5_000 });
  } catch (e) { err = e; }
  ok('an error result is not mistaken for a successful answer', !!err && /provider refused the request/.test(String(err)));
  ok('the error result is redacted', !String(err).includes(AKEY) && /\[redacted-key\]/.test(String(err)));

  CFG.anthropicApiKey = '';
  err = null;
  const spawned = seen.length;
  try {
    await sdk.runAgent({ model: modelFor('anthropic', 'chair'), system: 'You are a test.', prompt: 'No key now.', debateId: 'd_key', label: 'chair' });
  } catch (e) { err = e; }
  ok('key removed mid-session: a CredentialError before anything is spawned', err instanceof CredentialError && seen.length === spawned, `${err} ${seen.length}`);
  ok('and the debate no longer binds', !sdk.AgentAuth.bind('d_key2', 'anthropic'));
  CFG.anthropicApiKey = AKEY;
  sdk.wireClaude({ queryImpl: null });
}

// ---------- 10: test seam ----------
wireDoors(() => fake({ anthropicKey: AKEY, cmds: CLAUDE_V }));
ok('wireDoors swaps the machine', (await doorStatuses(true)).find((d) => d.id === 'anthropic')!.state === 'ready');
wireDoors(null);
ok('and restores the live one', typeof liveProbeEnv().run === 'function');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\ndoors selftest: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
