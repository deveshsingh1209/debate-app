/**
 * Belief ledger tests. Pure, offline, no model, no database.
 *   npx tsx src/realism/ledger.selftest.ts
 */
import { pathToFileURL } from 'node:url';
import { suite } from './check.ts';
import {
  LEDGER_RULES, allowedCauses, classifyMove, detectHerd, foldLedger, isHardening, ledgerChairTriggers, mindChanges, newLedger,
  ownBelief, parseStanceLine, reduceLedger, renderMindChanges, type LedgerEmit, type LedgerFlag, type LedgerInput, type StanceReport,
} from './ledger.ts';
import type { Belief, Stance } from '../../../shared/types.ts';

const M = 'm1';
const belief = (expert: string, stance: Stance, seq = 1): Belief => ({ expert, motionId: M, stance, confidence: 'medium', crux: `${expert} crux`, reasons: [], sinceSeq: seq });
const rep = (stance: Stance, extra: Partial<StanceReport> = {}): StanceReport => ({ stance, confidence: 'medium', ...extra });
let seqN = 10;
const turn = (expert: string, report?: StanceReport | null, messageId?: string): LedgerInput => {
  seqN++;
  return { type: 'turn', motionId: M, seq: seqN, expert, messageId: messageId ?? `msg${seqN}`, report };
};
const flags = (e: LedgerEmit[], kind?: LedgerFlag['kind']) =>
  e.filter((x): x is Extract<LedgerEmit, { type: 'flag' }> => x.type === 'flag').map((x) => x.flag).filter((f) => !kind || f.kind === kind);
const concessions = (e: LedgerEmit[]) => e.filter((x) => x.type === 'concession').map((x) => (x as Extract<LedgerEmit, { type: 'concession' }>).concession);

const TRAITS = {
  ana: { stubbornness: 0.3 },
  bo: { stubbornness: 0.8, priorPublicStance: 'Said on a podcast that seven-day bakeries burn people out.' },
  cy: { stubbornness: 0.55 },
  di: { stubbornness: 0.65 },
};
const OPEN: LedgerInput = { type: 'open', motionId: M, seq: 1, beliefs: [belief('ana', 2), belief('bo', -2), belief('cy', -1), belief('di', 0)] };

