/**
 * Self-tests for the evaluation kit. Offline, no model, no network.
 * --update-golden rewrites scripts/fixtures/eval-golden.json from the current code.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CRITERIA, checkJudgement, claimsFromMarkdown, compare, evaluate, judgePrompt, judgeSchema, load, modelCallRefusal, renderEvaluation, renderEvidenceAudit, ALLOW_ENV } from './eval-lib.ts';

const here = import.meta.dirname ?? '.';
const fx = (f: string) => path.resolve(here, '../fixtures', f);
let fails = 0;
const t = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  PASS  ${name}`); } catch (e) { fails++; console.log(`  FAIL  ${name}  <- ${(e as Error).message}`); }
};

const summary = (e: ReturnType<typeof evaluate>) => ({
  realismIndex: e.metrics.realismIndex,
  expertTurns: e.metrics.expertTurns,
  wordsCv: e.metrics.words.cv,
  guards: e.metrics.guards,
  rulings: e.substance.rulings,
  dissents: e.substance.dissents,
  rulingsWithOwner: e.substance.rulingsWithOwner,
  rulingsWithStopRule: e.substance.rulingsWithStopRule,
  figureTurns: e.substance.figureTurns,
  figureTurnsWithDerivation: e.substance.figureTurnsWithDerivation,
  citations: e.substance.citations,
  silentSeats: e.substance.silentSeats,
});

const before = evaluate(await load(fx('realism-baseline.json')));
const after = evaluate(await load(fx('realism-target.json')));

await t('golden: metrics and substance signals match the committed snapshot', () => {
  const golden = fx('eval-golden.json');
  const now = { baseline: summary(before), target: summary(after) };
  if (process.argv.includes('--update-golden')) fs.writeFileSync(golden, `${JSON.stringify(now, null, 2)}\n`);
  assert.deepEqual(JSON.parse(JSON.stringify(now)), JSON.parse(fs.readFileSync(golden, 'utf8')));
});

await t('the target-like fixture outscores the baseline-like one by 20+', () => {
  assert.ok(after.metrics.realismIndex > before.metrics.realismIndex + 20, `${before.metrics.realismIndex} -> ${after.metrics.realismIndex}`);
});

await t('rubric: every criterion id and name appears in docs/RUBRIC.md', () => {
  const doc = fs.readFileSync(path.resolve(here, '../../docs/RUBRIC.md'), 'utf8');
  for (const c of CRITERIA) assert.ok(doc.includes(`### ${c.id}. ${c.name}`), `${c.id} ${c.name}`);
  for (const c of CRITERIA) {
    const sect = doc.split(`### ${c.id}.`)[1]!.split('###')[0]!.split('## ')[0]!;
    for (const n of [1, 2, 3, 4, 5]) assert.ok(sect.includes(`- ${n}:`), `${c.id} lacks anchor ${n}`);
  }
});

await t('judge prompt carries rubric, metrics, rulings, transcript and the schema', async () => {
  const l = await load(fx('realism-target.json'));
  const p = judgePrompt(l, evaluate(l));
  for (const needle of ['=== RUBRIC ===', 'A1. Turn-shape variety', '=== OFFLINE METRICS', '=== FINAL RULINGS ===', 'Run a four-week', '=== TRANSCRIPT', '"title": "DebateJudgement"']) {
    assert.ok(p.includes(needle), needle);
  }
});

await t('judge prompt is deterministic', async () => {
  const l = await load(fx('realism-target.json'));
  assert.equal(judgePrompt(l, evaluate(l)), judgePrompt(l, evaluate(l)));
});

await t('schema: lists every criterion and forbids extras', () => {
  const s: any = judgeSchema();
  assert.equal(s.properties.criteria.items.properties.id.enum.length, CRITERIA.length);
  assert.equal(s.additionalProperties, false);
});

await t('checkJudgement: accepts a full answer, rejects gaps and unquoted high scores', () => {
  const full = CRITERIA.map((c) => ({ id: c.id, score: 3, quote: '', reason: 'x' }));
  assert.deepEqual(checkJudgement({ criteria: full }), []);
  assert.ok(checkJudgement({ criteria: full.slice(1) }).some((x) => x.startsWith('missing A1')));
  assert.ok(checkJudgement({ criteria: full.map((c) => (c.id === 'B3' ? { ...c, score: 5 } : c)) }).some((x) => x.includes('needs a quote')));
  assert.ok(checkJudgement({ criteria: full.map((c) => (c.id === 'B3' ? { ...c, score: 6 } : c)) }).some((x) => x.includes('1-5')));
});

await t('model calls are refused without EVAL_ALLOW_MODEL_CALLS=1, and say it uses quota', () => {
  const r = modelCallRefusal({});
  assert.ok(r && r.includes(ALLOW_ENV) && /quota/.test(r));
  assert.equal(modelCallRefusal({ [ALLOW_ENV]: '1' }), null);
  assert.ok(modelCallRefusal({ [ALLOW_ENV]: 'true' }));
});

await t('CLI: --judge-with exits 3 and sends nothing, with or without the env var', () => {
  const run = (env: Record<string, string>) => spawnSync('npx', ['tsx', path.join(here, 'eval.ts'), fx('realism-target.json'), '--judge-with'], { env: { ...process.env, ...env }, encoding: 'utf8' });
  const a = run({ EVAL_ALLOW_MODEL_CALLS: '' });
  assert.equal(a.status, 3);
  assert.ok(/quota/.test(a.stderr));
  const b = run({ EVAL_ALLOW_MODEL_CALLS: '1' });
  assert.equal(b.status, 3);
  assert.ok(/ships no model client/.test(b.stderr));
});

await t('CLI: a plain run prints a report and --compare prints a comparison', () => {
  const a = spawnSync('npx', ['tsx', path.join(here, 'eval.ts'), fx('realism-target.json')], { encoding: 'utf8' });
  assert.equal(a.status, 0, a.stderr);
  assert.ok(a.stdout.includes('Realism index'));
  const b = spawnSync('npx', ['tsx', path.join(here, 'eval.ts'), '--compare', fx('realism-baseline.json'), fx('realism-target.json')], { encoding: 'utf8' });
  assert.equal(b.status, 0, b.stderr);
  assert.ok(b.stdout.includes('Verdict: **improved**'));
});

await t('compare: old to new is improved with no guard falls; new to old is regressed', () => {
  const up = compare(before, after);
  assert.equal(up.verdict, 'improved');
  assert.deepEqual(up.guardFalls, []);
  assert.equal(compare(after, before).verdict, 'regressed');
  assert.ok(up.markdown.includes('| Realism index |'));
});

await t('compare: a guard fall blocks an "improved" verdict', () => {
  const worse = structuredClone(after);
  worse.metrics.guards!.meanTopRung = 1;
  const c = compare(before, worse);
  assert.deepEqual(c.guardFalls, ['meanTopRung']);
  assert.equal(c.verdict, 'mixed');
  assert.ok(c.markdown.includes('do not ship on the index alone'));
});

await t('load: an unknown id and a bad id fail clearly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalkit-'));
  await assert.rejects(() => load('nope', dir), /No debate "nope"/);
  await assert.rejects(() => load('../etc/passwd', dir), /not a valid debate id/);
});

await t('load: a transcript.md under data/debates/<id> works and has no guards', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalkit-'));
  fs.mkdirSync(path.join(dir, 'debates', 'abc'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'debates', 'abc', 'transcript.md'), '**Ana Ruiz:** First.\n\n**Bo Chen (interrupting):** No.\n\n**Marcus:** Go on.\n\n');
  const e = evaluate(await load('abc', dir));
  assert.equal(e.metrics.expertTurns, 2);
  assert.equal(e.metrics.guards, null);
  assert.ok(renderEvaluation(e).includes('no event log'));
});

await t('stacked panel: a silent seat is reported as a fairness signal', () => {
  const ev = [
    { type: 'panel', personas: [{ id: 'ana', name: 'Ana Ruiz', role: 'Baker', biases: 'Hates idle ovens' }, { id: 'bo', name: 'Bo Chen', role: 'Accountant', biases: 'Cash first' }] },
    { type: 'message', id: 'a', speaker: 'ana', kind: 'floor', text: 'Open Sundays, because the ovens sit cold and rent is 3 times the wage.' },
  ];
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evalkit-')), 'x.json');
  fs.writeFileSync(tmp, JSON.stringify(ev));
  return load(tmp).then((l) => {
    const e = evaluate(l);
    assert.deepEqual(e.substance.silentSeats, ['Bo Chen']);
    assert.equal(e.substance.figureTurnsWithDerivation, 1);
  });
});

await t('evidence honesty: the real 2026-10-28 run re-graded, 17 observed before, none after', async () => {
  const e = evaluate(await load(fx('real-20261028-evidence.json')));
  assert.equal(e.evidence.from, 'events');
  assert.equal(e.evidence.before.observed, 17);
  assert.equal(e.evidence.after.observed ?? 0, 0);
  assert.ok((e.evidence.after.persona ?? 0) >= 11, JSON.stringify(e.evidence.after));
  assert.ok(e.evidence.regraded.some((r) => /head baker quit after eight weeks/.test(r.text) && r.to === 'persona'));
  assert.ok(e.evidence.anecdoteTurns >= 3, String(e.evidence.anecdoteTurns));
  const md = renderEvidenceAudit(e.id, e.evidence);
  assert.ok(md.includes('| observed | 17 | 0 |') && md.includes('[observed -> persona, persona_backstory] My head baker quit'), md);
  assert.ok(renderEvaluation(e).includes('## Evidence honesty (P1 rules)'));
});

await t('evidence honesty: claims are read back from transcript.md lines, regrades included', () => {
  const md = '**Marisol Ortega:** My head baker walked.\n\n_Claims: [observed] my head baker quit after eight weeks; [assumed] Sunday needs a crew_\n\n**Priya Raghunathan:** No.\n\n_Claims: [persona; the speaker said observed] my Leeds shop never opened Sundays_\n';
  const ev = claimsFromMarkdown(md);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].speaker, 'marisolortega');
  assert.deepEqual(ev[0].claims, [{ text: 'my head baker quit after eight weeks', grade: 'observed' }, { text: 'Sunday needs a crew', grade: 'assumed' }]);
  assert.deepEqual(ev[1].claims, [{ text: 'my Leeds shop never opened Sundays', grade: 'persona', said: 'observed' }]);
});

await t('evidence honesty: --compare carries the moved-observed and anecdote rows', async () => {
  const real = evaluate(await load(fx('real-20261028-evidence.json')));
  const md = compare(real, real).markdown;
  assert.ok(md.includes('| Claims graded observed that the evidence check moves | 17 | 17 | +0 |'), md);
  assert.ok(md.includes('| Expert turns telling a first-person anecdote as fact |'), md);
});

await t('CLI: --evidence prints the before/after table', () => {
  const a = spawnSync('npx', ['tsx', path.join(here, 'eval.ts'), fx('real-20261028-evidence.json'), '--evidence'], { encoding: 'utf8' });
  assert.equal(a.status, 0, a.stderr);
  assert.ok(a.stdout.includes('| observed | 17 | 0 |'), a.stdout);
});

console.log(fails ? `${fails} failed` : 'all eval self-tests passed');
process.exit(fails ? 1 : 0);
