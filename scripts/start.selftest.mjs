// Self-test for scripts/start.mjs: --check starts nothing, a busy port is reported with its replacement
// (only probed, never served on), and a real start serves and prints the link.
// Uses MOCK=1 (no model calls). Port from START_TEST_PORT (default 8844).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = Number(process.env.START_TEST_PORT) || 8844;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-start-test-'));
const env = { ...process.env, MOCK: '1', DATA_DIR: dataDir, PORT: String(base) };
let passed = 0;
const ok = (name) => console.log(`  ok  ${name}`);

// 1. --check on a free port: exits 0, says nothing was started
{
  const r = spawnSync(process.execPath, ['scripts/start.mjs', '--check'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Nothing was started/);
  assert.match(r.stdout, new RegExp(`Port ${base}: free`));
  assert.doesNotMatch(r.stdout + r.stderr, /\bat .*\.(m?js|ts):\d+/, 'no stack traces');
  ok('--check passes and starts nothing');
  passed++;
}

// 2. busy port: --check reports the next port
const blocker = net.createServer();
await new Promise((res) => blocker.listen(base, '127.0.0.1', res));
{
  const r = spawnSync(process.execPath, ['scripts/start.mjs', '--check'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`Port ${base} is used by another program, so this run uses port ${base + 1}`));
  ok('--check names the replacement port when the default is busy');
  passed++;
}

await new Promise((res) => blocker.close(res));

// 3. real start: serves on the wanted port, prints the link, answers /api/health
{
  const child = spawn(process.execPath, ['scripts/start.mjs', '--no-open'], { cwd: root, env });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  let healthy = false;
  for (let i = 0; i < 100 && !healthy; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      healthy = (await fetch(`http://127.0.0.1:${base}/api/health`)).ok;
    } catch {}
  }
  assert.ok(healthy, `server did not answer on ${base}\n${out}`);
  await new Promise((r) => setTimeout(r, 300));
  assert.match(out, new RegExp(`Open this link: http://127.0.0.1:${base}`));
  const otherMode = spawnSync(process.execPath, ['scripts/start.mjs', '--check'], {
    cwd: root, env: { ...env, MOCK: '0' }, encoding: 'utf8',
  });
  assert.equal(otherMode.status, 0, otherMode.stdout + otherMode.stderr);
  assert.match(otherMode.stdout, new RegExp(`run uses port ${base + 1}`), 'a real launch must not reuse a demo server');
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await exited;
  ok(`starts on port ${base}, answers, and prints "Open this link"`);
  passed++;
}

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`start selftest: ${passed} passed`);
