/**
 * The web side of the four doors, without a DOM: which door New Debate starts
 * on, and how a fix's `commands` are split out. Run by `npm run qa`.
 *
 *   npx tsx web/src/lib/door-view.selftest.ts
 */
import type { DoorState, DoorStatus } from '../../../shared/types';
import type { Provider } from '../../../shared/models';
import { anyReady, defaultDoor, splitTicks, STATE_CHIP, STATE_LABEL } from './door-view.ts';

let fails = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (!cond) fails++;
  console.log(`${cond ? '  ok  ' : '  FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};

const door = (id: Provider, state: DoorState): DoorStatus => ({
  id, state, title: id, blurb: '', summary: '', fix: state === 'ready' ? null : 'fix', steps: [], note: null, checkedAt: 0,
});
const set = (s: Partial<Record<Provider, DoorState>>) =>
  (['claude', 'anthropic', 'codex', 'openai'] as Provider[]).map((p) => door(p, s[p] ?? 'needs_setup'));

ok('nothing known yet: Claude', defaultDoor(null) === 'claude');
ok('nothing known yet, a door asked for: that door', defaultDoor(null, 'openai') === 'openai');
ok('first ready door, in the app\'s order', defaultDoor(set({ codex: 'ready', openai: 'ready' })) === 'codex');
ok('the Claude API key door counts', defaultDoor(set({ anthropic: 'ready', openai: 'ready' })) === 'anthropic');
ok('a ready door asked for wins', defaultDoor(set({ claude: 'ready', openai: 'ready' }), 'openai') === 'openai');
ok('a door asked for that is not ready loses to a ready one', defaultDoor(set({ claude: 'ready' }), 'codex') === 'claude');
ok('none ready, one asked for: stays on it (so its fix shows)', defaultDoor(set({}), 'codex') === 'codex');
ok('none ready: Claude', defaultDoor(set({ claude: 'problem' })) === 'claude');
ok('junk ?door= is ignored', defaultDoor(set({ openai: 'ready' }), '<script>') === 'openai');
ok('anyReady', anyReady(set({ openai: 'ready' })) && !anyReady(set({})) && !anyReady(null));
ok('every state has a label and a chip', (['ready', 'needs_setup', 'problem'] as DoorState[]).every((s) => STATE_LABEL[s] && STATE_CHIP[s]));

const parts = splitTicks('Run `codex login` and choose "Sign in", then `claude`.');
ok('splitTicks finds the two commands', parts.filter((p) => p.code).map((p) => p.text).join('|') === 'codex login|claude', JSON.stringify(parts));
ok('splitTicks keeps the words', parts.map((p) => p.text).join('') === 'Run codex login and choose "Sign in", then claude.');
ok('splitTicks with no ticks', splitTicks('plain').length === 1 && !splitTicks('plain')[0].code);

console.log(fails ? `door-view selftest: ${fails} failed` : 'door-view selftest: ok');
// Thrown rather than process.exit: this file typechecks with the browser's types, not node's.
if (fails) throw new Error(`${fails} door-view self-test(s) failed`);
