/**
 * All realism logic tests (2b-5 dossiers and stakes, 2b-6 belief ledger, 2e
 * lint rules), plus one scripted scenario that drives the four modules
 * together the way the engine will after integration. Pure, offline.
 *   npx tsx src/realism/selftest.ts
 */
import { suite } from './check.ts';
import { run as runLint } from './lint-rules.selftest.ts';
import { run as runDossier } from './dossier.selftest.ts';
import { run as runStakes } from './stakes.selftest.ts';
import { run as runLedger } from './ledger.selftest.ts';
import { run as runEvidence } from './evidence.selftest.ts';
import { VARIED_PANEL, CONVERGED_PANEL } from './fixtures.ts';
import { checkDiversity, rosterText, voiceCard } from './dossier.ts';
import { resolveStakes, stakesBlock, slotSecFor, advanceClock, clockMilestones, minorityReport } from './stakes.ts';
import { foldLedger, newLedger, ownBelief, parseStanceLine, reduceLedger, mindChanges, renderMindChanges, ledgerChairTriggers, type LedgerState } from './ledger.ts';
import { bannedPhrasesIn, lintTurn, shouldRewrite, wordCount } from './lint-rules.ts';
import type { MeetingClock } from '../../../shared/types.ts';

function scenario(): number {
  const t = suite('scenario: one motion through all four modules');
  const motionId = 'm1';
  const motion = 'Open on Sundays from March with the current payroll';

  // 2b-5: panel design produced a converged panel; the check names who to regenerate, the retry is varied.
  const first = checkDiversity(CONVERGED_PANEL);
  t.ok('first panel converged and is sent back', !first.ok && first.regenerate.length > 0);
  const panel = VARIED_PANEL;
  t.ok('regenerated panel passes', checkDiversity(panel).ok);

  // Intake stakes, autonomous: missing pieces are assumed and marked.
  const st = resolveStakes({ atRisk: { people: 'two bakers on six days' } }, { founderName: 'Dana' });
  const prefixConstants = [rosterText(panel.map((e) => ({ id: e.id, name: e.id, role: 'expert', dossier: e.dossier }))), stakesBlock(st.marked)].join('\n\n');
  t.ok('shared constants carry no private dossier text', panel.every((e) => e.dossier.incentives.every((i) => !prefixConstants.includes(i))));
  t.ok('shared constants carry no banned phrase', bannedPhrasesIn(prefixConstants).length === 0);
  t.ok('assumed stakes are labelled in the prefix', /\(assumed\)/.test(prefixConstants) && st.assumptions.length === 4);

  // 2b-6: the ledger opens with starting stances (clerk call output).
  let ledger: LedgerState = newLedger(Object.fromEntries(panel.map((e) => [e.id, { stubbornness: e.dossier.stubbornness, priorPublicStance: e.dossier.priorPublicStance }])));
  const starts: Record<string, -2 | -1 | 0 | 1 | 2> = { ana: 2, bo: -2, cy: -1, di: 0 };
  ledger = reduceLedger(ledger, { type: 'open', motionId, seq: 1, beliefs: panel.map((e) => ({ expert: e.id, motionId, stance: starts[e.id], confidence: 'medium' as const, crux: 'Sunday margin after overtime', reasons: [], sinceSeq: 1 })) }).state;

  // Turns as the engine will see them after the trailer is split off.
  const turns: { speaker: string; text: string; stance?: string }[] = [
    { speaker: 'ana', text: 'Bank holiday takings were up a fifth. Sundays will look like that.', stance: 'for+2 | confidence: high' },
    { speaker: 'cy', text: 'On what base? You paid double time on every one of those days.', stance: 'against-1 | confidence: medium' },
    { speaker: 'bo', text: "No. Who bakes at four?" },
    { speaker: 'ana', text: "You're right that the ovens are full, but I still think we open.", stance: 'for+2 | confidence: medium' },
    { speaker: 'bo', text: 'Fine, I am moving. The rota numbers from the desk change it.', stance: 'against-1 | moved: evidence c_rota' },
  ];
  ledger = reduceLedger(ledger, { type: 'evidence', motionId, seq: 4, kind: 'evidence', ref: 'c_rota' }).state;
  let clock: MeetingClock = { elapsedSec: 0, slotSec: slotSecFor(40, 1) };
  const milestones: string[] = [];
  const lintScores: number[] = [];
  const recent: string[] = [];
  let seq = 10;
  for (const [i, tr] of turns.entries()) {
    const report = tr.stance ? parseStanceLine(tr.stance) : null;
    const before = ownBelief(ledger, motionId, tr.speaker)?.stance;
    const step = reduceLedger(ledger, { type: 'turn', motionId, seq: ++seq, expert: tr.speaker, messageId: `t${i}`, report });
    ledger = step.state;
    const moved = report ? before !== report.stance : undefined;
    const d = panel.find((e) => e.id === tr.speaker)!.dossier;
    const lint = lintTurn(tr.text, { neverSay: d.speech.neverSay, recentTurns: recent, stanceMoved: moved, names: panel.map((e) => e.id) });
    lintScores.push(lint.score);
    recent.push(tr.text);
    const next = advanceClock(clock, { words: wordCount(tr.text) });
    milestones.push(...clockMilestones(clock, next));
    clock = next;
  }
  t.ok('the courtesy concession (no stance move) is caught by lint', lintScores[3] > 0 && !shouldRewrite(lintTurn('No. Who bakes at four?')));
  t.ok('clean turns pass lint', lintScores[0] === 0 && lintScores[1] === 0 && lintScores[2] === 0, lintScores);
  t.ok('the clock advanced by speech', clock.elapsedSec > 0 && clock.elapsedSec < clock.slotSec && milestones.length === 0);
  const cards = panel.map((e) => voiceCard(e.dossier, { motion, belief: ownBelief(ledger, motionId, e.id) }));
  t.ok('each voice card carries only its own belief', cards[1].includes('leaning against') && !cards[1].includes('firmly for'), cards[1]);
  t.ok('no voice card has a banned phrase', cards.every((c) => bannedPhrasesIn(c).length === 0));

  // A checkpoint, then the summary for the report.
  ledger = reduceLedger(ledger, { type: 'checkpoint', motionId, seq: ++seq }).state;
  const sum = mindChanges(ledger, motionId, panel.map((e) => e.id));
  t.ok('bo gave ground on evidence; ana held firm', sum.experts.find((e) => e.expert === 'bo')!.moves[0].movedBy.ref === 'c_rota' && sum.heldFirm.includes('ana'));
  t.ok('no chair trigger: the one move had a cause', ledgerChairTriggers(ledger, motionId).length === 0);
  t.ok('report text renders', renderMindChanges(sum).length > 0);
  const minority = minorityReport([{ motionId, motionTitle: motion, decision: 'Trial four Sundays', owner: 'Dana', rationale: '', evidence: 'observed', dependsOn: [], dissents: [{ expert: 'bo', position: 'Hire first', reasoning: 'rota', tripwire: { signal: 'a six-day baker calls in sick twice in March', by: 'end of March' }, costOfIgnoring: 'losing a baker' }] }]);
  t.ok('minority report has a complete dissent', minority.length === 1 && minority[0].problems.length === 0);
  t.ok('replaying the same inputs gives the same ledger', JSON.stringify(foldLedger(newLedger(), []).state) === JSON.stringify(newLedger()));
  return t.done();
}

const fails = runLint() + runDossier() + runStakes() + runLedger() + runEvidence() + scenario();
console.log(`\nrealism logic: ${fails ? `${fails} FAILED` : 'all passed'}`);
process.exit(fails ? 1 : 0);
