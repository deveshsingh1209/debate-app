/**
 * Session length per profile (plan P2) and founder pause/resume (plan P4),
 * through a real DebateRun on scripted models. Offline: a fake behind the
 * wireAgents seam stands in for every model, a throwaway DATA_DIR for ./data.
 *
 *   npx tsx src/engine/flow.selftest.ts
 *
 * The length replay drives the referee with the judgments the real referee
 * made in the 2026-10-28 Quick run (d_R8dL2LGj, from the `round` events in
 * _backups/real-completed-20261028/debate.db), and the chair adds a second
 * motion mid-motion as he did there. On the old engine that run argued its
 * first motion for nine checkpoints and 132 messages.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-flow-test-'));
process.env.DATA_DIR = dataDir;
process.env.MOCK = '';
process.env.AGENT_CLI_PATH = '/usr/bin/false';
process.env.CHROME_PATH = 'none';
process.env.FOUNDER_NAME = 'Dana';
process.env.SPEAKING_PACE = '0';
delete process.env.OPENAI_API_KEY;

const { wireAgents } = await import('../agents/sdk.ts');
const { Engine } = await import('./runner.ts');
const { Debates, Events } = await import('../db.ts');
const { sampleReport } = await import('../report/sample.ts');
const { BUDGET_PROFILES, adversaryTurns } = await import('../../../shared/budget.ts');
type AgentTurnOpts = import('../agents/sdk.ts').AgentTurnOpts;
type DebateEvent = import('../../../shared/types.ts').DebateEvent;

let fails = 0;
let passes = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) passes++;
  else fails++;
  console.log(`${cond ? '  ok  ' : '  FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};

// ---------- the real run's referee, checkpoint by checkpoint ----------

type Verdict = { fresh: number; rung: number; momentum: 'climbing' | 'circling' | 'exhausted'; ready?: boolean };
/** Motion 1 of d_R8dL2LGj: fresh arguments, rung and momentum as the round notes recorded them. */
const REAL_RUN: Verdict[] = [
  { fresh: 7, rung: 1, momentum: 'climbing' },
  { fresh: 12, rung: 2, momentum: 'climbing' },
  { fresh: 9, rung: 3, momentum: 'climbing' },
  { fresh: 7, rung: 4, momentum: 'climbing' },
  { fresh: 8, rung: 4, momentum: 'climbing' },
  { fresh: 6, rung: 4, momentum: 'circling' },
  { fresh: 5, rung: 4, momentum: 'climbing' },
  { fresh: 5, rung: 4, momentum: 'circling' },
  { fresh: 3, rung: 4, momentum: 'exhausted', ready: true },
];
/** A short, settled motion: climbing, then circling at the round target. For the pause tests, whose round count must not depend on message counts. */
const SETTLES: Verdict[] = [
  { fresh: 4, rung: 2, momentum: 'climbing' },
  { fresh: 2, rung: 3, momentum: 'circling', ready: true },
];

// ---------- the scripted room ----------

const PANEL = [
  { id: 'ana', name: 'Ana Ruiz', role: 'Bakery operator', bio: 'Ran three bakeries.', expertise: ['ops'], personality: 'Blunt.', biases: 'Hates idle ovens.', style: 'Short.', color: '#22d3ee', initials: 'AR' },
  { id: 'bo', name: 'Bo Chen', role: 'Labour economist', bio: 'Studies small-shop staffing.', expertise: ['labour'], personality: 'Careful.', biases: 'Protects staff.', style: 'Numbers.', color: '#a78bfa', initials: 'BC' },
  { id: 'cy', name: 'Cy Okafor', role: 'Local retail analyst', bio: 'Tracks high-street footfall.', expertise: ['footfall'], personality: 'Dry.', biases: 'Trusts data.', style: 'Plain.', color: '#34d399', initials: 'CO' },
];

