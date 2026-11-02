/**
 * `npm run doctor` — checks this machine is ready, without any model call.
 *
 * The logic is a pure function of an injected environment (`DoctorEnv`) so the
 * selftest can run it against fake machines. The real environment lives in
 * `realEnv()` at the bottom. Nothing here prints or reads a secret: the API
 * keys and Codex tokens are only tested for presence and shape.
 *
 * The four doors (Claude sign-in, Claude API key, Codex sign-in, OpenAI API
 * key) are checked by the same probe the app's Connect screen uses
 * (server/src/doors/probe.ts), so the two can never disagree.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probeDoors, type CmdResult } from '../server/src/doors/probe.ts';
import { MIN_NODE, nodeSupported, openDb } from '../server/src/sqlite.ts';

export type { CmdResult };
export type Level = 'PASS' | 'WARN' | 'FAIL';
export interface Check {
  name: string;
  level: Level;
  detail: string;
  /** The exact thing to do. Present on WARN and FAIL. */
  fix?: string;
}

export interface DoctorEnv {
  nodeVersion: string;
  env: Record<string, string | undefined>;
  mock: boolean;
  port: number;
  dataDir: string;
  /** Run a program with a short timeout. Must never make a model call. */
  run(cmd: string, args: string[]): CmdResult;
  portFree(port: number): Promise<boolean>;
  /** Throws with a message when the directory cannot be created or written. */
  checkWritable(dir: string): void;
  /** Throws when SQLite cannot open and use an in-memory database. */
  checkSqlite(): void;
  /** Contents of $CODEX_HOME/auth.json, or null when absent. */
  readCodexAuth(file: string): string | null;
  homedir: string;
  /** The .env file the app reads keys from. Default: ./.env */
  envFile?: string;
  platform?: string;
}

/** The check names of the four doors, in the order the app offers them. */
export const DOOR_CHECKS = ['Claude: sign in', 'Claude: API key', 'ChatGPT: Codex sign-in', 'OpenAI: API key'];

export function codexAuthPath(d: Pick<DoctorEnv, 'env' | 'homedir'>): string {
  return path.join(d.env.CODEX_HOME || path.join(d.homedir, '.codex'), 'auth.json');
}

export async function runChecks(d: DoctorEnv): Promise<Check[]> {
  const out: Check[] = [];
  const add = (c: Check) => out.push(c);

  // Node
  const major = Number(d.nodeVersion.replace(/^v/, '').split('.')[0]);
  if (!nodeSupported(d.nodeVersion)) {
    add({
      name: 'Node.js',
      level: 'FAIL',
      detail: `Node ${d.nodeVersion} is too old; this app needs ${MIN_NODE} or newer (its built-in database arrived in that version).`,
      fix: `Install the current "LTS" version from https://nodejs.org (click the big green LTS button and run the installer; or \`nvm install --lts\`), close this window, then run the start file or \`npm start\` again.`,
    });
  } else if (major > 24) {
    add({
      name: 'Node.js',
      level: 'PASS',
      detail: `Node ${d.nodeVersion}. (A JavaScript-based Claude CLI has aborted on Node 25+; the app then uses Node 20-24 for it if installed. If Claude turns crash, install Node 22 LTS.)`,
    });
  } else {
    add({ name: 'Node.js', level: 'PASS', detail: `Node ${d.nodeVersion}.` });
  }

  // The four doors. Each is optional on its own; one is enough to run real debates.
  const doors = await probeDoors({
    env: d.env,
    anthropicKey: d.env.ANTHROPIC_API_KEY ?? '',
    openaiKey: d.env.OPENAI_API_KEY ?? '',
    claudeCli: { cmd: d.env.AGENT_CLI_PATH || 'claude', args: [] },
    codexCli: { cmd: 'codex', args: [] },
    codexAuthFile: codexAuthPath(d),
    readFile: (f) => d.readCodexAuth(f),
    run: (cmd, args) => d.run(cmd, args),
    envFile: d.envFile ?? path.resolve(process.cwd(), '.env'),
    platform: d.platform ?? process.platform,
  });
  for (const door of doors) {
    if (door.state === 'ready') {
      add({ name: door.title, level: 'PASS', detail: `Ready. ${door.summary}${door.note ? ` (${door.note})` : ''}` });
    } else {
      add({
        name: door.title,
        level: 'WARN',
        detail: `${door.state === 'problem' ? 'Problem' : 'Needs setup'}. ${door.summary} Only needed if you want this way of connecting.`,
        // The probe speaks to the Connect screen; in a terminal, re-running the doctor is the Re-check.
        fix: (door.fix ?? 'See docs/CONNECT-YOUR-AI.md.').replace(/press Re-check/g, 'run `npm run doctor` again (or press Re-check in the app)'),
      });
    }
  }

  // At least one way to run a real debate.
  const ready = doors.filter((x) => x.state === 'ready');
  if (!ready.length) {
    add({
      name: 'A provider to run debates',
      level: 'WARN',
      detail: 'None of the four ways to connect an AI is ready, so real debates cannot start.',
      fix: 'Set up any one of the four above (docs/CONNECT-YOUR-AI.md walks through each, or open the app and use "Connect your AI"). Meanwhile `npm run demo` plays a full scripted debate with no credentials.',
    });
  } else {
    add({ name: 'A provider to run debates', level: 'PASS', detail: `Ready: ${ready.map((x) => x.title).join(', ')}.` });
  }

  // Port
  if (await d.portFree(d.port)) {
    add({ name: `Port ${d.port}`, level: 'PASS', detail: 'Free on 127.0.0.1.' });
  } else {
    add({
      name: `Port ${d.port}`,
      level: 'FAIL',
      detail: `Something is already listening on port ${d.port}.`,
      fix: `Stop the other program, or choose another port: \`PORT=${d.port + 1} npm start\` (or set PORT in .env). If it is an earlier copy of this app, it is already running at http://127.0.0.1:${d.port}.`,
    });
  }

  // Data dir
  try {
    d.checkWritable(d.dataDir);
    add({ name: 'Data folder', level: 'PASS', detail: `${d.dataDir} is writable.` });
  } catch (e) {
    add({
      name: 'Data folder',
      level: 'FAIL',
      detail: `Cannot write to ${d.dataDir}: ${errText(e)}`,
      fix: `Make the folder writable (\`chmod u+rwx "${d.dataDir}"\`) or point DATA_DIR in .env at a folder you own.`,
    });
  }

  // SQLite
  try {
    d.checkSqlite();
    add({ name: 'SQLite', level: 'PASS', detail: "Node's built-in SQLite works." });
  } catch (e) {
    add({
      name: 'SQLite',
      level: 'FAIL',
      detail: `Node's built-in SQLite would not open a database: ${errText(e)}`,
      fix: `Install the current "LTS" version of Node.js from https://nodejs.org (${MIN_NODE} or newer), then start the app again. Nothing needs compiling.`,
    });
  }

  return out;
}

