/**
 * MOCK=1's live path (mock-live.ts): the real engine, scripted models, both
 * scenarios, driven from intake to complete. Proves the mock exercises the
 * live floor end to end (cut-offs, talking over, reactions, the ledger, the
 * chair on a trigger, research landing) rather than replaying a script.
 *
 *   npx tsx src/engine/mock-live.selftest.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-mocklive-test-'));
process.env.DATA_DIR = dataDir;
process.env.MOCK = '';
process.env.AGENT_CLI_PATH = '/usr/bin/false';
process.env.CHROME_PATH = 'none';
process.env.SPEAKING_PACE = '0';
delete process.env.FOUNDER_NAME;

const { wireAgents } = await import('../agents/sdk.ts');
const { wireResearch } = await import('../research/index.ts');
const { mockAgents } = await import('./mock-live.ts');
const { Engine } = await import('./runner.ts');
const { Debates, Events } = await import('../db.ts');
const { computeMetrics, fromEvents } = await import('../../../scripts/transcript-metrics.ts');
type DebateEvent = import('../../../shared/types.ts').DebateEvent;

let fails = 0;
let passes = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) passes++;
  else fails++;
  console.log(`${cond ? '  ok  ' : '  FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};

async function drive(id: string) {
  const answered = new Set<string>();
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    const r = Debates.get(id)!;
    if (['complete', 'error', 'cancelled'].includes(r.status)) break;
    const run = Engine.get(id)!;
    for (const q of r.meta.pendingClarify) if (!answered.has(q)) { answered.add(q); run.answer(q, 'Hybrids are fine'); }
    if (r.meta.pendingApproval) run.approve(r.meta.pendingApproval, 'approve');
    const q = r.meta.pendingQuestionId;
    if (q && !answered.has(q)) { answered.add(q); run.answer(q, 'No'); }
    await new Promise((res) => setTimeout(res, 10));
  }
  return { r: Debates.get(id)!, evs: Events.since(id, 0) as DebateEvent[] };
}

for (const key of ['pricing', 'library'] as const) {
  console.log(`[${key}] the real engine, scripted words, intake to complete`);
  const { fake, research } = mockAgents(key);
  wireAgents(fake);
  wireResearch(research);
  const topic = key === 'pricing' ? 'Should Halyard move new customers to usage-based pricing?' : 'Should the library close on Sundays?';
  const id = Engine.create(topic, { provider: key === 'pricing' ? 'claude' : 'openai', mode: 'directed', autonomy: 'interactive', profile: 'standard' });
  const { r, evs } = await drive(id);
  const msgs = evs.filter((e) => e.type === 'message') as Extract<DebateEvent, { type: 'message' }>[];
  ok('it reached complete, with a report', r.status === 'complete' && fs.existsSync(path.join(dataDir, 'debates', id, 'report.html')), r.status);
  ok('the panel was checked for diversity and carries reputations', evs.some((e) => e.type === 'panel' && !!(e as any).publicReputation && (e as any).diversity?.ok === true), JSON.stringify((evs.find((e) => e.type === 'panel') as any)?.diversity));
  ok('the stakes block was shown', evs.some((e) => e.type === 'system' && /^STAKES\n/.test((e as any).text)));
  ok('the floor director picked the turns: checkpoints, set pieces and replies', evs.filter((e) => e.type === 'round').length >= 2 && msgs.some((m) => m.shape === 'set_piece') && msgs.some((m) => m.shape === 'reply'));
  ok('short reactions are turns in the room', msgs.filter((m) => m.kind === 'reaction').length >= 3, String(msgs.filter((m) => m.kind === 'reaction').length));
  ok('someone talked over someone (overlap events)', msgs.some((m) => m.overlap), '');
  ok('starting stances were recorded', evs.some((e) => e.type === 'belief'));
  const conc = evs.filter((e) => e.type === 'concession').map((e: any) => e.concession);
  ok('minds changed, and each move says what moved it', conc.length >= 1 && conc.every((c) => !!c.movedBy?.kind && !!c.cost), JSON.stringify(conc));
  ok('the research desk spoke in the room with its citations', msgs.some((m) => m.kind === 'research' && /\[c_[0-9a-f]{8}\]/.test(m.text)));
  ok('the ruling carried a dissent with a tripwire', r.meta.decisions[0]?.dissents.some((d) => !!d.tripwire?.signal));
  const report = JSON.parse(fs.readFileSync(path.join(dataDir, 'debates', id, 'report.json'), 'utf8'));
  ok('the report has the stakes, how minds changed and the dissent record', !!report.stakes?.length && !!report.mindChanges?.length && !!report.minority?.length);
  const m = computeMetrics(fromEvents(id, id, evs));
  ok('the realism scorer reads it', m.expertTurns > 10 && m.realismIndex > 0, JSON.stringify({ turns: m.expertTurns, index: m.realismIndex }));
  console.log(`        realism index ${m.realismIndex} over ${m.expertTurns} expert turns (overlap ${m.overlapRate}/100, interruptions ${m.interruptionRate}/100, short turns ${m.shortTurnShare})`);
}

wireAgents(null);
wireResearch(null);
console.log(`\n${passes} passed, ${fails} failed`);
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