interface Script {
  referee: Verdict[];
  /** At this check-in (1-based count of steer calls) the chair adds a second motion. */
  addMotionAtSteer?: number;
  /** Pause the session inside the call that matches; `after` skips that many matching calls first. */
  pauseOn?: { match: (label: string, d: DebateState) => boolean };
}
interface DebateState {
  calls: string[];
  referee: number;
  steer: number;
  redteamed: boolean;
  defeatersOut: boolean;
  floorSinceRedteam: number;
  paused: boolean;
  spoken: number;
}
const scripts = new Map<string, Script>();
const states = new Map<string, DebateState>();
/** The script for the next Engine.create, claimed by its first call. */
let nextScript: Script | null = null;
const stateOf = (id: string): DebateState => {
  let s = states.get(id);
  if (!s) {
    s = { calls: [], referee: 0, steer: 0, redteamed: false, defeatersOut: false, floorSinceRedteam: 0, paused: false, spoken: 0 };
    states.set(id, s);
    if (nextScript) { scripts.set(id, nextScript); nextScript = null; }
  }
  return s;
};

function dossierJson(id: string): any {
  const voice: Record<string, any> = {
    ana: { register: 'clipped', typicalWords: 45, vocabulary: ['proof', 'batch', 'oven', 'shift', 'crumb'], tics: [{ text: 'mind you', maxPerMotion: 1 }], neverSay: [] },
    bo: { register: 'technical', typicalWords: 140, vocabulary: ['elasticity', 'rota', 'attrition', 'overtime', 'regression'], tics: [{ text: 'mind you', maxPerMotion: 1 }], neverSay: [] },
    cy: { register: 'dry', typicalWords: 80, vocabulary: ['footfall', 'dwell', 'catchment', 'clicker', 'baseline'], tics: [{ text: 'mind you', maxPerMotion: 1 }], neverSay: [] },
  };
  const lean: Record<string, number> = { ana: 1, bo: -1, cy: 0 };
  const stub: Record<string, number> = { ana: 0.3, bo: 0.8, cy: 0.55 };
  return {
    history: [
      { when: '2015', what: `${id} failure one`, lesson: 'lesson one', kind: 'failure' },
      { when: '2018', what: `${id} failure two`, lesson: 'lesson two', kind: 'failure' },
      { when: '2021', what: `${id} win`, lesson: 'lesson three', kind: 'win' },
    ],
    blindSpots: [`${id} blind spot`],
    temperament: { heatGain: 0.3, heatDecay: 0.1, interruptThreshold: 0.6, dominance: id === 'ana' ? 0.7 : 0.4 },
    relationships: [],
    publicReputation: `${id} is known for ${id} things.`,
    incentives: [`${id} incentive one`, `${id} incentive two`],
    goalLean: lean[id],
    biases: [{ name: `${id} bias`, showsUpAs: `${id} habit` }],
    stubbornness: stub[id],
    speech: voice[id],
    underPressure: `${id} under pressure`,
  };
}