function errText(e: unknown) {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200);
}

export function summarize(checks: Check[]): { fail: number; warn: number; pass: number; canRunDemo: boolean; canRunReal: boolean } {
  const n = (l: Level) => checks.filter((c) => c.level === l).length;
  const provider = checks.find((c) => c.name === 'A provider to run debates');
  const hardFail = checks.some((c) => c.level === 'FAIL');
  return { fail: n('FAIL'), warn: n('WARN'), pass: n('PASS'), canRunDemo: !hardFail, canRunReal: !hardFail && provider?.level === 'PASS' };
}

export function render(checks: Check[], color = false): string {
  const paint = (l: Level, s: string) => (color ? `\x1b[${l === 'PASS' ? 32 : l === 'WARN' ? 33 : 31}m${s}\x1b[0m` : s);
  const lines: string[] = ['Debate doctor', ''];
  for (const c of checks) {
    lines.push(`${paint(c.level, c.level.padEnd(4))}  ${c.name}: ${c.detail}`);
    if (c.fix) lines.push(`      Fix: ${c.fix}`);
  }
  const s = summarize(checks);
  lines.push('');
  lines.push(`${s.pass} passed, ${s.warn} warnings, ${s.fail} failed.`);
  if (s.fail) lines.push('Fix the FAIL items above; the app will not run properly until you do.');
  else if (s.canRunReal) lines.push('Ready. Run `npm start`.');
  else lines.push('The app runs, but no way of connecting an AI is ready for real debates. Try `npm run demo` now, or set one up above.');
  return lines.join('\n');
}

// ---------- the real machine ----------

export function realEnv(): DoctorEnv {
  const cwd = process.cwd();
  const env = process.env;
  return {
    nodeVersion: process.versions.node,
    env,
    mock: env.MOCK === '1',
    port: Number(env.PORT) > 0 ? Number(env.PORT) : 8794,
    dataDir: env.DATA_DIR || path.resolve(cwd, 'data'),
    homedir: os.homedir(),
    envFile: path.resolve(cwd, '.env'),
    platform: process.platform,
    run(cmd, args) {
      // Never the API keys: a CLI asked for its status has no use for them.
      const { ANTHROPIC_API_KEY: _a, OPENAI_API_KEY: _o, ...childEnv } = env;
      const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
      if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') return { found: true, code: null, out: '', timedOut: true };
      if (r.error) return { found: false, code: null, out: '' };
      return { found: true, code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    },
    portFree(port) {
      return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => srv.close(() => resolve(true)));
        srv.listen(port, '127.0.0.1');
      });
    },
    checkWritable(dir) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const probe = path.join(dir, `.doctor-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe);
    },
    checkSqlite() {
      const db = openDb(':memory:');
      db.exec('create table t(x); insert into t values (1);');
      const row = db.prepare('select x from t').get() as { x: number };
      db.close();
      if (row.x !== 1) throw new Error('unexpected query result');
    },
    readCodexAuth(file) {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/** Minimal .env read so the doctor sees the same settings the server will. Real env wins. */
function loadDotEnv() {
  const p = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotEnv();
  const checks = await runChecks(realEnv());
  console.log(render(checks, process.stdout.isTTY));
  process.exit(summarize(checks).fail ? 1 : 0);
}