export function run(): number {
  const t = suite('ledger');

  t.section('parseStanceLine');
  {
    const p = parseStanceLine('for+1 | confidence: high | crux: first-cohort churn under 3% | moved: evidence c_ab12 by kabir | cost: my pilot budget | kind: conditional');
    t.ok('stance and confidence', p?.stance === 1 && p.confidence === 'high', p);
    t.ok('crux', p?.crux === 'first-cohort churn under 3%');
    t.ok('moved by evidence with ref and who', p?.movedBy?.kind === 'evidence' && p.movedBy.ref === 'c_ab12' && p.movedBy.who === 'kabir', p?.movedBy);
    t.ok('cost and kind', p?.cost === 'my pilot budget' && p.kind === 'conditional');
    t.ok('argument by someone, no ref', (() => { const x = parseStanceLine('against-1 | moved: argument by bo'); return x?.movedBy?.kind === 'argument' && x.movedBy.who === 'bo' && !x.movedBy.ref; })());
    t.ok('leading "STANCE:" and bold markers tolerated', parseStanceLine('**STANCE:** against-2 | confidence: low')?.stance === -2);
    t.ok('spaces inside the stance token', parseStanceLine('for +2')?.stance === 2);
    t.ok('neutral words', parseStanceLine('undecided')?.stance === 0 && parseStanceLine('0')?.stance === 0);
    t.ok('bad confidence defaults to medium', parseStanceLine('for+1 | confidence: very')?.confidence === 'medium');
    t.ok('unknown cause ignored', parseStanceLine('for+1 | moved: vibes')?.movedBy === undefined);
    t.ok('unreadable stance is null (counts as missing)', parseStanceLine('maybe | confidence: high') === null && parseStanceLine('') === null);
    t.ok('reasons split on semicolons', parseStanceLine('for+1 | reasons: a; b')?.reasons?.length === 2);
  }

  t.section('open emits starting beliefs');
  {
    const r = reduceLedger(newLedger(TRAITS), OPEN);
    const b = r.emits.find((e) => e.type === 'belief');
    t.ok('a belief event with every starting stance', b?.type === 'belief' && b.beliefs.length === 4, r.emits);
    t.ok('pure: the input state is untouched', Object.keys(newLedger(TRAITS).motions).length === 0);
    const again = reduceLedger(r.state, { type: 'open', motionId: M, seq: 2, beliefs: [belief('ana', -2)] });
    t.ok('re-opening does not overwrite a stance already held', again.state.motions[M].beliefs.ana.stance === 2);
    const wrong = reduceLedger(r.state, { type: 'open', motionId: M, seq: 2, beliefs: [{ ...belief('zed', 1), motionId: 'other' }] });
    t.ok('beliefs for another motion are ignored', !wrong.state.motions[M].beliefs.zed);
  }

  t.section('a stance move emits a concession');
  {
    const r = foldLedger(newLedger(TRAITS), [OPEN, turn('cy', rep(0, { movedBy: { kind: 'computation', ref: 'q1' } }), 'c1')]);
    const c = concessions(r.emits);
    t.ok('one concession', c.length === 1, r.emits);
    t.ok('from and to recorded', c[0].from.stance === -1 && c[0].to.stance === 0);
    t.ok('partial (off their side to the fence)', c[0].kind === 'partial');
    t.ok('cause kept', c[0].movedBy.kind === 'computation' && c[0].movedBy.ref === 'q1');
    t.ok('messageId kept', c[0].messageId === 'c1');
    t.ok('the persisted shape has no ledger-only fields', !('seq' in c[0]));
    t.ok('belief updated, sinceSeq moved', r.state.motions[M].beliefs.cy.stance === 0 && r.state.motions[M].beliefs.cy.sinceSeq === seqN);
    t.ok('a computation not in the record is flagged unknown_ref', flags(r.emits, 'unknown_ref').length === 1);
  }

  t.section('kinds and costs');
  {
    t.ok('crossing sides is full', classifyMove(2, -1) === 'full' && classifyMove(-1, 1) === 'full');
    t.ok('toward the fence is partial', classifyMove(2, 1) === 'partial' && classifyMove(-2, 0) === 'partial');
    t.ok('off the fence is partial', classifyMove(0, 1) === 'partial');
    t.ok('hardening detected', isHardening(1, 2) && isHardening(-1, -2) && !isHardening(0, 1) && !isHardening(2, 1));
    const r = foldLedger(newLedger(TRAITS), [
      OPEN,
      { type: 'evidence', motionId: M, seq: 5, kind: 'evidence', ref: 'c_rota' },
      turn('bo', rep(1, { movedBy: { kind: 'evidence', ref: 'c_rota' } }), 'b1'),
    ]);
    const c = concessions(r.emits)[0];
    t.ok('a stubborn expert crossing on evidence: full, no flags', c.kind === 'full' && flags(r.emits).length === 0, r.emits);
    t.ok('cost of a full concession names the public stance walked back', /podcast/.test(c.cost), c.cost);
    const r2 = foldLedger(newLedger(TRAITS), [OPEN, turn('ana', rep(1, { movedBy: { kind: 'argument', who: 'bo' } }))]);
    t.ok('leaving a firm position costs that', concessions(r2.emits)[0].cost === 'gives up a firm position');
    const r3 = foldLedger(newLedger(TRAITS), [OPEN, turn('ana', rep(1, { movedBy: { kind: 'argument', who: 'bo' }, cost: 'my case study', kind: 'conditional' }))]);
    t.ok('trailer cost and kind win', concessions(r3.emits)[0].cost === 'my case study' && concessions(r3.emits)[0].kind === 'conditional');
    const r4 = foldLedger(newLedger(TRAITS), [OPEN, turn('cy', rep(1, { movedBy: { kind: 'argument', who: 'ana' } }))]);
    t.ok('without a public stance, full costs the opening side', concessions(r4.emits)[0].cost === 'gives up their opening side');
  }

  t.section('confidence-only changes and hardening are not concessions');
  {
    const r = foldLedger(newLedger(TRAITS), [OPEN, turn('ana', { stance: 2, confidence: 'low' }), turn('cy', rep(-2))]);
    t.ok('no concession emitted', concessions(r.emits).length === 0, r.emits);
    t.ok('confidence updated', r.state.motions[M].beliefs.ana.confidence === 'low');
    t.ok('confidence change keeps sinceSeq', r.state.motions[M].beliefs.ana.sinceSeq === 1);
    t.ok('hardening recorded', r.state.motions[M].hardenings.length === 1 && r.state.motions[M].hardenings[0].expert === 'cy');
  }

  t.section('carry-forward on a missing trailer');
  {
    const r = foldLedger(newLedger(TRAITS), [OPEN, turn('ana', null), turn('ana')]);
    t.ok('stance carried forward', r.state.motions[M].beliefs.ana.stance === 2);
    t.ok('no concession', concessions(r.emits).length === 0);
    t.ok(`flagged for the referee after ${LEDGER_RULES.missFlagAfter} misses`, flags(r.emits, 'missing_trailer').length === 1, r.emits);
    const r3 = reduceLedger(r.state, turn('ana'));
    t.ok('flagged once per streak, not every turn', flags(r3.emits, 'missing_trailer').length === 0);
    const r4 = foldLedger(r3.state, [turn('ana', rep(2)), turn('ana'), turn('ana')]);
    t.ok('a trailer resets the streak; a new streak flags again', flags(r4.emits, 'missing_trailer').length === 1);
    const r5 = foldLedger(newLedger(TRAITS), [turn('zed'), turn('zed')]);
    t.ok('no stance at all: one no_stance flag, nothing invented', flags(r5.emits, 'no_stance').length === 1 && !r5.state.motions[M].beliefs.zed);
    const r6 = reduceLedger(r5.state, turn('zed', rep(1)));
    t.ok('the first trailer becomes the starting belief, not a concession', concessions(r6.emits).length === 0 && r6.emits.some((e) => e.type === 'belief') && r6.state.motions[M].opening.zed?.stance === 1);
  }

  t.section('unexplained moves and stubbornness');
  {
    const r = foldLedger(newLedger(TRAITS), [OPEN, { type: 'evidence', motionId: M, seq: 3, kind: 'evidence', ref: 'c_x' }, turn('bo', rep(-1), 'bmove')]);
    const c = concessions(r.emits)[0];
    const f = flags(r.emits, 'unexplained_move')[0];
    t.ok('no cause recorded: movedBy unexplained', c.movedBy.kind === 'unexplained');
    t.ok('flagged', !!f && f.kind === 'unexplained_move' && f.expert === 'bo');
    t.ok('a stubborn expert folding is a chair trigger', f?.kind === 'unexplained_move' && f.chairTrigger === true);
    t.ok('evidence that landed since their last stance is offered as a candidate', f?.kind === 'unexplained_move' && f.candidates.includes('c_x'), f);
    t.ok('it is an open chair trigger', ledgerChairTriggers(r.state, M).some((x) => x.kind === 'unexplained_move'));
    const soft = foldLedger(newLedger(TRAITS), [OPEN, turn('ana', rep(1))]);
    const sf = flags(soft.emits, 'unexplained_move')[0];
    t.ok('an easy-going expert moving unexplained is flagged but not a chair trigger', sf?.kind === 'unexplained_move' && sf.chairTrigger === false, sf);
    const fill = reduceLedger(r.state, { type: 'attribute', motionId: M, messageId: 'bmove', movedBy: { kind: 'evidence', ref: 'c_x' } });
    const upd = fill.emits.find((e) => e.type === 'concession_update');
    t.ok('the referee fills the cause: concession_update with the same messageId', upd?.type === 'concession_update' && upd.concession.messageId === 'bmove' && upd.concession.movedBy.kind === 'evidence');
    t.ok('the flag is resolved and no longer a chair trigger', !ledgerChairTriggers(fill.state, M).some((x) => x.kind === 'unexplained_move'));
    const weak = reduceLedger(r.state, { type: 'attribute', motionId: M, messageId: 'bmove', movedBy: { kind: 'social', who: 'ana' } });
    t.ok('a social cause for a stubborn expert is weak and a chair trigger', flags(weak.emits, 'weak_cause').some((x) => x.kind === 'weak_cause' && x.chairTrigger), weak.emits);
    t.ok('attributing an unknown message is a no-op', reduceLedger(r.state, { type: 'attribute', motionId: M, messageId: 'nope', movedBy: { kind: 'argument' } }).emits.length === 0);
    t.ok('allowed causes narrow with stubbornness', allowedCauses(0.9).length < allowedCauses(0.5).length && allowedCauses(0.5).length < allowedCauses(0.1).length);
    t.ok('high stubbornness never accepts argument alone', !allowedCauses(0.8).includes('argument'));
    const mid = foldLedger(newLedger(TRAITS), [OPEN, turn('cy', rep(0, { movedBy: { kind: 'social' } }))]);
    t.ok('mid stubbornness: social is weak, not a chair trigger', flags(mid.emits, 'weak_cause').some((x) => x.kind === 'weak_cause' && !x.chairTrigger));
    const unknownTrait = foldLedger(newLedger({}), [OPEN, turn('ana', rep(1))]);
    t.ok('missing trait defaults to 0.5 (not a chair trigger)', flags(unknownTrait.emits, 'unexplained_move').every((x) => x.kind === 'unexplained_move' && x.stubbornness === 0.5 && !x.chairTrigger));
  }

  t.section('tactical reversal');
  {
    const r = foldLedger(newLedger(TRAITS), [OPEN, turn('ana', rep(1, { movedBy: { kind: 'argument', who: 'bo' } }), 'a1'), turn('ana', rep(2), 'a2')]);
    const upd = r.emits.find((e) => e.type === 'concession_update');
    t.ok('moving straight back marks the concession tactical', upd?.type === 'concession_update' && upd.concession.kind === 'tactical' && upd.concession.messageId === 'a1', r.emits);
    t.ok('and flags it', flags(r.emits, 'tactical_reversal').length === 1);
    const late = foldLedger(newLedger(TRAITS), [OPEN, turn('ana', rep(1, { movedBy: { kind: 'argument' } })), turn('ana', rep(1)), turn('ana', rep(1)), turn('ana', rep(1)), turn('ana', rep(2))]);
    t.ok('outside the window it is just a hardening', !late.emits.some((e) => e.type === 'concession_update'));
    const caused = foldLedger(newLedger(TRAITS), [OPEN, turn('ana', rep(1, { movedBy: { kind: 'argument' } })), turn('ana', rep(2, { movedBy: { kind: 'evidence', ref: 'c' } }))]);
    t.ok('moving back on new evidence is not tactical', !caused.emits.some((e) => e.type === 'concession_update'));
  }

  t.section('herd detection');
  {
    const herd = foldLedger(newLedger(TRAITS), [
      OPEN,
      turn('bo', rep(-1, { movedBy: { kind: 'argument', who: 'ana' } })),
      turn('cy', rep(0, { movedBy: { kind: 'argument', who: 'ana' } })),
      turn('di', rep(1, { movedBy: { kind: 'social' } })),
      { type: 'checkpoint', motionId: M, seq: 100_000 },
    ]);
    const h = flags(herd.emits, 'herd')[0];
    t.ok('three experts moving the same way with no evidence is a herd', h?.kind === 'herd' && h.direction === 1 && h.experts.join() === 'bo,cy,di', herd.emits);
    t.ok('a herd is a chair trigger', ledgerChairTriggers(herd.state, M).some((x) => x.kind === 'herd'));
    const next = reduceLedger(herd.state, { type: 'checkpoint', motionId: M, seq: 100_001 });
    t.ok('the window resets at each checkpoint', flags(next.emits, 'herd').length === 0);
    const withEv = foldLedger(newLedger(TRAITS), [
      OPEN,
      { type: 'evidence', motionId: M, seq: ++seqN, kind: 'evidence', ref: 'c_q' },
      turn('bo', rep(-1, { movedBy: { kind: 'argument' } })),
      turn('cy', rep(0, { movedBy: { kind: 'argument' } })),
      turn('di', rep(1, { movedBy: { kind: 'argument' } })),
      { type: 'checkpoint', motionId: M, seq: 100_000 },
    ]);
    t.ok('evidence in the window: not a herd', flags(withEv.emits, 'herd').length === 0);
    const cites = foldLedger(newLedger(TRAITS), [
      OPEN,
      turn('bo', rep(-1, { movedBy: { kind: 'computation', ref: 'q9' } })),
      turn('cy', rep(0, { movedBy: { kind: 'argument' } })),
      turn('di', rep(1, { movedBy: { kind: 'argument' } })),
      { type: 'checkpoint', motionId: M, seq: 100_000 },
    ]);
    t.ok('moves that cite a computation do not count toward a herd', flags(cites.emits, 'herd').length === 0);
    const two = foldLedger(newLedger(TRAITS), [OPEN, turn('bo', rep(-1)), turn('cy', rep(0)), { type: 'checkpoint', motionId: M, seq: 100_000 }]);
    t.ok('two experts are not a herd', flags(two.emits, 'herd').length === 0);
    const mixed = foldLedger(newLedger(TRAITS), [OPEN, turn('bo', rep(-1)), turn('cy', rep(0)), turn('di', rep(1)), turn('di', rep(0)), { type: 'checkpoint', motionId: M, seq: 100_000 }]);
    t.ok('someone who moved both ways in the window is not herding', flags(mixed.emits, 'herd').length === 0);
    const hard = foldLedger(newLedger(TRAITS), [
      { type: 'open', motionId: M, seq: 1, beliefs: [belief('ana', 1), belief('bo', 0), belief('cy', -1)] },
      turn('ana', rep(2)), turn('bo', rep(1)), turn('cy', rep(0)),
      { type: 'checkpoint', motionId: M, seq: 100_000 },
    ]);
    t.ok('hardening with the crowd counts as joining it', flags(hard.emits, 'herd').some((x) => x.kind === 'herd' && x.experts.length === 3), hard.emits);
    const hardEv = foldLedger(newLedger(TRAITS), [
      { type: 'open', motionId: M, seq: 1, beliefs: [belief('ana', 1), belief('bo', 0), belief('cy', -1)] },
      turn('ana', rep(2, { movedBy: { kind: 'evidence', ref: 'c' } })), turn('bo', rep(1)), turn('cy', rep(0)),
      { type: 'checkpoint', motionId: M, seq: 100_000 },
    ]);
    t.ok('a hardening that cites evidence does not count toward a herd', flags(hardEv.emits, 'herd').length === 0, hardEv.emits);
    t.ok('detectHerd is callable on any window', detectHerd(herd.state.motions[M], 0, 99_999)?.direction === 1);
  }

  t.section('drift to the middle');
  {
    const r = foldLedger(newLedger(TRAITS), [
      OPEN,
      turn('ana', rep(0, { movedBy: { kind: 'argument' } })),
      turn('bo', rep(0, { movedBy: { kind: 'evidence', ref: 'c' } })),
      { type: 'evidence', motionId: M, seq: 99, kind: 'evidence', ref: 'c' },
      { type: 'checkpoint', motionId: M, seq: 100_000 },
    ]);
    t.ok('polarisation halving is flagged', flags(r.emits, 'drift_to_middle').length === 1, r.emits);
    const again = foldLedger(r.state, [{ type: 'checkpoint', motionId: M, seq: 100_001 }]);
    t.ok('drift flagged once per motion', flags(again.emits, 'drift_to_middle').length === 0);
  }

  t.section('stated vs revealed');
  {
    const s = foldLedger(newLedger(TRAITS), [OPEN]).state;
    const r = reduceLedger(s, { type: 'audit', motionId: M, seq: 20, expert: 'cy', revealed: 1, note: 'argues for the Sunday trial' });
    t.ok('says against, argues for: flagged', flags(r.emits, 'stated_vs_revealed').length === 1);
    t.ok('a one-point gap on the same side is fine', reduceLedger(s, { type: 'audit', motionId: M, seq: 20, expert: 'ana', revealed: 1 }).emits.length === 0);
    t.ok('unknown expert is a no-op', reduceLedger(s, { type: 'audit', motionId: M, seq: 20, expert: 'zed', revealed: 1 }).emits.length === 0);
  }

  t.section('privacy and determinism');
  {
    const inputs: LedgerInput[] = [OPEN, turn('cy', rep(0, { movedBy: { kind: 'argument', who: 'ana' } })), turn('bo', rep(-1)), { type: 'checkpoint', motionId: M, seq: 200_000 }];
    const a = foldLedger(newLedger(TRAITS), inputs);
    const b = foldLedger(newLedger(TRAITS), structuredClone(inputs));
    t.ok('same inputs, same state and emits', JSON.stringify(a) === JSON.stringify(b));
    const own = ownBelief(a.state, M, 'cy');
    t.ok('ownBelief returns only that expert', own?.expert === 'cy' && !JSON.stringify(own).includes('bo crux'));
    own!.stance = 2;
    t.ok('ownBelief is a copy', a.state.motions[M].beliefs.cy.stance === 0);
    t.ok('no belief for a stranger', ownBelief(a.state, M, 'zed') === undefined && ownBelief(a.state, 'nope', 'cy') === undefined);
  }

  t.section('how minds changed (report data)');
  {
    const r = foldLedger(newLedger(TRAITS), [
      OPEN,
      { type: 'evidence', motionId: M, seq: 12, kind: 'evidence', ref: 'c_rota' },
      turn('bo', rep(-1, { movedBy: { kind: 'evidence', ref: 'c_rota' } }), 'b1'),
      turn('bo', rep(1, { movedBy: { kind: 'computation', ref: 'q_margin' } }), 'b2'),
      turn('cy', rep(0, { movedBy: { kind: 'argument', who: 'ana' } }), 'c1'),
      turn('di', rep(1), 'd1'),
    ]);
    const s = mindChanges(r.state, M, ['ana', 'bo', 'cy', 'di']);
    t.ok('experts in seat order', s.experts.map((e) => e.expert).join() === 'ana,bo,cy,di');
    const bo = s.experts.find((e) => e.expert === 'bo')!;
    t.ok('bo changed their mind: firmly against to leaning for', bo.changedMind && bo.start?.stance === -2 && bo.end?.stance === 1 && bo.net === 3, bo);
    t.ok('bo has two moves, with causes and costs', bo.moves.length === 2 && bo.moves.every((m) => m.cost.length > 0));
    t.ok('cy gave ground but did not change their mind', !s.experts.find((e) => e.expert === 'cy')!.changedMind && s.experts.find((e) => e.expert === 'cy')!.moves.length === 1);
    t.ok('ana held firm', s.heldFirm.join() === 'ana');
    t.ok('evidence that moved the room', s.evidenceThatMoved.some((e) => e.ref === 'c_rota' && e.moved.join() === 'bo'));
    t.ok('persuaders', s.persuaders.some((p) => p.who === 'ana' && p.moved.join() === 'cy'));
    t.ok('caused share counts unexplained', s.concessions === 4 && s.causes.unexplained === 1 && s.causedShare === 0.75, s);
    t.ok('open unexplained count', s.unexplainedOpen === 1);
    t.ok('polarisation start and end', s.polarisation.start === 1.25 && s.polarisation.end === 1, s.polarisation);
    const text = renderMindChanges(s, (id) => id.toUpperCase());
    t.ok('text says who changed, what moved them, what it cost', /BO changed their mind: firmly against to leaning for/.test(text) && /evidence \[c_rota\]/.test(text) && /cost: /.test(text), text);
    t.ok('text names who held firm', /Held firm: ANA\./.test(text));
    t.ok('text uses no gendered pronouns', !/\b(he|she|him|her|his|hers)\b/i.test(text));
    t.ok('text reports an unexplained move', /1 move with no recorded cause/.test(text));
    t.ok('empty motion summary', mindChanges(r.state, 'none').experts.length === 0 && renderMindChanges(mindChanges(r.state, 'none')) === 'Nobody changed position on this motion.');
  }
  return t.done();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(run() ? 1 : 0);