function json(label: string, d: DebateState, script: Script | undefined): any {
  if (label === 'intake' || label === 'intake:auto') {
    return { clear: true, title: 'SUNDAY BAKERY', goal: 'Decide whether the bakery opens on Sundays.', complexity: { decisions: 1, disciplines: 3, depth: 'standard', rationale: 'One call.' }, stakes: { atRisk: { money: 'a lease' } } };
  }
  const dossier = label.match(/^(\w+):dossier/);
  if (dossier) return dossierJson(dossier[1]);
  if (label === 'relationships') return { relationships: {} };
  if (label === 'clerk:stances') return { stances: [{ expert: 'ana', stance: 1, confidence: 'medium', crux: 'demand' }, { expert: 'bo', stance: -1, confidence: 'medium', crux: 'staff' }, { expert: 'cy', stance: 0, confidence: 'low', crux: 'footfall' }] };
  if (label === 'architect') return { personas: PANEL, rationale: 'Ops, labour, demand.', research_questions: [] };
  if (label === 'research:crux') return { hits: [] };
  if (label === 'marcus:plan') return { say: 'One motion today.', plan_update: { items: [{ id: 'm1', title: 'Sunday opening', motion: 'The bakery should open on Sundays.', detail: 'Staff are stretched.', status: 'pending' }], rationale: 'One decision.' } };
  if (label.endsWith(':position') || label.endsWith(':position:contrarian')) return { thesis: 'A thesis.', load_bearing_claims: ['claim'], red_line: 'never this', falsifier: 'this would flip me', who_i_expect_to_be_wrong: 'bo' };
  if (label === 'cards:consensus') return { consensus: false };
  if (label === 'referee') {
    const seq = script?.referee ?? REAL_RUN;
    const v = seq[Math.min(d.referee++, seq.length - 1)];
    return {
      fresh_arguments: Array.from({ length: v.fresh }, (_, i) => `point ${d.referee}.${i}`),
      position_changes: [], unresolved: [], rung: v.rung, rung_reason: 'as the real referee read it', missing_expertise: null,
      ready_to_decide: !!v.ready, next_pressure: null, momentum: v.momentum,
    };
  }
  if (label === 'marcus:steer') {
    d.steer++;
    const add = script?.addMotionAtSteer === d.steer;
    return {
      say: null, why: 'quiet check-in', nudge: null, research: null, compute: null, reopen: null, ask_user: null, assumption: null,
      plan_update: add ? { items: [{ id: 'm2', title: 'Fix the six-day pattern first', motion: 'Before any Sunday trial the six-day rota is fixed.', detail: 'A precondition the room surfaced.', status: 'added' }], rationale: 'A separate, decidable precondition.' } : null,
    };
  }
  if (label === 'react') {
    // Two listeners with something to say, so the room reacts about as often as the real one did (44 reactions to 62 turns).
    return { reactions: [
      { listener: 'bo', intensity: 2, atSentence: 1, cutIn: null, backchannel: 'Not on those numbers.', wantsFloor: true },
      { listener: 'cy', intensity: 2, atSentence: 1, cutIn: null, backchannel: 'On what base?', wantsFloor: false },
      { listener: 'ana', intensity: 2, atSentence: 1, cutIn: null, backchannel: 'The ovens sit idle.', wantsFloor: true },
    ] };
  }
  if (label === 'marcus:ruling') {
    return { say: null, decision: { decision: 'Open on Sundays for a six-week trial.', owner: 'Dana', rationale: 'Footfall supports it.', evidence: 'mixed', dependsOn: [], dissents: [] } };
  }
  if (label === 'redteam:1' && !d.redteamed) {
    // The first ruling in the session is attacked and something concrete lands: the room gets its adversary round.
    d.redteamed = true;
    d.defeatersOut = true;
    return { defeaters: [{ claim: 'The trial cost leaves out the Sunday premium.', arithmetic: '6 Sundays x 2 staff x 8h x 1.5', consequence: 'The trial loses money.', severity: 'material' }] };
  }
  if (label.startsWith('redteam')) return { defeaters: [] };
  if (label === 'report') return sampleReport;
  throw new Error(`no scripted JSON reply for "${label}"`);
}

function speech(label: string, d: DebateState): string {
  const [who, kind] = label.split(':');
  if (who === 'marcus') return 'Cy, where does the footfall land?';
  if (kind === 'closing') return `${who} closes: open on Sundays only with a rota.\nSTANCE: for+1 | confidence: high`;
  const n = ++d.spoken;
  return `${who} on the floor, take ${n}. Sunday trade is real but the rota decides it. Fresh figure ${n}: shift ${n}a costs ${n}b, cover ${n}c, margin ${n}d.\nSTANCE: against-1 | confidence: low | crux: staff`;
}

const rewriteOf = (prompt: string) => prompt.split('THE TURN:\n')[1] ?? '';

/** Pause from inside the call that matches the script: the call is in flight and finishes after the founder pressed Pause. */
function maybePause(debateId: string, label: string, d: DebateState): boolean {
  const s = scripts.get(debateId);
  if (!s?.pauseOn || d.paused) return false;
  if (!s.pauseOn.match(label, d)) return false;
  d.paused = true;
  pausedAt.set(debateId, { label, seq: Events.lastSeq(debateId) });
  Engine.get(debateId)!.pause();
  return true;
}
const pausedAt = new Map<string, { label: string; seq: number }>();
/** The opening words of the speech being written when Pause was pressed. */
const inFlightText = new Map<string, string>();

wireAgents({
  async run(opts: AgentTurnOpts) {
    const id = opts.debateId ?? '';
    const d = stateOf(id);
    const label = opts.label ?? '';
    d.calls.push(label);
    if (/^(ana|bo|cy):floor$/.test(label) && d.defeatersOut) d.floorSinceRedteam++;
    const pausing = maybePause(id, label, d);
    const text = label.endsWith(':lint') ? rewriteOf(opts.prompt) : speech(label, d);
    if (pausing) inFlightText.set(id, text.split('.')[0] + '.');
    return { text, sessionId: null, costUsd: 0.05, usage: { input: 1000, output: 150, cacheWrite: 0, cacheRead: 2000 }, toolCalls: [] };
  },
  async runJson(opts: AgentTurnOpts) {
    const id = opts.debateId ?? '';
    const d = stateOf(id);
    const label = opts.label ?? '';
    d.calls.push(label);
    maybePause(id, label, d);
    return { value: json(label, d, scripts.get(id)), sessionId: null, usage: { input: 1000, output: 150, cacheWrite: 0, cacheRead: 2000 }, costUsd: 0.08 };
  },
});

