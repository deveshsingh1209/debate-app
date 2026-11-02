/**
 * Doctor selftest: runs the check logic against fake machines. No network, no
 * model call, no real CLI, no files outside a temp dir.
 *   npx tsx scripts/doctor.selftest.ts
 */
import assert from 'node:assert/strict';
import { runChecks, render, summarize, codexAuthPath, DOOR_CHECKS, type DoctorEnv, type CmdResult } from './doctor.ts';

const KEY = 'sk-test-SECRET-1234567890';
const AKEY = 'sk-ant-api03-SECRET-abcdefghijklmnop';
const goodCodex = JSON.stringify({ tokens: { access_token: 'a.b.c', refresh_token: 'r', account_id: 'x' } });
const claudeIn: Record<string, CmdResult> = {
  'claude --version': { found: true, code: 0, out: '2.5.0 (Claude Code)\n' },
  'claude --setting-sources= auth status': { found: true, code: 0, out: '{"loggedIn": true, "email": "someone@example.com"}' },
};

function fake(over: Partial<DoctorEnv> & { cmds?: Record<string, CmdResult> } = {}): DoctorEnv {
  const cmds = over.cmds ?? {};
  return {
    nodeVersion: '22.11.0',
    env: {},
    mock: false,
    port: 8794,
    dataDir: '/tmp/fake-data',
    homedir: '/home/u',
    envFile: '/home/u/debate/.env',
    platform: 'darwin',
    run: (cmd, args) => cmds[`${cmd} ${args.join(' ')}`] ?? { found: false, code: null, out: '' },
    portFree: async () => true,
    checkWritable: () => {},
    checkSqlite: () => {},
    readCodexAuth: () => null,
    ...over,
  };
}

const by = (cs: Awaited<ReturnType<typeof runChecks>>, name: string) => {
  const c = cs.find((x) => x.name === name);
  assert.ok(c, `check "${name}" missing`);
  return c;
};

// 1. A bare machine: runs, demo works, no real provider; all four doors reported with a fix.
{
  const cs = await runChecks(fake());
  assert.equal(by(cs, 'Node.js').level, 'PASS');
  for (const n of DOOR_CHECKS) {
    assert.equal(by(cs, n).level, 'WARN', n);
    assert.ok(by(cs, n).fix, `${n} has a fix`);
  }
  assert.match(by(cs, 'Claude: sign in').fix!, /npm install -g @anthropic-ai\/claude-code/);
  assert.match(by(cs, 'ChatGPT: Codex sign-in').fix!, /npm install -g @openai\/codex/);
  assert.match(by(cs, 'OpenAI: API key').fix!, /OPENAI_API_KEY/);
  assert.match(by(cs, 'Claude: API key').fix!, /ANTHROPIC_API_KEY/);
  assert.equal(by(cs, 'A provider to run debates').level, 'WARN');
  assert.match(by(cs, 'A provider to run debates').fix!, /npm run demo/);
  const s = summarize(cs);
  assert.equal(s.fail, 0);
  assert.ok(s.canRunDemo && !s.canRunReal);
  assert.match(render(cs), /npm run demo/);
}

// 2. Old Node and new Node.
{
  const old = await runChecks(fake({ nodeVersion: '20.1.0' }));
  assert.equal(by(old, 'Node.js').level, 'FAIL');
  assert.match(by(old, 'Node.js').fix!, /22/);
  assert.ok(!summarize(old).canRunDemo);
  const newer = await runChecks(fake({ nodeVersion: '26.12.1' }));
  assert.equal(by(newer, 'Node.js').level, 'PASS');
}

// 3. Claude installed and signed in. The account e-mail in the CLI's output never reaches the report.
{
  const cs = await runChecks(fake({ cmds: claudeIn }));
  assert.equal(by(cs, 'Claude: sign in').level, 'PASS');
  assert.ok(summarize(cs).canRunReal);
  assert.ok(!render(cs).includes('someone@example.com'));
}

// 4. Claude installed, signed out (both exit styles).
for (const st of [
  { found: true, code: 1, out: '{"loggedIn": false}' },
  { found: true, code: 0, out: 'Not logged in' },
]) {
  const cs = await runChecks(fake({ cmds: { 'claude --version': { found: true, code: 0, out: '2.5.0' }, 'claude --setting-sources= auth status': st } }));
  assert.equal(by(cs, 'Claude: sign in').level, 'WARN');
  assert.match(by(cs, 'Claude: sign in').fix!, /run `claude`/);
  assert.ok(!summarize(cs).canRunReal);
}

// 5. Old CLI without an auth status command: honest "cannot tell", not a false pass.
{
  const cs = await runChecks(fake({ cmds: { 'claude --version': { found: true, code: 0, out: '1.0.0' }, 'claude --setting-sources= auth status': { found: true, code: 1, out: 'error: unknown command' } } }));
  assert.equal(by(cs, 'Claude: sign in').level, 'WARN');
  assert.match(by(cs, 'Claude: sign in').detail, /cannot say/);
  assert.match(by(cs, 'Claude: sign in').fix!, /Update/);
}

