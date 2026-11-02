/**
 * The glue between the engine and the realism modules (minds.ts), and the
 * realism lint rules as the engine's linter now applies them. No model.
 *
 *   npx tsx src/engine/minds.selftest.ts
 */
import { diversityFlag, reputations, stanceReport, triggerLine } from './minds.ts';
import { splitTrailer } from './trailer.ts';
import { lintTurn, WORD_BUDGET, type LintContext } from './lint.ts';
import { checkDiversity } from '../realism/dossier.ts';
import { CONVERGED_PANEL, VARIED_PANEL } from '../realism/fixtures.ts';

let fails = 0;
let passes = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) passes++;
  else fails++;
  console.log(`${cond ? '  ok  ' : '  FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};

console.log('[stance lines into the ledger]');
{
  const t = splitTrailer('Fine.\nSTANCE: for+1 | confidence: high | crux: rota | moved: evidence c_ab12 by bo | cost: my budget line | kind: conditional').trailer;
  const r = stanceReport(t);
  ok('stance, confidence and crux come from the tolerant parser', r?.stance === 1 && r.confidence === 'high' && r.crux === 'rota', JSON.stringify(r));
  ok('what moved them, the cost and the kind come from the ledger parser', r?.movedBy?.kind === 'evidence' && r.movedBy.ref === 'c_ab12' && r.movedBy.who === 'bo' && r.cost === 'my budget line' && r.kind === 'conditional', JSON.stringify(r));
  const loose = stanceReport(splitTrailer('x\nSTANCE: neutral 0 | confidence: low').trailer);
  ok('a stance the ledger parser alone could not read still counts', loose?.stance === 0 && loose.confidence === 'low' && !loose.movedBy, JSON.stringify(loose));
  ok('no STANCE line, no report', stanceReport(splitTrailer('Just speech.').trailer) === null);
}

console.log('[chair triggers as plain lines]');
{
  const name = (id: string) => ({ ana: 'Ana Ruiz', bo: 'Bo Chen', cy: 'Cy Okafor' } as Record<string, string>)[id] ?? id;
  const u = triggerLine({ kind: 'unexplained_move', motionId: 'm', expert: 'cy', messageId: 'x', seq: 3, stubbornness: 0.8, chairTrigger: true, candidates: [] }, name);
  ok('an unexplained move names the expert', !!u && u.startsWith('Cy Okafor moved on the motion'));
  const h = triggerLine({ kind: 'herd', motionId: 'm', seq: 9, sinceSeq: 1, direction: 1, experts: ['ana', 'bo', 'cy'], chairTrigger: true }, name);
  ok('a herd names everyone in it and the direction', !!h && h.includes('Ana Ruiz, Bo Chen, Cy Okafor') && h.includes('toward the motion'));
  ok('a flag that is not a chair matter gives no line', triggerLine({ kind: 'missing_trailer', motionId: 'm', expert: 'a', seq: 1, misses: 2 }, name) === null);
}

console.log('[the diversity check, as the founder reads it]');
{
  const bad = diversityFlag(checkDiversity(CONVERGED_PANEL), ['bo', 'cy'], [], (id) => id.toUpperCase());
  ok('a converged panel is flagged, in plain words', !bad.ok && bad.problems.length >= 5 && bad.problems.some((p) => /talk the same way/.test(p)) && bad.regenerated.join() === 'bo,cy', JSON.stringify(bad));
  const good = diversityFlag(checkDiversity(VARIED_PANEL), [], [], (id) => id);
  ok('a varied panel passes with no problems', good.ok && good.problems.length === 0, JSON.stringify(good));
  const miss = diversityFlag(checkDiversity(VARIED_PANEL), [], ['zed'], (id) => id);
  ok('a dossier that could not be written is a problem the founder sees', !miss.ok && /No dossier could be written for zed/.test(miss.problems[0]));
  ok('reputations are the public line only', JSON.stringify(reputations({ ana: VARIED_PANEL[0].dossier })) === JSON.stringify({ ana: VARIED_PANEL[0].dossier.publicReputation }));
}

console.log('[the realism lint rules, applied by the engine linter]');
{
  const ctx = (over: Partial<LintContext> = {}): LintContext => ({
    shape: 'reply', budget: WORD_BUDGET.reply, speaker: 'ana', names: ['Ana', 'Bo', 'Marcus'], chairName: 'Marcus',
    replyToColleague: true, recent: [], stanceMoved: null, antithesisSoFar: 0, ...over,
  });
  const chairTic = lintTurn('I would rather that be tested rather than admired, frankly.', ctx());
  ok('a phrase from the one banned list is caught', chairTic.rules.includes('banned:phrase'), JSON.stringify(chairTic.rules));
  const twice = lintTurn('Look, the ovens sit idle.', ctx({ tics: [{ text: 'look', maxPerMotion: 1, used: 1 }] }));
  ok('a habit past its per-motion budget is caught', twice.rules.includes('tic_over_budget') && twice.ticsUsed.join() === 'look', JSON.stringify(twice));
  const first = lintTurn('Look, the ovens sit idle.', ctx({ tics: [{ text: 'look', maxPerMotion: 1, used: 0 }] }));
  ok('the first use is fine, and counted', !first.rules.includes('tic_over_budget') && first.ticsUsed.join() === 'look');
  ok('neverSay is word-bounded', !lintTurn('The semicircle backing is fine.', ctx({ neverSay: ['circle back'] })).rules.includes('never_say')
    && lintTurn('Let us circle back on that.', ctx({ neverSay: ['circle back'] })).rules.includes('never_say'));
  ok('speech about speech is caught', lintTurn('Let me be blunt about the rota.', ctx()).rules.includes('meta_speech') || lintTurn('Let me be blunt about the rota.', ctx()).rules.includes('banned:meta_speech'));
  const tmpl = lintTurn('Bo, you are right that trade is there. But the rota breaks on week two (observed, from my shops). Marcus, get the desk to pull the staffing numbers.', ctx({ shape: 'set_piece', budget: WORD_BUDGET.set_piece, replyToColleague: false }));
  ok('the house template is caught', tmpl.rules.includes('template'), JSON.stringify(tmpl.rules));
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