// ---------- driving ----------

interface PauseObservation {
  status: string;
  resumeTo: string | undefined;
  checkpoint: any;
  closedMotions: string[];
  eventsAtSettle: number;
  eventsBeforeResume: number;
  /** Anything the room published between the in-flight call settling and Resume. */
  publishedWhilePaused: DebateEvent[];
}

/** Approve every gate; when the session is paused, let it settle, look, then press Resume. */
async function drive(id: string, opts: { onPaused?: (o: PauseObservation) => void } = {}) {
  const t0 = Date.now();
  let observed = false;
  while (Date.now() - t0 < 90_000) {
    const r = Debates.get(id)!;
    if (['complete', 'error', 'cancelled'].includes(r.status)) break;
    const run = Engine.get(id)!;
    if (r.status === 'paused' && !observed) {
      observed = true;
      // The in-flight call finishes and the room comes to rest: wait until nothing more is published.
      let last = -1;
      for (let i = 0; i < 200; i++) {
        await new Promise((res) => setTimeout(res, 20));
        const n = Events.lastSeq(id);
        if (n === last) break;
        last = n;
      }
      const settled = Events.lastSeq(id);
      await new Promise((res) => setTimeout(res, 150));   // a while longer: a paused room says nothing
      const row = Debates.get(id)!;
      opts.onPaused?.({
        status: row.status,
        resumeTo: row.meta.founderPause?.resumeTo,
        checkpoint: row.meta.motionCheckpoint ? structuredClone(row.meta.motionCheckpoint) : null,
        closedMotions: [...row.meta.closedMotions],
        eventsAtSettle: settled,
        eventsBeforeResume: Events.lastSeq(id),
        publishedWhilePaused: Events.since(id, settled),
      });
      ok(`${id}: Resume is accepted`, run.resumeMeeting());
      continue;
    }
    if (r.status !== 'paused' && r.meta.pendingApproval) run.approve(r.meta.pendingApproval, 'approve');
    await new Promise((res) => setTimeout(res, 10));
  }
  const r = Debates.get(id)!;
  const evs: DebateEvent[] = Events.since(id, 0);
  return { r, evs };
}

const of = <T extends DebateEvent['type']>(evs: DebateEvent[], t: T) => evs.filter((e): e is Extract<DebateEvent, { type: T }> => e.type === t);
const messages = (evs: DebateEvent[]) => of(evs, 'message');

function create(script: Script, profile: 'quick' | 'standard' | 'deep', topic: string) {
  nextScript = script;
  const id = Engine.create(topic, { provider: 'claude', mode: 'directed', autonomy: 'interactive', profile });
  stateOf(id);
  return id;
}

// ---------- P2: the real run, replayed on each profile ----------

