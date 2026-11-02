/**
 * The live floor (floor.ts) against a fake host: no model, no database.
 * Deterministic replay, the projection rule, a restart mid-performance, the
 * chair on a trigger, the desk handing the floor back, and the wind-down's
 * relevance rule.
 *
 *   npx tsx src/engine/floor.selftest.ts
 */
import { newFloor, type DirectorSeat, type Reaction } from './director.ts';
import { plannedEvents, resumeText, runFloor, tailStart, windDown, type FloorHost, type GenerateRequest, type GeneratedTurn, type PerformPlan } from './floor.ts';
import type { FloorState } from '../../../shared/types.ts';

let fails = 0;
let passes = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) passes++;
  else fails++;
  console.log(`${cond ? '  ok  ' : '  FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};

const SEATS: DirectorSeat[] = [
  { id: 'ana', temperament: { heatGain: 0.3, heatDecay: 0.1, interruptThreshold: 0.6, dominance: 0.5 }, typicalWords: 60 },
  { id: 'bo', temperament: { heatGain: 0.3, heatDecay: 0.1, interruptThreshold: 0.6, dominance: 0.7 }, typicalWords: 140 },
  { id: 'cy', temperament: { heatGain: 0.2, heatDecay: 0.2, interruptThreshold: 0.9, dominance: 0.3 }, typicalWords: 80 },
];

interface Log {
  generated: GenerateRequest[];
  performed: { turn: GeneratedTurn; plan: PerformPlan; events: any[] }[];
  chair: string[];
  pauses: string[];
}

function fakeHost(opts: {
  seats?: DirectorSeat[];
  reactions?: (turn: GeneratedTurn) => Reaction[];
  desk?: (turn: GeneratedTurn) => string | null;
  ask?: (n: number, speaker: string) => { to: string; question: string } | undefined;
  compute?: (n: number, speaker: string) => string | undefined;
  dynamics?: string[];
} = {}): { host: FloorHost; log: Log } {
  const log: Log = { generated: [], performed: [], chair: [], pauses: [] };
  let n = 0;
  const host: FloorHost = {
    seats: () => opts.seats ?? SEATS,
    interruptCap: () => 4,
    asidesAllowed: () => false,
    async generate(req) {
      log.generated.push(req);
      n++;
      const ask = opts.ask?.(n, req.speaker);
      return {
        id: `t${n}`, speaker: req.speaker, shape: req.shape,
        text: `${req.speaker} turn ${n} opens here. The second sentence of turn ${n} runs on a while. UNSAID-${n} is the third sentence.`,
        trailer: { ...(ask ? { ask } : {}), ...(opts.compute?.(n, req.speaker) ? { compute: opts.compute(n, req.speaker) } : {}) },
        ...(ask ? { to: [ask.to] } : {}),
      };
    },
    async react(turn) { return { reactions: opts.reactions?.(turn) ?? [] }; },
    async perform(turn, plan) {
      const events = plannedEvents(turn, plan);
      log.performed.push({ turn, plan, events });
      return { concession: false, words: events.reduce((a, e) => a + e.text.split(/\s+/).length, 0) };
    },
    async pause(ms, reason) { log.pauses.push(reason); },
    async chair(reason) { log.chair.push(reason); return true; },
    async afterTurn(turn) { return opts.desk?.(turn) ?? null; },
    dynamics: () => opts.dynamics?.splice(0) ?? [],
    landed: () => null,
    save() {},
    stopped: () => false,
    endedByUser: () => false,
    throwIfLimited() {},
    nameOf: (id) => id.toUpperCase(),
  };
  return { host, log };
}

const run = (turns: number) => ({ motionId: 'm1', checkpoint: 1, boundary: 0, pressure: 'PRESSURE-LINE', nudge: null, turns });
/** Bo's set pieces draw Ana's cut-in at sentence 1; everyone else draws a short "No." from Cy. */
const script = (turn: GeneratedTurn): Reaction[] => turn.speaker === 'bo'
  ? [{ listener: 'ana', intensity: 3, atSentence: 1, cutIn: 'On what base, Bo?', wantsFloor: true }]
  : [{ listener: 'cy', intensity: 2, atSentence: 0, backchannel: 'No.', wantsFloor: false }];

console.log('[replay] the same seed and the same reactions give the same room');
{
  const shape = async () => {
    const { host, log } = fakeHost({ reactions: script });
    const floor = newFloor('m1', SEATS, 'same-seed');
    await runFloor(host, floor, run(12));
    return log.performed.map((p) => `${p.turn.speaker}:${p.turn.shape}:${p.plan.cut ? `cut-by-${p.plan.cut.by}-${p.plan.cut.fight}@${p.plan.cut.atChar}` : ''}:${p.plan.trailing ? `trail-${p.plan.trailing.by}${p.plan.trailing.overlap ? '-over' : ''}` : ''}`).join(' | ');
  };
  const a = await shape();
  const b = await shape();
  ok('two runs produce the identical sequence of speakers, shapes, cuts and reactions', a === b && a.length > 0, `${a}\n  vs\n  ${b}`);
  const { host, log } = fakeHost({ reactions: script });
  await runFloor(host, newFloor('m1', SEATS, 'another-seed'), run(12));
  ok('the referee pressure rides on the first turn only', log.generated[0].pressure === 'PRESSURE-LINE' && log.generated.slice(1).every((g) => g.pressure === null));
  ok('twelve spoken turns ran, every one performed', log.performed.length === 12, String(log.performed.length));
  if (process.env.DEBUG_FLOOR) for (const [i, p] of log.performed.entries()) console.log(`    ${i} ${p.turn.speaker} ${p.turn.shape} cut=${p.plan.cut ? `${p.plan.cut.by}/${p.plan.cut.fight}` : '-'} trail=${p.plan.trailing?.by ?? '-'} dir=${log.generated[i]?.direction}`);
  // The same person again only when the room put them back up: a question in a reaction to them, a cut they won back, the desk or the chair.
  ok('nobody took two floor turns in a row unless the room put them up', log.performed.every((p, i) => {
    if (i === 0 || p.turn.speaker !== log.performed[i - 1].turn.speaker) return true;
    const prev = log.performed[i - 1].plan;
    return !!prev.cut || /\?$/.test(prev.trailing?.text ?? '') || /desk|chair|research/.test(log.generated[i]?.direction ?? '');
  }), log.performed.map((p) => p.turn.speaker).join(','));
  ok('no listener reacts to the same speaker two turns running', log.performed.every((p, i) => i === 0 || !p.plan.trailing || p.plan.trailing.by !== log.performed[i - 1].plan.trailing?.by),
    log.performed.map((p) => p.plan.trailing?.by ?? '-').join(','));
}

console.log('[cut] a cut-in is talked over the last words, and only the heard words are published');
{
  const { host, log } = fakeHost({ reactions: script });
  const floor = newFloor('m1', SEATS, 'cut-seed');
  await runFloor(host, floor, run(10));
  const cut = log.performed.find((p) => p.plan.cut);
  ok('Bo was cut off by Ana', !!cut && cut.turn.speaker === 'bo' && cut.plan.cut!.by === 'ana', JSON.stringify(log.performed.map((p) => [p.turn.speaker, !!p.plan.cut])));
  if (cut) {
    const [heard, over] = cut.events;
    ok('the published turn stops mid-sentence, after the first sentence', heard.text.length < cut.turn.text.length && heard.text.includes('opens here.') && !heard.text.includes('UNSAID'), heard.text);
    ok('the cut-in overlaps the last words of the heard text', over.kind === 'reaction' && over.overlap.with === heard.id && over.overlap.fromChar === tailStart(heard.text) && heard.cutOff.by === 'ana');
    const resumed = cut.plan.cut!.fight === 'speaker_resumes';
    ok('a won-back floor restarts the cut sentence; a lost one leaves the rest unsaid', resumed
      ? cut.events[2]?.text.includes(resumeText(cut.turn.text, cut.plan.cut!.atChar)) && heard.cutOff.resumedBy === cut.events[2].id
      : !cut.events.some((e) => e.text.includes('UNSAID')) && !heard.cutOff.resumedBy, JSON.stringify(cut.events.map((e) => e.text)));
    ok('a tension pause follows the cut', !!cut.plan.tensionMs && cut.plan.tensionMs >= 1200);
    // The projection: the turn written while Bo was being performed saw exactly what was heard.
    const i = log.performed.indexOf(cut);
    const next = log.generated[i + 1];
    const projected = (next?.projected ?? []).map((e: any) => e.text).join(' ');
    ok('the next turn was written while this one played, against the heard words only', !!next && next.projected.length >= 2 && projected.includes(heard.text) && projected.includes('On what base, Bo?')
      && (resumed || !projected.includes('UNSAID')), JSON.stringify(next?.projected));
  }
  ok('a short reaction is a turn in the room but not a floor turn', log.performed.some((p) => p.plan.trailing?.text === 'No.') && (floor.spoken.cy ?? 0) <= log.performed.filter((p) => p.turn.speaker === 'cy').length);
}

console.log('[restart] a turn caught mid-performance is performed again, not rewritten');
{
  const { host, log } = fakeHost();
  const floor = newFloor('m1', SEATS, 'restart');
  const turn: GeneratedTurn = { id: 'held', speaker: 'cy', shape: 'set_piece', text: 'RESTART-TEXT Already written before the restart.', trailer: {} };
  const res = await runFloor(host, floor, { ...run(2), performing: { turn, plan: {} } });
  ok('the held turn is performed first, as written', log.performed[0]?.turn.id === 'held' && log.performed[0].events[0].text === turn.text);
  ok('no model call was made for it', !log.generated.some((g) => g.speaker === 'cy' && log.generated.indexOf(g) === 0 && log.performed[0].turn.id !== 'held'), String(log.generated.length));
  ok('the checkpoint counts it', res.spokenTurns === 2 && log.generated.length === 1, `${res.spokenTurns} spoken, ${log.generated.length} generated`);
}

console.log('[chair] the chair speaks on a trigger, and puts the dodger straight back up');
{
  const { host, log } = fakeHost();
  const floor = newFloor('m1', SEATS, 'dodge');
  floor.owed.push({ from: 'cy', to: 'ana', question: 'What does Sunday cover cost?', messageId: 'q1', presses: 2 });
  await runFloor(host, floor, run(2));
  ok('a dodge pressed twice brings the chair in, by name', log.chair.length >= 1 && /CY has been asked "What does Sunday cover cost\?"/.test(log.chair[0]), JSON.stringify(log.chair));
  ok('and the person who dodged answers next, told why', log.generated[0]?.speaker === 'cy' && /the chair has called out the question you have not answered: What does Sunday cover cost\?/i.test(log.generated[0].direction), JSON.stringify(log.generated[0]));
  ok('an unanswered-question pause is on the record', log.pauses.includes('unanswered') && log.pauses.includes('chair'));
  const quiet = fakeHost();
  await runFloor(quiet.host, newFloor('m1', SEATS, 'calm'), run(4));
  ok('a calm room hears no chair at all', quiet.log.chair.length === 0, JSON.stringify(quiet.log.chair));
  const herd = fakeHost({ dynamics: ['ANA, BO, CY all moved toward the motion with no new evidence in between.'] });
  await runFloor(herd.host, newFloor('m1', SEATS, 'herd'), run(2));
  ok('the ledger\'s herd reaches the chair once', herd.log.chair.length === 1 && /herd|moved toward/.test(herd.log.chair[0]));
}

console.log('[desk] a desk calculation hands the floor straight back to whoever asked');
{
  let asked = false;
  const { host, log } = fakeHost({
    compute: (n) => (n === 1 ? 'Sunday wages over Sunday takings' : undefined),
    desk: (t) => (!asked && t.trailer.compute ? ((asked = true), 'YOU STOPPED THE ROOM TO HAVE THIS COMPUTED') : null),
  });
  await runFloor(host, newFloor('m1', SEATS, 'desk'), run(3));
  const first = log.performed[0].turn.speaker;
  ok('the asker answers the desk next, and may not call it again', log.generated[1]?.speaker === first && log.generated[1].mayCallDesk === false && /YOU STOPPED THE ROOM/.test(log.generated[1].direction), JSON.stringify(log.generated.slice(0, 2)));
  ok('nothing was written ahead while the desk was pending (it would have missed the number)', log.generated.length === log.performed.length);
}

console.log('[wind-down] nobody the crux turns on reaches a ruling unheard');
{
  const seats: DirectorSeat[] = SEATS.map((s) => ({ ...s, relevant: s.id !== 'ana' }));
  const { host, log } = fakeHost({ seats });
  const floor: FloorState = newFloor('m1', seats, 'wd');
  floor.lastSpoke = { ana: 3 };       // Bo and Cy have not spoken on this motion; both are relevant
  const res = await windDown(host, floor, { motionId: 'm1', checkpoint: 3, boundary: 0 });
  ok('each silent relevant expert gets one short turn', res.spokenTurns === 2 && new Set(log.generated.map((g) => g.speaker)).size === 2 && !log.generated.some((g) => g.speaker === 'ana'), JSON.stringify(log.generated.map((g) => g.speaker)));
  ok('the chair asks for their read first', /BO and CY have not been heard/.test(log.chair[0] ?? ''), JSON.stringify(log.chair));
  const none = fakeHost({ seats });
  const f2 = newFloor('m1', seats, 'wd2');
  f2.lastSpoke = { ana: 1, bo: 2, cy: 3 };
  ok('no wind-down when everyone relevant has spoken', (await windDown(none.host, f2, { motionId: 'm1', checkpoint: 3, boundary: 0 })).spokenTurns === 0 && none.log.chair.length === 0);
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