// 6. AGENT_CLI_PATH is honoured.
{
  const cs = await runChecks(
    fake({ env: { AGENT_CLI_PATH: '/opt/c/claude' }, cmds: { '/opt/c/claude --version': { found: true, code: 0, out: '2.5.0' }, '/opt/c/claude --setting-sources= auth status': { found: true, code: 0, out: 'ok' } } })
  );
  assert.equal(by(cs, 'Claude: sign in').level, 'PASS');
}

// 7. OpenAI key: presence and shape only, and the value never appears in any output.
{
  const cs = await runChecks(fake({ env: { OPENAI_API_KEY: KEY } }));
  assert.equal(by(cs, 'OpenAI: API key').level, 'PASS');
  assert.ok(summarize(cs).canRunReal);
  assert.ok(!JSON.stringify(cs).includes(KEY) && !render(cs).includes(KEY));
  const blank = await runChecks(fake({ env: { OPENAI_API_KEY: '   ' } }));
  assert.equal(by(blank, 'OpenAI: API key').level, 'WARN');
  const swapped = await runChecks(fake({ env: { OPENAI_API_KEY: AKEY } }));
  assert.equal(by(swapped, 'OpenAI: API key').level, 'WARN');
  assert.match(by(swapped, 'OpenAI: API key').fix!, /ANTHROPIC_API_KEY/);
  assert.ok(!render(swapped).includes(AKEY));
}

// 8. Claude API key: needs the key and an installed Claude Code (no sign-in); never echoed.
{
  const noCli = await runChecks(fake({ env: { ANTHROPIC_API_KEY: AKEY } }));
  assert.equal(by(noCli, 'Claude: API key').level, 'WARN');
  assert.match(by(noCli, 'Claude: API key').fix!, /npm install -g @anthropic-ai\/claude-code/);
  const ok = await runChecks(fake({ env: { ANTHROPIC_API_KEY: AKEY }, cmds: { 'claude --version': { found: true, code: 0, out: '2.5.0' } } }));
  assert.equal(by(ok, 'Claude: API key').level, 'PASS');
  assert.equal(by(ok, 'Claude: sign in').level, 'WARN', 'the key does not make the sign-in door ready');
  assert.ok(summarize(ok).canRunReal);
  assert.ok(!JSON.stringify(ok).includes(AKEY) && !render(ok).includes(AKEY));
  const oat = await runChecks(fake({ env: { ANTHROPIC_API_KEY: 'sk-ant-oat01-SECRETSECRET' }, cmds: claudeIn }));
  assert.equal(by(oat, 'Claude: API key').level, 'WARN');
  assert.match(by(oat, 'Claude: API key').detail, /sign-in token/);
  assert.ok(!render(oat).includes('SECRETSECRET'));
}

// 9. Codex: good login, API-key-mode file, junk, honours CODEX_HOME.
{
  assert.equal(codexAuthPath({ env: {}, homedir: '/home/u' }), '/home/u/.codex/auth.json');
  assert.equal(codexAuthPath({ env: { CODEX_HOME: '/x' }, homedir: '/home/u' }), '/x/auth.json');
  let asked = '';
  const ok = await runChecks(fake({ env: { CODEX_HOME: '/x' }, readCodexAuth: (f) => ((asked = f), goodCodex) }));
  assert.equal(asked, '/x/auth.json');
  assert.equal(by(ok, 'ChatGPT: Codex sign-in').level, 'PASS');
  for (const raw of ['{"OPENAI_API_KEY":"sk-x"}', 'not json', '{"tokens":{}}']) {
    const cs = await runChecks(fake({ readCodexAuth: () => raw }));
    assert.equal(by(cs, 'ChatGPT: Codex sign-in').level, 'WARN');
    assert.ok(!render(cs).includes('sk-x'));
  }
}

// 10. Port busy, data dir unwritable, SQLite broken: each FAIL with a fix.
{
  const cs = await runChecks(
    fake({
      port: 9999,
      portFree: async (p) => p !== 9999,
      checkWritable: () => {
        throw new Error('EACCES: permission denied, mkdir');
      },
      checkSqlite: () => {
        throw new Error('Could not locate the bindings file');
      },
    })
  );
  assert.equal(by(cs, 'Port 9999').level, 'FAIL');
  assert.match(by(cs, 'Port 9999').fix!, /PORT=10000/);
  assert.equal(by(cs, 'Data folder').level, 'FAIL');
  assert.match(by(cs, 'Data folder').fix!, /DATA_DIR/);
  assert.equal(by(cs, 'SQLite').level, 'FAIL');
  assert.match(by(cs, 'SQLite').fix!, /npm rebuild better-sqlite3/);
  const s = summarize(cs);
  assert.equal(s.fail, 3);
  assert.ok(!s.canRunDemo);
  const text = render(cs);
  assert.match(text, /FAIL/);
  assert.match(text, /3 failed/);
  assert.ok(!/\n\s+at /.test(text), 'no stack traces');
}

// 11. Every WARN and FAIL carries a fix; every PASS does not need one.
{
  const cs = await runChecks(fake({ nodeVersion: '18.0.0', portFree: async () => false }));
  for (const c of cs) if (c.level !== 'PASS') assert.ok(c.fix && c.fix.length > 10, `${c.name} has no fix`);
}

console.log('doctor selftest: ok');
