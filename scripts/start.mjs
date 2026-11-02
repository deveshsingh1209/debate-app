#!/usr/bin/env node
/**
 * `npm start`: install and build if needed, serve everything on 127.0.0.1, open the browser.
 *   npm start                 real debates, your own credentials
 *   npm start -- --no-open    do not open a browser
 *   npm start -- --check      verify prerequisites only; start nothing, change nothing
 *   npm run demo              scripted debate, no credentials (MOCK=1, separate data folder)
 * Repeat runs skip install and build. If the default port is taken it uses the next free one and says so.
 * Plain Node on purpose: it must work before anything else is set up.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const args = new Set(process.argv.slice(2));
const noOpen = args.has('--no-open');
const demo = args.has('--mock') || args.has('--demo');
const checkOnly = args.has('--check');

const die = (msg) => {
  console.error(`\n${msg}\n`);
  process.exit(1);
};

const mtime = (f) => fs.statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0;

// .env, same rule as the server: real environment variables win.
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// The built-in database the app uses (node:sqlite) needs Node 22.13+, or 23.4+ on the short-lived 23 line. Same rule as server/src/sqlite.ts.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13) || (major === 23 && minor < 4)) {
  die(
    `This app needs Node.js 22.13 or newer; you have ${process.versions.node}.\n` +
      `Install the current "LTS" version from https://nodejs.org (if you already have Node.js, the installer updates it), then run this again.\n` +
      `Step-by-step help: README.md, section "Node.js is missing or too old".`
  );
}
console.log(`Node.js ${process.versions.node}: OK`);

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const runNpm = (a) => spawnSync(npmCmd, a, { stdio: 'inherit', shell: process.platform === 'win32' });

// ---- install if needed: no node_modules, or the lock file is newer than the last install ----
const installStale =
  !fs.existsSync('node_modules') || (fs.existsSync('package-lock.json') && mtime('package-lock.json') > mtime('node_modules/.package-lock.json'));
if (installStale) {
  if (checkOnly) {
    console.log('Parts the app needs are not downloaded yet. The first normal start will do it (a few minutes, needs internet).');
  } else {
    console.log('First run: downloading the parts the app needs. This takes a few minutes and needs internet. Please wait...');
    const r = runNpm(['install', '--no-audit', '--no-fund']);
    if (r.status !== 0 || !fs.existsSync('node_modules')) {
      die('The download did not finish. Check your internet connection and run this again.\nIf it keeps failing, see README.md, section "Troubleshooting".');
    }
  }
} else {
  console.log('Downloaded parts: OK');
}

// ---- build if needed: missing output, or any source newer than it ----
const serverOut = 'server/dist/index.cjs';
const webOut = 'web/dist/index.html';

function newestMtime(p) {
  let newest = 0;
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) return 0;
  if (!st.isDirectory()) return st.mtimeMs;
  for (const name of fs.readdirSync(p)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    newest = Math.max(newest, newestMtime(path.join(p, name)));
  }
  return newest;
}

const serverStale = !fs.existsSync(serverOut) || newestMtime('server/src') > mtime(serverOut) || newestMtime('shared') > mtime(serverOut);
const webStale =
  !fs.existsSync(webOut) ||
  newestMtime('web/src') > mtime(webOut) ||
  newestMtime('shared') > mtime(webOut) ||
  newestMtime('web/index.html') > mtime(webOut);

if (serverStale || webStale) {
  if (checkOnly) {
    console.log('The app is not built yet. The first normal start will build it (about a minute).');
  } else {
    console.log('Building the app (first run, or the code changed). This takes about a minute...');
    const r = runNpm(['run', 'build']);
    if (r.status !== 0) {
      die('The build did not finish. Run this again; if it keeps failing, see README.md, section "Troubleshooting".\nA technical check is available: npm run doctor');
    }
  }
} else {
  console.log('App build: OK (up to date)');
}

// ---- environment for the server ----
const env = { ...process.env };
env.HOST = env.HOST || '127.0.0.1';
if (demo) {
  env.MOCK = '1';
  if (!process.env.DATA_DIR) env.DATA_DIR = path.resolve('data', 'demo');
}
const wantedPort = Number(env.PORT) > 0 ? Number(env.PORT) : 8794;
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(env.HOST);
if (!loopback && !env.ACCESS_PASSWORD) {
  die(`HOST=${env.HOST} would expose the app to other machines, so ACCESS_PASSWORD must be set.\nSet it in .env, or remove HOST to stay on 127.0.0.1.`);
}

const portFree = (p) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(p, loopback ? '127.0.0.1' : env.HOST);
  });

const isThisApp = async (p) => {
  try {
    const res = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok && (await res.json()).mock === (env.MOCK === '1');
  } catch {
    return false;
  }
};

function openBrowser(u) {
  const [cmd, ...a] = process.platform === 'darwin' ? ['open', u] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', u] : ['xdg-open', u];
  const o = spawn(cmd, a, { stdio: 'ignore', detached: true });
  o.on('error', () => console.log('Could not open a browser automatically. Please open the link above yourself.'));
  o.unref();
}

let port = wantedPort;
if (!(await portFree(port))) {
  if (await isThisApp(port)) {
    console.log(`\nThe app is already running.\nOpen this link: http://127.0.0.1:${port}\n`);
    if (!noOpen && !checkOnly) openBrowser(`http://127.0.0.1:${port}`);
    process.exit(0);
  }
  let found = 0;
  for (let p = wantedPort + 1; p <= wantedPort + 50 && !found; p++) if (await portFree(p)) found = p;
  if (!found) die(`Port ${wantedPort} and the 50 after it are all busy. Close some programs, or set PORT=<a free number> in a file named .env.`);
  console.log(`Port ${wantedPort} is used by another program, so this run uses port ${found} instead.`);
  port = found;
} else {
  console.log(`Port ${port}: free`);
}
env.PORT = String(port);

if (checkOnly) {
  console.log('\nCheck finished: this computer is ready. Nothing was started.');
  process.exit(0);
}

const url = `http://${env.HOST === '0.0.0.0' || env.HOST === '::' ? '127.0.0.1' : env.HOST}:${port}`;
if (demo) console.log('DEMO mode: a scripted debate, no model calls and no credentials. Demo debates are kept apart in data/demo.');

const child = spawn(process.execPath, [serverOut], { stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(signal ? 0 : (code ?? 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));

// ---- open the browser once the server answers ----
async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

if (await waitUp()) {
  console.log('\n=====================================================');
  console.log(`  Open this link: ${url}`);
  console.log('=====================================================');
  console.log(
    (noOpen ? '' : 'Your browser should open by itself. ') + 'Leave this window open while you use the app. Close it (or press Ctrl+C) to stop.\n'
  );
  if (!noOpen) openBrowser(url);
} else {
  console.error('The app did not answer within 30 seconds. Run `npm run doctor` for a checklist.');
}
