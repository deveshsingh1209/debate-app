/**
 * Stakes, meeting clock, dissent and reality-seat tests. Pure, offline.
 *   npx tsx src/realism/stakes.selftest.ts
 */
import { pathToFileURL } from 'node:url';
import { suite } from './check.ts';
import {
  STAKES_FIELDS, advanceClock, checkRealitySeat, clockLine, clockMilestones, costOfBeingWrong, dissentProblems, isOutOfTime,
  markAll, minorityReport, numberWords, realityKindFor, renderMinorityReport, resolveStakes, rulingOwner, slotSecFor, stakesBlock,
  type DissentRecord, type StakesDraft,
} from './stakes.ts';
import { bannedPhrasesIn } from './lint-rules.ts';

const FULL: StakesDraft = {
  decisionOwner: { name: 'Dana', role: 'owner of the bakery' },
  decideBy: 'the staff meeting on 3 November',
  atRisk: { money: 'about £1,800 a month in wages', people: 'two bakers already on six days' },
  ifWrong: { yes: 'burnout and losing a baker before Christmas', no: 'about £900 a month of Sunday takings to the café next door' },
  reversibility: 'two-way',
};

export function run(): number {
  const t = suite('stakes');

  t.section('resolveStakes: everything stated');
  {
    const r = resolveStakes(FULL, { founderName: 'Dana' });
    t.ok('nothing missing', r.missing.length === 0 && r.clarify.length === 0 && r.assumptions.length === 0, r);
    t.ok('source is founder', r.marked.stakes.source === 'founder');
    t.ok('every field marked founder', STAKES_FIELDS.every((f) => r.marked.fields[f] === 'founder'));
    t.ok('values kept', r.marked.stakes.decideBy === FULL.decideBy && r.marked.stakes.reversibility === 'two-way');
    const block = stakesBlock(r.marked);
    t.ok('block has no "(assumed)"', !block.includes('(assumed)'), block);
    t.ok('block names owner, date, money, people, both costs, door', ['Dana', '3 November', '£1,800', 'six days', 'burnout', 'café', 'two-way'].every((x) => block.includes(x)), block);
    t.ok('block is deterministic (cache-safe)', block === stakesBlock(resolveStakes(structuredClone(FULL), { founderName: 'Dana' }).marked));
    t.ok('block has no banned phrase', bannedPhrasesIn(block).length === 0);
    const fromDossier = resolveStakes({ ...FULL, from: 'dossier' });
    t.ok('a dossier-sourced draft is marked dossier', fromDossier.marked.stakes.source === 'dossier' && fromDossier.marked.fields.atRisk === 'dossier');
  }

  t.section('resolveStakes: nothing stated');
  {
    const r = resolveStakes({}, { founderName: 'Dana' });
    t.ok('all five missing', r.missing.length === 5, r.missing);
    t.ok('one clarify question per field, in order', r.clarify.map((c) => c.field).join() === STAKES_FIELDS.join());
    t.ok('the at-risk question asks money, people or time', /money, people, or time/.test(r.clarify.find((c) => c.field === 'atRisk')!.question));
    t.ok('one assumption line per field', r.assumptions.length === 5);
    t.ok('source is assumed', r.marked.stakes.source === 'assumed');
    t.ok('owner defaults to the founder', r.marked.stakes.decisionOwner.name === 'Dana');
    t.ok('owner defaults to "the founder" when unnamed', resolveStakes({}).marked.stakes.decisionOwner.name === 'the founder');
    t.ok('no figure is invented for money at risk', r.marked.stakes.atRisk.money === 'not stated', r.marked.stakes.atRisk);
    t.ok('unknown door is treated as one-way', r.marked.stakes.reversibility === 'one-way');
    const block = stakesBlock(r.marked);
    t.ok('every line of the block says assumed', block.split('\n').slice(1).every((l) => l.includes('(assumed)')), block);
  }

  t.section('resolveStakes: partial');
  {
    const r = resolveStakes({ atRisk: { time: ' three months of evenings ' }, ifWrong: { yes: 'burnout' } });
    t.ok('present fields are real, missing ones assumed', r.marked.fields.atRisk === 'founder' && r.marked.fields.ifWrong === 'founder' && r.marked.fields.decideBy === 'assumed');
    t.ok('whitespace trimmed', r.marked.stakes.atRisk.time === 'three months of evenings');
    t.ok('half-stated ifWrong keeps the stated side', r.marked.stakes.ifWrong.yes === 'burnout' && r.marked.stakes.ifWrong.no === 'not stated');
    t.ok('blank strings count as missing', resolveStakes({ decideBy: '   ' }).missing.includes('decideBy'));
    const block = stakesBlock(r.marked);
    t.ok('only assumed lines are marked', /At risk: time: three months of evenings\./.test(block) && /Decide by: .*\(assumed\)/.test(block), block);
    const m = markAll({ ...r.marked.stakes, source: 'assumed' });
    t.ok('markAll spreads one source over every field', STAKES_FIELDS.every((f) => m.fields[f] === 'assumed'));
  }

  t.section('rulings');
  {
    const m = resolveStakes(FULL).marked;
    t.ok('ruling owner is the decision owner by default', rulingOwner(m.stakes) === 'Dana');
    t.ok('the room can name someone else', rulingOwner(m.stakes, 'Bo') === 'Bo');
    t.ok('old debate without stakes falls back', rulingOwner(undefined) === 'the founder');
    t.ok('cost of a wrong yes', /burnout/.test(costOfBeingWrong(m, 'yes')) && /can be undone/.test(costOfBeingWrong(m, 'yes')));
    t.ok('cost of a wrong no', /café/.test(costOfBeingWrong(m, 'no')));
    t.ok('assumed cost says so', /\(assumed\)/.test(costOfBeingWrong(resolveStakes({}).marked, 'yes')));
  }

  t.section('meeting clock');
  {
    // The profiles no longer carry a turn cap (budget redesign), so the clock is
    // tested on the turn counts the old standard and quick caps used: 80 and 40.
    const std = slotSecFor(80, 2);
    t.ok('standard slot is about 11 minutes', std >= 600 && std <= 780, std);
    t.ok('quick (one motion) is also about 11 minutes', Math.abs(slotSecFor(40, 1) - std) < 60, slotSecFor(40, 1));
    t.ok('zero motions does not divide by zero', Number.isFinite(slotSecFor(40, 0)));
    let c = { elapsedSec: 0, slotSec: 600 };
    const c2 = advanceClock(c, { words: 250 });
    t.ok('250 words at 2.5 w/s is 100 s', c2.elapsedSec === 100);
    t.ok('advance is pure', c.elapsedSec === 0);
    t.ok('pauses and research waits count', advanceClock(c, { pauseMs: 3000, researchWaits: 1 }).elapsedSec === 93);
    t.ok('negative input never runs the clock backwards', advanceClock(c, { words: -50 }).elapsedSec === 0);
    t.ok('half-way milestone', clockMilestones({ elapsedSec: 0, slotSec: 1200 }, { elapsedSec: 601, slotSec: 1200 }).join() === 'half');
    t.ok('in a ten-minute slot half-way is also five left', clockMilestones(c, { ...c, elapsedSec: 301 }).join() === 'half,five_left');
    t.ok('jumping past several milestones lists them in order', clockMilestones(c, { ...c, elapsedSec: 600 }).join() === 'half,five_left,one_left,time');
    t.ok('no milestone twice', clockMilestones({ ...c, elapsedSec: 301 }, { ...c, elapsedSec: 320 }).length === 0);
    t.ok('five-left skipped for a slot under five minutes', !clockMilestones({ elapsedSec: 0, slotSec: 240 }, { elapsedSec: 240, slotSec: 240 }).includes('five_left'));
    c = { elapsedSec: 14 * 60 + 20, slotSec: 20 * 60 };
    t.ok('clock line in words', clockLine(c) === 'Fourteen minutes into a twenty-minute slot.', clockLine(c));
    t.ok('one minute is singular', clockLine({ elapsedSec: 61, slotSec: 660 }) === 'One minute into an eleven-minute slot.', clockLine({ elapsedSec: 61, slotSec: 660 }));
    t.ok('under a minute', /^Under a minute/.test(clockLine({ elapsedSec: 10, slotSec: 660 })));
    t.ok('out of time', isOutOfTime({ elapsedSec: 660, slotSec: 660 }) && /used up/.test(clockLine({ elapsedSec: 700, slotSec: 660 })));
    t.ok('number words', numberWords(21) === 'twenty-one' && numberWords(40) === 'forty' && numberWords(120) === '120');
  }

  t.section('dissent with teeth');
  {
    const good: DissentRecord = {
      expert: 'bo', position: 'Do not open Sundays yet', reasoning: 'two bakers are on six days',
      tripwire: { signal: 'either six-day baker calls in sick twice in a month', by: 'end of December' },
      costOfIgnoring: 'losing a baker in the Christmas rush',
    };
    t.ok('a complete dissent has no problems', dissentProblems(good).length === 0, dissentProblems(good));
    t.ok('missing tripwire and cost', dissentProblems({ expert: 'bo', position: 'x', reasoning: 'y' }).join() === 'no_tripwire,no_cost');
    t.ok('vague signal', dissentProblems({ ...good, tripwire: { signal: 'time will tell', by: 'Q1' } }).includes('vague_signal'));
    t.ok('too short a signal is vague', dissentProblems({ ...good, tripwire: { signal: 'sales drop', by: 'Q1' } }).includes('vague_signal'));
    t.ok('no deadline', dissentProblems({ ...good, tripwire: { signal: good.tripwire!.signal, by: 'eventually' } }).includes('no_deadline'));
    t.ok('an occasion counts as a deadline', dissentProblems({ ...good, tripwire: { signal: good.tripwire!.signal, by: 'the spring board review' } }).length === 0);
    const rep = minorityReport([
      { motionId: 'm1', motionTitle: 'Open on Sundays', decision: 'Open from March', owner: 'Dana', rationale: '', evidence: 'observed', dependsOn: [], dissents: [good, { expert: 'cy', position: 'Wait a quarter', reasoning: 'no ledger' }] },
      { motionId: 'm2', motionTitle: 'Hire a weekend baker', decision: 'Hire', owner: 'Dana', rationale: '', evidence: 'assumed', dependsOn: [], dissents: [] },
    ]);
    t.ok('one entry per dissent, in ruling order', rep.length === 2 && rep[0].expert === 'bo' && rep[1].expert === 'cy');
    t.ok('an old-shape dissent is kept and marked incomplete', rep[1].problems.includes('no_tripwire') && !('tripwire' in rep[1]));
    const text = renderMinorityReport(rep, (id) => id.toUpperCase());
    t.ok('text has tripwire, deadline and cost', /BO dissents/.test(text) && /end of December/.test(text) && /Christmas rush/.test(text), text);
    t.ok('text marks the incomplete one', /Incomplete: no_tripwire, no_cost/.test(text));
    t.ok('no dissents says so', renderMinorityReport([]) === 'No dissents were recorded.');
  }

  t.section('reality-check seat');
  {
    const bakery = 'Should a four-person neighbourhood bakery open on Sundays when two of the staff already work six days?';
    const saas = 'Should a 12-person B2B SaaS company move new customers from monthly to annual-only billing next quarter?';
    t.ok('bakery topic wants operations', realityKindFor(bakery) === 'operations');
    t.ok('billing topic wants finance', realityKindFor(saas) === 'finance');
    t.ok('a build topic wants delivery', realityKindFor('Should we rewrite the app and ship the new platform?') === 'delivery');
    t.ok('an unknown topic defaults to operations', realityKindFor('Should I move to Lisbon?') === 'operations');
    const panel = [{ id: 'ana', role: 'Growth consultant' }, { id: 'bo', role: 'Operations lead, former head baker' }, { id: 'cy', role: 'Labour-law adviser' }];
    const ok = checkRealitySeat(panel, bakery);
    t.ok('an operations lead satisfies a bakery panel', ok.ok && ok.seat === 'bo', ok);
    const anyImpl = checkRealitySeat(panel, saas);
    t.ok('any implementer satisfies the rule when the exact kind is absent', anyImpl.ok && anyImpl.seat === 'bo' && anyImpl.want === 'finance', anyImpl);
    const none = checkRealitySeat([{ id: 'ana', role: 'Growth consultant' }, { id: 'cy', role: 'Labour-law adviser' }], saas);
    t.ok('no implementer fails with a hint for the architect', !none.ok && /finance implementer/.test(none.hint ?? ''), none);
    t.ok('the hint has no banned phrase', bannedPhrasesIn(none.hint ?? '').length === 0);
    t.ok('a CFO is a finance implementer', checkRealitySeat([{ id: 'x', role: 'Fractional CFO for startups' }], saas).seat === 'x');
  }
  return t.done();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(run() ? 1 : 0);
