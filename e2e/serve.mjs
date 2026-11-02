/**
 * The server the browser tests drive: the built app with MOCK=1 (the real
 * engine, scripted models), in a sandbox that looks like a fresh computer.
 *
 *   .scratch/e2e/          the app folder the server sees (cwd)
 *     web -> ../../web     so web/dist is served as in `npm start`
 *     .env                 empty; tests write keys into it and press Re-check
 *     data/                debates of this run only
 *     home/, codex/        no Claude or Codex login
 *     bin/claude, bin/codex  stubs that answer status questions only
 *     state/               files the tests touch to sign the stubs in
 *
 * No model is ever called (MOCK=1), the stubs refuse anything but a status
 * check, and every key in the real environment is dropped, so nothing here
 * can spend quota. Runs in this process so Playwright's stop ends it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
export const SANDBOX = path.join(repo, '.scratch', 'e2e');

fs.rmSync(SANDBOX, { recursive: true, force: true });
for (const d of ['data', 'home', 'codex', 'bin', 'state']) fs.mkdirSync(path.join(SANDBOX, d), { recursive: true });
fs.symlinkSync(path.join(repo, 'web'), path.join(SANDBOX, 'web'), 'dir');
fs.writeFileSync(path.join(SANDBOX, '.env'), '');

const stub = (name, body) => {
  const f = path.join(SANDBOX, 'bin', name);
  fs.writeFileSync(f, `#!/bin/sh\nS="$(dirname "$0")/../state"\n${body}\necho "e2e stub: refusing $*" >&2\nexit 2\n`);
  fs.chmodSync(f, 0o755);
};
stub('claude', `case "$*" in
  *--version*) echo "2.9.0 (Claude Code)"; exit 0;;
  "--setting-sources= auth status") if [ -f "$S/claude-signed-in" ]; then echo '{"loggedIn": true}'; exit 0; fi; echo '{"loggedIn": false}'; exit 1;;
esac`);
stub('codex', `case "$*" in
  "login status") echo "Not logged in"; exit 1;;
esac`);

// Nothing from the real machine's AI setup may reach the server.
for (const k of Object.keys(process.env)) {
  if (/^(OPENAI|ANTHROPIC|CLAUDE|CODEX|TELEGRAM|ACCESS_PASSWORD|AUTO_ACCESS|BUDGET_|FOUNDER_NAME|AGENT_|MOCK|DATA_DIR|HOST|ALLOWED_HOSTS|PUBLIC_URL)/.test(k)) delete process.env[k];
}
Object.assign(process.env, {
  PORT: process.env.E2E_PORT ?? '8871',
  HOST: '127.0.0.1',
  MOCK: '1',
  MOCK_REQUIRE_DOOR: '1',
  MOCK_SPEED: process.env.E2E_MOCK_SPEED ?? '6',
  DATA_DIR: path.join(SANDBOX, 'data'),
  HOME: path.join(SANDBOX, 'home'),
  CODEX_HOME: path.join(SANDBOX, 'codex'),
  AGENT_CLI_PATH: path.join(SANDBOX, 'bin', 'claude'),
  PATH: [path.join(SANDBOX, 'bin'), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
});
process.chdir(SANDBOX);
await import(pathToFileURL(path.join(repo, 'server', 'dist', 'index.cjs')).href);