console.log('[P2] the 2026-10-28 Quick run replayed: length per profile');
const lengths: Record<string, number> = {};
{
  // One motion, as the session was planned.
  const id = create({ referee: REAL_RUN }, 'quick', 'Should our bakery open on Sundays? (quick, one motion)');
  const { r, evs } = await drive(id);
  const n = messages(evs).length;
  lengths.quick1 = n;
  const rounds = of(evs, 'round');
  ok('quick, one motion: complete', r.status === 'complete', r.status);
  ok(`quick, one motion: 40-60 spoken messages in total (${n}; the real run spoke 145)`, n >= 40 && n <= 60, String(n));
  ok(`quick, one motion: at most ${BUDGET_PROFILES.quick.length.maxRounds} checkpoints before the adversary's round (${rounds.length})`, rounds.length >= 2 && rounds.length <= BUDGET_PROFILES.quick.length.maxRounds, String(rounds.length));
  ok('quick: the adversary round still ran and the ruling was re-made', messages(evs).some((m) => m.kind === 'marcus' && /^Hold the ruling/.test(m.text)) && of(evs, 'decision').length === 2);
  ok('quick: the closings and the report still happened', messages(evs).filter((m) => m.kind === 'closing').length === 3 && fs.existsSync(path.join(dataDir, 'debates', id, 'report.html')));
}
{
  // Two motions: the chair adds the precondition mid-motion, as he did in the real run.
  const id = create({ referee: REAL_RUN, addMotionAtSteer: 1 }, 'quick', 'Should our bakery open on Sundays? (quick, two motions)');
  const { r, evs } = await drive(id);
  const n = messages(evs).length;
  lengths.quick2 = n;
  const opened = of(evs, 'motion_open').map((e) => e.motionId);
  const closed = of(evs, 'motion_closed').map((e) => e.motionId);
  ok('quick, two motions: complete, both motions argued and ruled', r.status === 'complete' && opened.join() === 'm1,m2' && closed.join() === 'm1,m2', `${r.status} ${opened} ${closed}`);
  ok(`quick, two motions: 40-60 spoken messages in total (${n})`, n >= 40 && n <= 60, String(n));
  const m2 = evs.slice(evs.findIndex((e) => e.type === 'motion_open' && e.motionId === 'm2'));
  ok('quick: the second motion still got a real floor (at least one checkpoint)', of(m2, 'round').length >= 1 && messages(m2).filter((m) => m.kind === 'floor').length >= 3, String(messages(m2).filter((m) => m.kind === 'floor').length));
  const perMotion = of(evs, 'motion_closed').map((e) => e.messages);
  ok('quick: neither motion took the whole session', perMotion.every((x) => x <= BUDGET_PROFILES.quick.length.messagesPerMotion + adversaryTurns(3) * 2), JSON.stringify(perMotion));
}
{
  const id = create({ referee: REAL_RUN }, 'standard', 'Should our bakery open on Sundays? (standard)');
  const { r, evs } = await drive(id);
  lengths.standard = messages(evs).length;
  ok(`standard: complete, longer than quick and inside its own length (${lengths.standard})`, r.status === 'complete' && lengths.standard > lengths.quick1 && lengths.standard <= BUDGET_PROFILES.standard.length.sessionMessages, String(lengths.standard));
  ok('standard: closed past its round target, when the referee first said circling (checkpoint 6), or at its cap', of(evs, 'round').length <= BUDGET_PROFILES.standard.length.maxRounds, String(of(evs, 'round').length));
}
{
  const id = create({ referee: REAL_RUN }, 'deep', 'Should our bakery open on Sundays? (deep)');
  const { r, evs } = await drive(id);
  lengths.deep = messages(evs).length;
  const rounds = of(evs, 'round').length;
  ok(`deep may still run long: ${rounds} checkpoints, ${lengths.deep} messages (well past quick and standard)`, r.status === 'complete' && rounds >= 8 && lengths.deep > 1.6 * lengths.quick1 && lengths.deep > lengths.standard, `${r.status} ${rounds} ${lengths.deep}`);
}
console.log(`    messages: quick (1 motion) ${lengths.quick1}, quick (2 motions) ${lengths.quick2}, standard ${lengths.standard}, deep ${lengths.deep}; the real Quick run: 145`);

// ---------- P4: pause at every phase, resume, nothing skipped or closed early ----------

console.log('[P4] a founder pause at every phase resumes at the exact step');

/** The unpaused reference: what the session does when nobody touches Pause. */
const baseId = create({ referee: SETTLES }, 'quick', 'Should our bakery open on Sundays? (reference)');
const base = await drive(baseId);
ok('reference: complete', base.r.status === 'complete', base.r.status);
const shape = (evs: DebateEvent[]) => ({
  opened: of(evs, 'motion_open').map((e) => e.motionId).join(),
  closed: of(evs, 'motion_closed').map((e) => e.motionId).join(),
  rounds: of(evs, 'round').map((e) => `${e.motionId}#${e.round}`).join(),
  decisions: of(evs, 'decision').length,
  holds: messages(evs).filter((m) => m.kind === 'marcus' && /^Hold the ruling/.test(m.text)).length,
  closings: messages(evs).filter((m) => m.kind === 'closing').length,
  reports: of(evs, 'report_ready').length,
});
const baseShape = shape(base.evs);
ok('reference: two checkpoints, the adversary round, a re-ruling', baseShape.rounds === 'm1#1,m1#2' && baseShape.holds === 1 && baseShape.decisions === 2, JSON.stringify(baseShape));
/** The steps the session went through; a step resumed after a pause is announced again, so repeats in a row are one step. */
const statusesOf = (evs: DebateEvent[]) => of(evs, 'status').map((e) => e.status).filter((s) => s !== 'paused').filter((s, i, a) => s !== a[i - 1]);

