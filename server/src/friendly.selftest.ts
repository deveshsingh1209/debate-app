import assert from 'node:assert/strict';
import { friendlyError } from './friendly.ts';

const cases: [unknown, RegExp][] = [
  [Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }), /Claude Code program was not found/],
  [new Error('Invalid API key · Please run /login'), /Claude is not signed in/],
  [new Error('Claude Code process exited with code 1'), /stopped unexpectedly/],
  [new TypeError('fetch failed'), /Could not reach/],
  [Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }), /disk is full/],
  [new Error('SqliteError: attempt to write a readonly database'), /data folder/],
  [new Error('Cannot read properties of undefined (reading "x")\n    at foo (/Users/me/secret/path.ts:1:2)'), /Something went wrong/],
  ['plain string failure', /Something went wrong/],
];
for (const [err, want] of cases) {
  const msg = friendlyError(err);
  assert.match(msg, want, String(err));
  assert.ok(!/\n\s+at |\.ts:\d|\/Users\//.test(msg), 'no stack or path leaks');
  assert.ok(!msg.includes('Cannot read properties'), 'raw error text is not echoed');
}
console.log('friendly selftest: ok');
