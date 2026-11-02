/**
 * Mock engine v2: the scripted scenarios, replayed offline.
 *
 *   npx tsx src/engine/mock-v2.selftest.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-mockv2-test-'));
process.env.DATA_DIR = dataDir;
process.env.MOCK = '1';
process.env.MOCK_SPEED = 'max';
process.env.FOUNDER_NAME = 'Dana';
process.env.CHROME_PATH = 'none';
delete process.env.MOCK_SCENARIO;

const { compileScenario, citationId, stakesBlock } = await import('./mock-v2.ts');
const { SCENARIOS } = await import('./mock-scenarios.ts');
const { MockEngine } = await import('./mock.ts');
const { Events } = await import('../db.ts');
type Provider = 'claude' | 'openai' | 'codex';

let failed = 0;
function ok(cond: unknown, name: string, detail = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

const providers: Provider[] = ['claude', 'openai', 'codex'];
const evs = (c: ReturnType<typeof compileScenario>) => c.steps.filter((s) => s.k === 'pub').map((s: any) => s.ev);

for (const key of Object.keys(SCENARIOS)) {
  console.log(`scenario ${key}`);
  const scn = SCENARIOS[key];
  const a = compileScenario(scn, { seed: 'mockv2', provider: 'claude', founder: 'Dana' });
  const b = compileScenario(scn, { seed: 'mockv2', provider: 'claude', founder: 'Dana' });
  const c = compileScenario(scn, { seed: 'other', provider: 'claude', founder: 'Dana' });
  ok(JSON.stringify(a.steps) === JSON.stringify(b.steps), 'same seed replays identically');
  ok(JSON.stringify(a.steps) !== JSON.stringify(c.steps), 'different seed differs');
  ok(a.declinedCuts.length === 0, 'no declined cuts on the default seed', JSON.stringify(a.declinedCuts));
  ok(Object.keys(a.fights).length >= 1, 'at least one floor fight');

  const events = evs(a);
  const types = new Set(events.map((e: any) => e.type));
  for (const t of ['message', 'aside', 'pause', 'floor', 'concession', 'research_started', 'research_done', 'decision', 'motion_closed']) {
    ok(types.has(t), `emits ${t}`);
  }
  ok(a.steps.some((s) => s.k === 'belief'), 'emits belief');
  const msgs = events.filter((e: any) => e.type === 'message');
  ok(msgs.some((m: any) => m.cutOff), 'has a cut-off');
  ok(msgs.some((m: any) => m.overlap), 'has an overlap');
  ok(msgs.some((m: any) => m.kind === 'reaction'), 'has a short reaction');

  for (const m of msgs.filter((m: any) => m.cutOff)) {
    ok(m.cutOff.atChar === m.text.length, `cutOff.atChar matches text length (${m.id})`);
    ok(msgs.some((o: any) => o.speaker === m.cutOff.by && o.overlap), `cut-in by ${m.cutOff.by} exists (${m.id})`);
    ok(!m.cutOff.resumedBy || msgs.some((o: any) => o.id === m.cutOff.resumedBy), `resume ref exists (${m.id})`);
  }
  const ids = new Set(msgs.map((m: any) => m.id));
  for (const m of msgs.filter((m: any) => m.overlap)) ok(ids.has(m.overlap.with), `overlap target exists (${m.id})`);

  const asides = events.filter((e: any) => e.type === 'aside');
  const transcript = a.steps.filter((s) => s.k === 'transcript').map((s: any) => s.line).join('\n');
  for (const x of asides) {
    ok(!transcript.includes(x.text), 'aside text is not in the transcript');
    ok(!msgs.some((m: any) => m.text.includes(x.text)), 'aside text is not in any message');
  }

  const conc = events.filter((e: any) => e.type === 'concession');
  ok(conc.some((e: any) => e.concession.movedBy.kind === 'unexplained'), 'has an unexplained concession');
  ok(conc.some((e: any) => e.concession.movedBy.kind !== 'unexplained'), 'has a caused concession');
  events.forEach((e: any, i: number) => {
    if (e.type === 'concession' && e.concession.movedBy.kind === 'unexplained') {
      const next = events.slice(i + 1).find((x: any) => x.type === 'message' && x.speaker !== e.concession.expert);
      ok(next && next.speaker === 'marcus', 'unexplained concession is followed by the chair');
    }
  });

  if (key === 'pricing') ok(a.steps.some((s) => s.k === 'limit_pause'), 'has a simulated quota pause');
  const decision = events.find((e: any) => e.type === 'decision');
  ok(decision && decision.decision.dissents.length >= 1, 'decision carries a dissent');
  ok(scn.stakes && stakesBlock(scn.stakes, 'Dana').startsWith('STAKES') && scn.stakes.ifWrong.yes && scn.stakes.ifWrong.no, 'stakes block present');

  const shapes: Record<string, any> = {};
  for (const p of providers) {
    const run = compileScenario(scn, { seed: 'mockv2', provider: p, founder: 'Dana' });
    const rd = evs(run).find((e: any) => e.type === 'research_done');
    const r = rd?.result;
    ok(r && r.citations.length >= 2, `${p}: research has citations`);
    ok(r && r.spoken.split(/\s+/).length <= 60, `${p}: spoken summary is at most 60 words`);
    ok(r && r.findings.every((f: any) => f.citationIds.every((id: string) => r.citations.some((cc: any) => cc.id === id))), `${p}: finding citations resolve`);
    ok(r && r.citations.every((cc: any) => cc.id === citationId(cc.url)), `${p}: citation ids derive from url`);
    shapes[p] = r?.citations.map((cc: any) => `${cc.provenance}:${cc.quote ? 'q' : '-'}`).join(',');
    const spokenMsg = evs(run).filter((e: any) => e.type === 'message' && e.speaker === 'research').map((m: any) => m.text).join(' ');
    ok(r && [...r.spoken.matchAll(/\[(c_[0-9a-f]{4})\]/g)].every((m) => r.citations.some((cc: any) => cc.id === m[1])), `${p}: spoken markers resolve`);
    ok(spokenMsg.length > 0, `${p}: research desk speaks`);
  }
  ok(new Set(Object.values(shapes)).size === 3, 'citation shapes differ across claude/openai/codex', JSON.stringify(shapes));
}

async function runEngine(topic: string, scenario?: string, stopAtFirstMessage = false) {
  if (scenario) process.env.MOCK_SCENARIO = scenario; else delete process.env.MOCK_SCENARIO;
  const id = MockEngine.create(topic, { provider: 'claude', mode: 'directed', autonomy: 'autonomous', profile: 'standard' });
  const run: any = MockEngine.get(id);
  const answered = new Set<string>();
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    const all = Events.since(id, 0) as any[];
    for (const e of all) {
      if (e.type === 'clarify' && !answered.has(e.questionId)) { answered.add(e.questionId); run.answer(e.questionId, e.options?.[0] ?? 'ok'); }
      if (e.type === 'question' && e.questionId && !answered.has(e.questionId)) { answered.add(e.questionId); run.answer(e.questionId, 'Go with your assumption.'); }
    }
    if (stopAtFirstMessage && all.some((e) => e.type === 'message')) { run.kill(); return all; }
    if (all.some((e) => e.type === 'status' && (e.status === 'complete' || e.status === 'error'))) return all;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('timed out waiting for complete');
}

for (const key of ['pricing', 'library']) {
  console.log(`end to end: ${key}`);
  const all = await runEngine(`engine test ${key}`, key);
  const last = [...all].reverse().find((e: any) => e.type === 'status') as any;
  ok(last?.status === 'complete', 'reaches complete', JSON.stringify(last));
  ok(!all.some((e: any) => e.type === 'error'), 'no error events');
  ok(all.some((e: any) => e.type === 'budget'), 'budget events persisted');
  ok(all.some((e: any) => e.type === 'system' && String(e.text).startsWith('STAKES')), 'stakes block shown in the room');
  if (key === 'pricing') {
    const stat = all.filter((e: any) => e.type === 'status').map((e: any) => e.status);
    ok(stat.includes('paused'), 'quota pause happened');
    ok(stat.lastIndexOf('meeting') > stat.indexOf('paused'), 'resumed to meeting after the pause');
  }
  ok(!all.some((e: any) => e.type === 'message' && /whisper|aside/i.test(e.kind ?? '')), 'asides are not messages');
}

console.log('legacy mock stays reachable');
{
  const all = await runEngine('legacy test', 'legacy', true);
  ok(all.some((e: any) => e.type === 'message'), 'legacy script reaches the meeting');
  ok(!all.some((e: any) => e.type === 'floor'), 'legacy emits no floor events');
}

fs.rmSync(dataDir, { recursive: true, force: true });
if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nmock-v2 selftest passed');
process.exit(0);