const floorCalls = (d: DebateState) => d.calls.filter((c) => /^(ana|bo|cy):floor$/.test(c)).length;
const PHASES: { name: string; match: (label: string, d: DebateState) => boolean; resumeTo: string; inMeeting?: boolean }[] = [
  { name: 'intake', match: (l) => l === 'intake', resumeTo: 'goal_approval' },
  { name: 'panel design', match: (l) => l === 'architect', resumeTo: 'panel_approval' },
  { name: 'planning', match: (l) => l === 'marcus:plan', resumeTo: 'plan_approval' },
  { name: 'position cards', match: (l) => l === 'ana:position', resumeTo: 'meeting', inMeeting: true },
  { name: 'floor turn', match: (l, d) => /^(ana|bo|cy):floor$/.test(l) && floorCalls(d) === 3, resumeTo: 'meeting', inMeeting: true },
  { name: 'chair check-in', match: (l) => l === 'marcus:steer', resumeTo: 'meeting', inMeeting: true },
  { name: 'referee', match: (l) => l === 'referee', resumeTo: 'meeting', inMeeting: true },
  { name: 'ruling', match: (l, d) => l === 'marcus:ruling' && !d.redteamed, resumeTo: 'meeting', inMeeting: true },
  { name: 'adversary desk', match: (l) => l === 'redteam:1', resumeTo: 'meeting', inMeeting: true },
  { name: 'adversary round', match: (l, d) => /^(ana|bo|cy):floor$/.test(l) && d.floorSinceRedteam === 2, resumeTo: 'meeting', inMeeting: true },
  { name: 're-ruling', match: (l, d) => l === 'marcus:ruling' && d.redteamed, resumeTo: 'meeting', inMeeting: true },
  { name: 'wrap-up', match: (l) => l === 'ana:closing', resumeTo: 'wrapup' },
  { name: 'reporting (writer)', match: (l) => l === 'report', resumeTo: 'reporting' },
  { name: 'reporting (adversary)', match: (l) => l === 'redteam:report:1', resumeTo: 'reporting' },
];

