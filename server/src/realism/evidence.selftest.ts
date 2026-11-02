/**
 * Evidence honesty (P1): the regrade, the anecdote finder, the ruling grade
 * and the report labels. Fixtures are drawn from the real run of 2026-10-28
 * (scripts/fixtures/real-20261028-evidence.json). Pure, offline.
 *   npx tsx src/realism/evidence.selftest.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { suite } from './check.ts';
import {
  anecdotes, claimTag, indexProvenance, labelPersonaDerived, personaClaims, regradeClaim, regradeClaims, regradeLog, rulingGrade,
  tracesToFounder, PERSONA_LABEL, type Provenance,
} from './evidence.ts';
import type { ReportData } from '../../../shared/report-types.ts';

const here = import.meta.dirname ?? '.';
export const REAL = JSON.parse(fs.readFileSync(path.resolve(here, '../../../scripts/fixtures/real-20261028-evidence.json'), 'utf8'));
const panel = REAL.events.find((e: any) => e.type === 'panel').personas.filter((p: any) => !p.isModerator);
const nameOf = (id: string) => panel.find((p: any) => p.id === id)?.name ?? id;

export const realProvenance = (): Provenance => ({
  founder: [REAL.topic, ...Object.values(REAL.clarifyAnswers as Record<string, string>), REAL.contextBrief ?? ''],
  citations: REAL.citations,
  measured: REAL.computations > 0,
  panel: panel.map((p: any) => p.name),
});

export function run(): number {
  const t = suite('evidence honesty (P1)');
  const prov = realProvenance();

  t.section('the real transcript, re-graded');
  const log = regradeLog(REAL.events, prov);
  const said = log.filter((r) => r.before.grade === 'observed');
  const after = log.filter((r) => r.after.grade === 'observed');
  t.ok('the real run graded 17 claims observed', said.length === 17, said.length);
  t.ok('none of them survives: none was the founder\'s or a cited finding', after.length === 0, after.map((r) => r.before.text));
  t.ok('at least 11 are the panelists\' own backstory, graded persona', log.filter((r) => r.after.grade === 'persona').length >= 11, log.filter((r) => r.after.grade === 'persona').length);
  const grade = (needle: string) => log.find((r) => r.before.text.includes(needle))?.after.grade;
  t.ok('"My head baker quit after eight weeks" is persona', grade('My head baker quit after eight weeks of covering Sunday bakes') === 'persona');
  t.ok('"my busiest Bristol counter never sees ... 360" is persona', grade('my busiest Bristol counter never sees anywhere near 360') === 'persona');
  t.ok('"pre-dawn bakers in shops I\'ve run ... 4am" is persona', grade("pre-dawn bakers in shops I've run") === 'persona');
  t.ok('"Marisol\'s Saturday sell-outs were at her own shop" (a panelist named) is persona', grade("Marisol's Saturday sell-outs were at her own shop") === 'persona');
  t.ok('a colleague repeating the head-baker story is still persona', log.find((r) => r.before.text === 'a head baker quit after eight weeks of covering Sunday bakes')?.reason === 'echoes_persona');
  t.ok('"the bakery has no float staff" (nobody told the room that) is assumed', grade('the bakery has no float staff') === 'assumed');
  t.ok('the 132 assumed claims are left alone', log.filter((r) => r.before.grade === 'assumed').every((r) => r.after.grade === 'assumed' && !r.reason));
  t.ok('a regraded claim keeps the speaker\'s grade in "said"', log.filter((r) => r.reason).every((r) => r.after.said === 'observed'));

  t.section('what observed may still mean');
  const keep = (text: string, p: Provenance = prov) => regradeClaim({ text, grade: 'observed' }, p).claim.grade;
  t.ok('a fact from the founder\'s brief stays observed', keep('two of the four staff already work six days a week') === 'observed');
  t.ok('the same fact told as the speaker\'s own is persona', keep('two of my four staff already work six days a week') === 'persona');
  t.ok('a figure the founder never gave does not trace', keep('two of the four staff already work seven days a week') === 'assumed');
  t.ok('a finding cited by a real id stays observed', keep('an opt-out cannot waive the 8-hour night-work average, per c_b7408307') === 'observed');
  t.ok('an invented citation id does not', keep('an opt-out cannot waive the night-work average, per c_deadbeef') === 'assumed');
  t.ok('a founder answer counts as founder input', keep('Saturday sells out of sourdough by ten', { ...prov, founder: [...prov.founder, 'We sell out of sourdough by ten every Saturday.'] }) === 'observed');
  t.ok('two shared words are not a trace', !tracesToFounder('staff morale collapses on Sundays', indexProvenance(prov)));

  t.section('measured, persona and the rest');
  t.ok('measured with nothing computed this session is assumed', regradeClaim({ text: 'refunds ran 9% of Q3 revenue', grade: 'measured' }, prov).claim.grade === 'assumed');
  t.ok('measured with a computation stands', regradeClaim({ text: 'refunds ran 9% of Q3 revenue', grade: 'measured' }, { ...prov, measured: true }).claim.grade === 'measured');
  t.ok('measured about the speaker\'s own tills is persona', regradeClaim({ text: 'my tills showed refunds at 9%', grade: 'measured' }, { ...prov, measured: true }).claim.grade === 'persona');
  t.ok('a claim the speaker graded persona stays persona', regradeClaim({ text: 'my head baker quit', grade: 'persona' }, prov).claim.grade === 'persona');
  t.ok('mixed is left to the speaker', regradeClaim({ text: 'my tills and the brief agree', grade: 'mixed' }, prov).claim.grade === 'mixed');
  t.ok('no claims, nothing to do', regradeClaims(undefined, prov) === undefined);
  t.ok('the record shows a regrade', claimTag({ text: 'x', grade: 'persona', said: 'observed' }) === '[persona; the speaker said observed]' && claimTag({ text: 'x', grade: 'assumed' }) === '[assumed]');

  t.section('first-person anecdote told as fact');
  const flagged = REAL.events.filter((e: any) => e.type === 'message' && e.kind !== 'research' && e.speaker !== 'marcus' && anecdotes(e.text).length);
  t.ok('the real run has persona anecdotes in speech, all from the operator persona', flagged.length >= 3 && flagged.every((e: any) => e.speaker === 'marisol'), flagged.map((e: any) => e.speaker));
  t.ok('"I lost my head baker" is an anecdote', anecdotes("The bad one leaned on Saturday people, and that's how I lost my head baker.").length === 1);
  t.ok('"in shops I\'ve run" is an anecdote', anecdotes("In shops I've run, bakers start at four.").length === 1);
  t.ok('"at my last shop" is an anecdote', anecdotes('Returns ran nine percent at my last shop.').length === 1);
  t.ok('"my numbers", "my point", "I ran the numbers" are not', anecdotes("On my numbers Sunday fails. That's my point. I ran the numbers twice.").length === 0);
  t.ok('a question to a colleague is not', anecdotes('Priya, your 450 to 600 pounds: is that weekday rate?').length === 0);

  t.section('the ruling\'s grade');
  t.ok('observed with nothing observed under it is assumed', rulingGrade('observed', [{ text: 'my head baker quit', grade: 'persona', said: 'observed' }], false, false) === 'assumed');
  t.ok('observed on a surviving observed claim stands', rulingGrade('observed', [{ text: 'two staff work six days', grade: 'observed' }], false, false) === 'observed');
  t.ok('observed on the founder\'s own answer stands', rulingGrade('observed', [], true, false) === 'observed');
  t.ok('measured with nothing computed is assumed', rulingGrade('measured', [], false, false) === 'assumed' && rulingGrade('measured', [], false, true) === 'measured');
  t.ok('a ruling is never graded persona', rulingGrade('persona', [], true, true) === 'assumed');

  t.section('the report: trails and the audit label persona-derived numbers');
  const graded = REAL.events.map((e: any) => (e.type === 'message' && e.claims ? { ...e, claims: e.claims.map((c: any) => regradeLog([{ ...e, claims: [c] }], prov)[0].after) } : e));
  const pcs = personaClaims(graded, nameOf);
  t.ok('the persona claims are listed once each, named', pcs.length >= 9 && pcs.every((p) => p.expert && p.expert !== 'marisol'), pcs.length);
  const rulings = REAL.events.filter((e: any) => e.type === 'decision').map((e: any) => e.decision);
  const ix = indexProvenance({ ...prov, founder: [...prov.founder, ...REAL.researchSummaries] });
  const report = {
    title: 't', decisions: rulings.map((d: any) => ({ topic: d.motionTitle, conclusion: d.decision, proposedBy: 'x', supportedBy: [], challengedBy: [], resolution: d.rationale, dependsOn: d.dependsOn })),
    numbersAudit: { checked: 2, summary: 's', findings: [
      { figure: 'Marisol: my busiest Bristol counter never saw a third of 360 asks on a Saturday', verdict: 'uncheckable', recomputed: 'no files', impact: 'the demand test threshold' },
      { figure: 'UK adult minimum wage is £12.71 an hour', verdict: 'holds', recomputed: '£12.71', impact: '' },
    ] },
  } as unknown as ReportData;
  const out = labelPersonaDerived(report, pcs, ix);
  const motion2 = out.decisions.find((d) => /six-day pattern/i.test(d.topic))!;
  t.ok('the real ruling resting on "Marisol\'s 4am-to-noon" gets an assumption line', motion2.dependsOn.some((d) => d.startsWith(PERSONA_LABEL) && d.includes('4am')), motion2.dependsOn);
  const motion1 = out.decisions.find((d) => /Sunday opening/i.test(d.topic))!;
  t.ok('the real ruling citing "a repeat of Marisol\'s head baker walking out" gets the head-baker story', motion1.dependsOn.some((d) => d.startsWith(PERSONA_LABEL) && /head baker quit after eight weeks/.test(d)), motion1.dependsOn);
  t.ok('and nothing about the Bristol counter, which it does not rest on', !motion1.dependsOn.some((d) => /Bristol/.test(d)), motion1.dependsOn);
  const plain = labelPersonaDerived({ ...report, decisions: [{ topic: 'x', conclusion: 'Count six Saturdays of sell-out times and asks at the counter before any trial.', proposedBy: 'x', supportedBy: [], challengedBy: [], resolution: 'UK rest rules apply [c_b7408307].', dependsOn: [] }] }, pcs, ix);
  t.ok('a trail on the same subject that rests on no persona claim is untouched', plain.decisions[0].dependsOn.length === 0, plain.decisions[0].dependsOn);
  t.ok('the audit row built on the Bristol counter says it is an assumption', out.numbersAudit!.findings[0].origin === 'persona' && out.numbersAudit!.findings[0].impact.startsWith(PERSONA_LABEL));
  t.ok('the wage row, from research, is not', !out.numbersAudit!.findings[1].origin);
  t.ok('the persona claims ride on the report', out.personaClaims?.length === pcs.length);
  t.ok('labelling twice adds nothing', JSON.stringify(labelPersonaDerived(out, pcs, ix).decisions) === JSON.stringify(out.decisions));
  t.ok('no persona claims, the report is untouched', labelPersonaDerived(report, [], ix) === report);
  return t.done();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(run() ? 1 : 0);
