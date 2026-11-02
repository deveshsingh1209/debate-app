#!/usr/bin/env node
/**
 * `npm run qa`, one suite at a time, with the POSIX-only suites skipped on
 * Windows. CI uses it on the Windows runners; on macOS and Linux it runs
 * exactly what `npm run qa` runs.
 *
 * The suite list is read from the package.json files, so it never drifts
 * from `npm run qa`. A suite is POSIX-only when it needs a POSIX shell or
 * POSIX file modes; each one says why below.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const win = process.platform === 'win32';

const POSIX_ONLY = {
  'src/doors/doors.selftest.ts': 'fakes the Claude and Codex CLIs as #!/bin/sh scripts',
  'src/agents/codex.selftest.ts': 'checks that a copied login is written 0600, which Windows file modes cannot express',
};

const chain = (dir) => JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8')).scripts.qa.split('&&').map((s) => s.trim());
const steps = [
  ...chain('server').map((cmd) => ({ cwd: 'server', cmd })),
  ...chain('web').map((cmd) => ({ cwd: 'web', cmd })),
  ...chain('.').filter((c) => !/^npm run qa -w/.test(c)).map((cmd) => ({ cwd: '.', cmd })),
];

let failed = 0;
for (const { cwd, cmd } of steps) {
  const skip = win && Object.entries(POSIX_ONLY).find(([file]) => cmd.includes(file));
  if (skip) { console.log(`\n-- skipped on Windows: ${cmd} (${skip[1]})`); continue; }
  console.log(`\n-- ${cwd}: ${cmd}`);
  const r = spawnSync(cmd, { cwd: path.join(root, cwd), stdio: 'inherit', shell: true, env: { ...process.env, PATH: `${path.join(root, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH}` } });
  if (r.status !== 0) { failed++; console.log(`!! failed (exit ${r.status}): ${cmd}`); }
}
console.log(failed ? `\n${failed} suite(s) failed.` : '\nAll suites passed.');
process.exit(failed ? 1 : 0);