for (const ph of PHASES) {
  const id = create({ referee: SETTLES, pauseOn: { match: ph.match } }, 'quick', `Should our bakery open on Sundays? (pause: ${ph.name})`);
  let seen: PauseObservation | null = null;
  const { r, evs } = await drive(id, { onPaused: (o) => (seen = o) });
  const o = seen as PauseObservation | null;
  const tag = `pause at ${ph.name}`;
  ok(`${tag}: the pause landed inside that step`, !!o && pausedAt.get(id)?.label !== undefined, JSON.stringify(pausedAt.get(id)));
  if (!o) continue;
  ok(`${tag}: the room held still while paused`, o.status === 'paused' && o.eventsBeforeResume === o.eventsAtSettle, `${o.status} ${o.eventsAtSettle} -> ${o.eventsBeforeResume}`);
  ok(`${tag}: Resume goes back to ${ph.resumeTo}`, o.resumeTo === ph.resumeTo, String(o.resumeTo));
  const pauseSeq = pausedAt.get(id)!.seq;
  const beforeResume = evs.filter((e) => e.seq <= o.eventsBeforeResume && e.seq > pauseSeq);
  ok(`${tag}: no motion was closed or opened while paused`, !beforeResume.some((e) => e.type === 'motion_closed' || e.type === 'motion_open'), beforeResume.map((e) => e.type).join(','));
  ok(`${tag}: no status moved on while paused`, !beforeResume.some((e) => e.type === 'status' && (e as any).status !== 'paused'), beforeResume.filter((e) => e.type === 'status').map((e: any) => e.status).join(','));
  if (ph.inMeeting && o.closedMotions.length === 0 && ph.name !== 'position cards') {
    ok(`${tag}: the motion checkpoint was kept`, !!o.checkpoint && o.checkpoint.motionId === 'm1', JSON.stringify(o.checkpoint)?.slice(0, 200));
  }
  ok(`${tag}: the session completed after Resume`, r.status === 'complete', r.status);
  const s = shape(evs);
  ok(`${tag}: same motions, same checkpoints, same rulings as the unpaused session`, JSON.stringify(s) === JSON.stringify(baseShape), `${JSON.stringify(s)} vs ${JSON.stringify(baseShape)}`);
  ok(`${tag}: every step ran once, in order`, statusesOf(evs).join('>') === statusesOf(base.evs).join('>'), `${statusesOf(evs).join('>')} vs ${statusesOf(base.evs).join('>')}`);
  const d = states.get(id)!;
  const once = ['intake', 'architect', 'marcus:plan', 'redteam:1', 'report', 'redteam:report:1', 'ana:closing', 'bo:closing', 'cy:closing'];
  const twice = once.filter((l) => d.calls.filter((c) => c === l).length !== states.get(baseId)!.calls.filter((c) => c === l).length);
  ok(`${tag}: no finished step was paid for twice`, twice.length === 0, twice.join(','));
  ok(`${tag}: the referee judged each checkpoint once`, d.calls.filter((c) => c === 'referee').length === states.get(baseId)!.calls.filter((c) => c === 'referee').length,
    `${d.calls.filter((c) => c === 'referee').length} vs ${states.get(baseId)!.calls.filter((c) => c === 'referee').length}`);

  if (ph.name === 'floor turn') {
    // The checkpoint the pause interrupted is the one that carries on: same round, the turns it still owed.
    const sets = of(evs, 'floor_set').filter((e) => e.motionId === 'm1');
    const r1 = sets.filter((e) => e.round === 1);
    ok(`${tag}: the interrupted checkpoint resumed as checkpoint 1, not a new one`, r1.length === 2 && sets.filter((e) => e.round === 2).length === 1, sets.map((e) => e.round).join(','));
    const heard = messages(evs).filter((m) => m.kind === 'floor' && m.seq > pauseSeq && m.seq <= o.eventsAtSettle);
    ok(`${tag}: nothing more was performed once Pause was pressed`, heard.length === 0, heard.map((m) => m.text).join(' | '));
    // A turn already written and planned stays in the checkpoint and plays first on Resume, with no new model call.
    const held = o.checkpoint?.performing?.turn;
    ok(`${tag}: the turn already written when Pause was pressed is held in the checkpoint`, !!held, JSON.stringify(o.checkpoint?.performing)?.slice(0, 200));
    if (held) {
      const after = messages(evs).filter((m) => m.kind === 'floor' && m.seq > o.eventsBeforeResume);
      ok(`${tag}: it was heard first after Resume, once`, after[0]?.id === held.id && messages(evs).filter((m) => m.id === held.id).length === 1, `${after[0]?.id} vs ${held.id}`);
    }
    // The turn being written when Pause was pressed is dropped: its words never reach the record.
    const dropped = inFlightText.get(id) ?? '';
    ok(`${tag}: the turn being written when Pause was pressed was dropped unheard`, !!dropped && !evs.some((e) => e.type === 'message' && (e as any).text.includes(dropped)), dropped);
  }
  if (ph.name === 'adversary round') {
    const cp = o.checkpoint;
    ok(`${tag}: the checkpoint keeps the ruling, redTeamed and the defeaters`, !!cp && cp.redTeamed === true && !!cp.ruling && !!cp.challenge?.numbered && cp.challenge.spoken + (cp.performing ? 1 : 0) >= 1 && cp.challenge.spoken < cp.challenge.turns, JSON.stringify(cp && { redTeamed: cp.redTeamed, ruling: !!cp.ruling, challenge: cp.challenge, held: !!cp.performing }));
    const hold = messages(evs).find((m) => m.kind === 'marcus' && /^Hold the ruling/.test(m.text))!;
    const decisions = of(evs, 'decision');
    const reRule = decisions[1];
    const roundTurns = messages(evs).filter((m) => m.kind === 'floor' && m.seq > hold.seq && m.seq < (reRule?.seq ?? Infinity) && !messages(evs).some((x) => x.cutOff?.resumedBy === m.id));
    ok(`${tag}: after Resume the adversary's round finished its ${adversaryTurns(3)} turns before the re-ruling`, roundTurns.length >= adversaryTurns(3) && roundTurns.some((m) => m.seq > o.eventsBeforeResume), `${roundTurns.length} turns`);
    ok(`${tag}: the motion closed after the re-ruling, not before`, !!reRule && of(evs, 'motion_closed')[0].seq > reRule.seq);
  }
  if (ph.name === 'ruling' || ph.name === 'adversary desk' || ph.name === 're-ruling') {
    ok(`${tag}: the ruling in flight was kept, and the motion stayed open`, !!o.checkpoint?.ruling && o.closedMotions.length === 0, JSON.stringify(o.checkpoint && { ruling: !!o.checkpoint.ruling, closed: o.closedMotions }));
  }
}

