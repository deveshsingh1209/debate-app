/**
 * FloorDirector unit tests. Pure, offline, no model, no database.
 *   npx tsx src/engine/director.selftest.ts
 */
import {
  newFloor, pickNext, recordTurn, decideInterruption, recordInterruption, decayHeat, raiseHeat,
  splitSentences, chairTrigger, floorFight, rand, DIRECTOR_RULES, FOUNDER_ID, type DirectorSeat, type Reaction,
} from './director.ts';

let fails = 0;
let passes = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) passes++;
  else fails++;
  console.log(`${cond ? '  ok  ' : '  FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};

const seats: DirectorSeat[] = [
  { id: 'ana', typicalWords: 120 },
  { id: 'bo', typicalWords: 60 },
  { id: 'cy', typicalWords: 150 },
  { id: 'di', typicalWords: 90 },
];
const hot = { heatGain: 0.3, heatDecay: 0.1, interruptThreshold: 0.6, dominance: 0.5 };

console.log('[1] owed answers win');
{
  const st = newFloor('m1', seats, 'seed-1');
  recordTurn(st, seats, { speaker: 'ana', messageId: 'x1' });
  recordTurn(st, seats, { speaker: 'cy', to: ['bo'], question: 'Which base is that on?', messageId: 'x2' });
  st.heat.di = 1; // the hottest person in the room still loses to someone who owes an answer
  const p = pickNext(st, seats, { lastSpeaker: 'cy' });
  ok('the person who owes the answer is picked', p.speaker === 'bo', p.speaker);
  ok('and gives a reply, not a set piece', p.shape === 'reply', p.shape);
  ok('the pick says why', /owes/.test(p.why), p.why);
  recordTurn(st, seats, { speaker: 'bo', messageId: 'x3' });
  ok('answering clears the debt', st.owed.length === 0, JSON.stringify(st.owed));
}

console.log('[2] an unanswered question is pressed, and twice brings the chair');
{
  const st = newFloor('m1', seats, 'seed-2');
  recordTurn(st, seats, { speaker: 'ana', to: ['bo'], question: 'Source?', messageId: 'a' });
  recordTurn(st, seats, { speaker: 'cy', messageId: 'b' });
  recordTurn(st, seats, { speaker: 'ana', to: ['bo'], question: 'Source?', messageId: 'c' });
  ok('a second ask presses the same debt', st.owed.length === 1 && st.owed[0].presses === 1, JSON.stringify(st.owed));
  recordTurn(st, seats, { speaker: 'di', messageId: 'd' });
  recordTurn(st, seats, { speaker: 'ana', to: ['bo'], question: 'Source?', messageId: 'e' });
  const t = chairTrigger(st);
  ok('after two presses the chair names the dodge', t?.kind === 'dodge' && t.who === 'bo', JSON.stringify(t));
}

console.log('[3] duel cap');
{
  const st = newFloor('m1', seats, 'seed-3');
  for (const id of Object.keys(st.heat)) st.heat[id] = 0.9;
  const order = ['ana', 'bo', 'ana', 'bo', 'ana'];
  for (const [i, s] of order.entries()) recordTurn(st, seats, { speaker: s, messageId: `d${i}` });
  ok('five alternating turns are four exchanges', st.duel?.exchanges === DIRECTOR_RULES.duelMaxExchanges, JSON.stringify(st.duel));
  for (const id of Object.keys(st.heat)) st.heat[id] = 0.9;
  const p = pickNext(st, seats, { lastSpeaker: 'ana' });
  ok('a spent duel brings in a third voice', p.speaker !== 'ana' && p.speaker !== 'bo', p.speaker);
  recordTurn(st, seats, { speaker: p.speaker, messageId: 'd9' });
  ok('and that ends the duel', st.duel?.exchanges === 1 && st.duel.b === p.speaker, JSON.stringify(st.duel));
}

console.log('[4] a live duel is allowed to continue');
{
  const st = newFloor('m1', seats, 'seed-4');
  recordTurn(st, seats, { speaker: 'ana', messageId: 'a' });
  recordTurn(st, seats, { speaker: 'bo', messageId: 'b' });
  st.heat.ana = 0.9; st.heat.bo = 0.9; st.heat.cy = 0.1; st.heat.di = 0.1;
  const p = pickNext(st, seats, { lastSpeaker: 'bo' });
  ok('the other duellist answers back', p.speaker === 'ana', p.speaker);
  ok('as a reply', p.shape === 'reply', p.shape);
}

console.log('[5] nobody speaks twice in a row; the founder is never picked');
{
  const st = newFloor('m1', [...seats, { id: FOUNDER_ID }], 'seed-5');
  let last: string | undefined;
  let repeat = false, founder = false;
  for (let i = 0; i < 40; i++) {
    const p = pickNext(st, [...seats, { id: FOUNDER_ID }], { lastSpeaker: last });
    if (p.speaker === last) repeat = true;
    if (p.speaker === FOUNDER_ID) founder = true;
    recordTurn(st, seats, { speaker: p.speaker, messageId: `t${i}` });
    last = p.speaker;
  }
  ok('no back-to-back turns in 40 picks', !repeat);
  ok('the founder is never put up', !founder);
}

console.log('[6] interruptions: founder, first sentence, cap, gap, threshold');
const utterance = 'The payback lands inside month two. That assumes the first cohort holds. And it will, because retention on the pilot was eighty percent.';
const sents = splitSentences(utterance);
ok('sentence split finds three sentences', sents.length === 3, JSON.stringify(sents));
ok('sentence offsets index the original text', sents.every((s) => utterance.slice(s.start, s.start + s.text.length) === s.text));
const seatsHot: DirectorSeat[] = seats.map((s) => ({ ...s, temperament: hot }));
const cut = (r: Partial<Reaction>): Reaction => ({ listener: 'bo', intensity: 3, atSentence: 1, cutIn: 'On what base?', ...r });
{
  const st = newFloor('m1', seatsHot, 'seed-6');
  st.heat.bo = 0.5;
  ok('the founder is never interrupted', decideInterruption(st, seatsHot, FOUNDER_ID, utterance, [cut({})]) === null);
  ok('never before the first sentence is finished', decideInterruption(st, seatsHot, 'ana', utterance, [cut({ atSentence: 0 })]) === null);
  ok('a one-sentence turn cannot be cut', decideInterruption(st, seatsHot, 'ana', 'Just one sentence here.', [cut({ atSentence: 0 })]) === null);
  ok('the founder never cuts in through the director', decideInterruption(st, seatsHot, 'ana', utterance, [cut({ listener: FOUNDER_ID })]) === null);
  ok('a cold listener below threshold does not cut in', decideInterruption({ ...st, heat: { ...st.heat, bo: 0 } }, seatsHot, 'ana', utterance, [cut({ intensity: 1 })]) === null);
  const i = decideInterruption(st, seatsHot, 'ana', utterance, [cut({})]);
  ok('a hot listener with high intensity cuts in', !!i && i.by === 'bo', JSON.stringify(i));
  if (i) {
    const target = sents[1];
    const into = (i.atChar - target.start) / target.text.length;
    ok('the cut lands mid-sentence (40-80% in, snapped back to a word boundary)', into > 0.4 && into <= DIRECTOR_RULES.cutTo && utterance[i.atChar] === ' ', `${into} "${utterance.slice(0, i.atChar)}"`);
    ok('the speaker has finished sentence one', i.atChar > sents[0].start + sents[0].text.length);
    recordInterruption(st, seatsHot, i.by, 'ana');
    ok('being cut off makes the speaker hotter', st.heat.ana > 0.2, String(st.heat.ana));
    ok('the same person cannot cut in again within the gap', decideInterruption(st, seatsHot, 'cy', utterance, [cut({})]) === null);
    st.turn += DIRECTOR_RULES.minInterruptGap;
    ok('after the gap they can', decideInterruption(st, seatsHot, 'cy', utterance, [cut({})]) !== null);
  }
  st.interruptions = DIRECTOR_RULES.interruptCap;
  ok('the interruption cap holds', decideInterruption(st, seatsHot, 'cy', utterance, [cut({ listener: 'di' })]) === null);
}

console.log('[7] heat decay and gain');
{
  const st = newFloor('m1', seatsHot, 'seed-7');
  st.heat.ana = 0.8;
  decayHeat(st, seatsHot);
  ok('heat decays by temperament', Math.abs(st.heat.ana - 0.8 * (1 - hot.heatDecay)) < 1e-9, String(st.heat.ana));
  for (let k = 0; k < 10; k++) raiseHeat(st, seatsHot, 'bo');
  ok('heat is capped at 1', st.heat.bo === 1, String(st.heat.bo));
  ok('over 0.85 the chair steps in', chairTrigger(st)?.kind === 'heat');
  for (let k = 0; k < 60; k++) decayHeat(st, seatsHot);
  ok('and it cools back down', st.heat.bo < 0.1, String(st.heat.bo));
}

console.log('[8] seeded: the same seed gives the same room');
{
  const run = (seed: string) => {
    const st = newFloor('m1', seatsHot, seed);
    const out: string[] = [];
    let last: string | undefined;
    for (let i = 0; i < 25; i++) {
      const p = pickNext(st, seatsHot, { lastSpeaker: last });
      out.push(`${p.speaker}:${p.shape}`);
      recordTurn(st, seatsHot, { speaker: p.speaker, messageId: `t${i}` });
      last = p.speaker;
    }
    const fight = floorFight(st, seatsHot, 'ana', 'bo');
    return out.join(',') + '|' + fight + '|' + rand(st);
  };
  ok('identical sequence for an identical seed', run('alpha') === run('alpha'));
  ok('a different seed gives a different sequence', run('alpha') !== run('beta'));
}

console.log('[9] shapes and budgets');
{
  const st = newFloor('m1', seats, 'seed-9');
  const p = pickNext(st, seats, {});
  ok('the first turn of a motion is a set piece', p.shape === 'set_piece', p.shape);
  const seat = seats.find((s) => s.id === p.speaker)!;
  ok('a set piece uses the speaker\'s own length', p.words === Math.max(60, Math.min(160, seat.typicalWords!)), `${p.words}`);
  recordTurn(st, seats, { speaker: p.speaker, to: ['bo'], question: 'Why?', messageId: 'q' });
  const r = pickNext(st, seats, { lastSpeaker: p.speaker, addressed: ['bo'] });
  ok('an addressed reply is short', r.shape === 'reply' && r.words <= 60, `${r.shape} ${r.words}`);
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