// ---------- P4: a founder pause survives a restart ----------

console.log('[P4] a pause survives a restart, and End while paused still writes it up');
{
  const id = create({ referee: SETTLES, pauseOn: { match: (l, d) => /^(ana|bo|cy):floor$/.test(l) && floorCalls(d) === 2 } }, 'quick', 'Should our bakery open on Sundays? (pause, restart)');
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000 && Debates.get(id)!.status !== 'paused') {
    const r = Debates.get(id)!;
    if (r.meta.pendingApproval) Engine.get(id)!.approve(r.meta.pendingApproval, 'approve');
    await new Promise((res) => setTimeout(res, 10));
  }
  await new Promise((res) => setTimeout(res, 200));
  Engine.forget(id);   // the process dies while paused
  const back = Engine.get(id)!;
  await new Promise((res) => setTimeout(res, 200));
  const r0 = Debates.get(id)!;
  ok('after a restart the session is still paused, still at the meeting', r0.status === 'paused' && r0.meta.founderPause?.resumeTo === 'meeting', `${r0.status} ${JSON.stringify(r0.meta.founderPause)}`);
  ok('Resume after the restart is accepted', back.resumeMeeting());
  const { r, evs } = await drive(id);
  ok('it completed with the same shape as the unpaused session', r.status === 'complete' && JSON.stringify(shape(evs)) === JSON.stringify(baseShape), JSON.stringify(shape(evs)));
}
{
  const id = create({ referee: SETTLES, pauseOn: { match: (l) => l === 'referee' } }, 'quick', 'Should our bakery open on Sundays? (pause, then end)');
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000 && Debates.get(id)!.status !== 'paused') {
    const r = Debates.get(id)!;
    if (r.meta.pendingApproval) Engine.get(id)!.approve(r.meta.pendingApproval, 'approve');
    await new Promise((res) => setTimeout(res, 10));
  }
  await new Promise((res) => setTimeout(res, 200));
  Engine.get(id)!.end();
  const t1 = Date.now();
  while (Date.now() - t1 < 30_000 && !['complete', 'error', 'cancelled'].includes(Debates.get(id)!.status)) await new Promise((res) => setTimeout(res, 10));
  const r = Debates.get(id)!;
  const evs = Events.since(id, 0);
  ok('End while paused in the meeting goes to the closings and the report', r.status === 'complete' && messages(evs).filter((m) => m.kind === 'closing').length === 3 && !r.meta.founderPause, `${r.status}`);
}
{
  const id = create({ referee: SETTLES }, 'quick', 'Should our bakery open on Sundays? (pause at approval)');
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000 && Debates.get(id)!.meta.pendingApproval !== 'goal') await new Promise((res) => setTimeout(res, 10));
  const run = Engine.get(id)!;
  ok('pause at the goal approval is accepted', run.pause());
  ok('the founder can still approve while paused, and the room waits for Resume', run.approve('goal', 'approve'));
  await new Promise((res) => setTimeout(res, 200));
  const r0 = Debates.get(id)!;
  ok('approved while paused: still paused, Resume goes to the panel', r0.status === 'paused' && r0.meta.founderPause?.resumeTo === 'panel_design', `${r0.status} ${JSON.stringify(r0.meta.founderPause)}`);
  ok('pausing twice is refused', !run.pause());
  run.resumeMeeting();
  const { r } = await drive(id);
  ok('it completed', r.status === 'complete', r.status);
  ok('a finished session cannot be paused', !Engine.get(id)!.pause());
}

console.log(`\n${passes} passed, ${fails} failed`);
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
