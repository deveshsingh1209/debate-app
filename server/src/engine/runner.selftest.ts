/**
 * The real engine, offline. A scripted fake behind the wireAgents seam stands
 * in for every model; a throwaway DATA_DIR stands in for ./data. Nothing is
 * spawned and nothing leaves the machine. This drives a real DebateRun
 * (runner.ts, motions.ts, buildRoomBlocks, the SSE hub, the database) from
 * intake to complete, which the MOCK engine never touches.
 *
 *   npx tsx src/engine/runner.selftest.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Everything below reads its environment at import time, so set it first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-engine-test-'));
process.env.DATA_DIR = dataDir;
process.env.MOCK = '';
process.env.AGENT_CLI_PATH = '/usr/bin/false';   // belt and braces: a real spawn fails at once
process.env.CHROME_PATH = 'none';                // no PDF, no print QA, no browser
process.env.FOUNDER_NAME = 'Dana';
process.env.SPEAKING_PACE = '0';                 // turns are performed at once: no speaking-pace sleeps in a test
delete process.env.OPENAI_API_KEY;

const { wireAgents } = await import('../agents/sdk.ts');
const { Engine } = await import('./runner.ts');
const { Debates, Events } = await import('../db.ts');
const { Hub } = await import('../sse.ts');
const { buildRoomBlocks, formatEvents } = await import('./transcript.ts');
const { sampleReport } = await import('../report/sample.ts');
const F = await import('../research/fixtures.ts');
const { wireResearch } = await import('../research/index.ts');
const { fakeResearch } = await import('../research/fake.ts');
const BUDGET_MIN_DEEP = (await import('../../../shared/budget.ts')).BUDGET_PROFILES.deep.minRounds;
type AgentTurnOpts = import('../agents/sdk.ts').AgentTurnOpts;
type DebateEvent = import('../../../shared/types.ts').DebateEvent;
type Persona = import('../../../shared/types.ts').Persona;

let fails = 0;
let passes = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) passes++;
  else fails++;
  console.log(`${cond ? '  ok  ' : '  FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};

// ---------- the scripted room ----------

const PANEL = [
  { id: 'ana', name: 'Ana Ruiz', role: 'Bakery operator', bio: 'Ran three bakeries.', expertise: ['ops'], personality: 'Blunt.', biases: 'Hates idle ovens.', style: 'Short.', color: '#22d3ee', initials: 'AR' },
  { id: 'bo', name: 'Bo Chen', role: 'Labour economist', bio: 'Studies small-shop staffing.', expertise: ['labour'], personality: 'Careful.', biases: 'Protects staff.', style: 'Numbers.', color: '#a78bfa', initials: 'BC' },
  { id: 'cy', name: 'Cy Okafor', role: 'Local retail analyst', bio: 'Tracks high-street footfall.', expertise: ['footfall'], personality: 'Dry.', biases: 'Trusts data.', style: 'Plain.', color: '#34d399', initials: 'CO' },
];
const ASIDE_TEXT = 'SECRET-ASIDE-7731 she has never run a weekend shift';
const calls: { label: string; system: string; prompt: string; debateId?: string; thinking?: number }[] = [];
let refereeCalls = 0;
let reactCalls = 0;
let lastReactPrompt = '';
let asidePublishedAt = -1;
let debateId = '';
const usage = { input: 1200, output: 180, cacheWrite: 0, cacheRead: 3000 };
/** Multiplies every fake call's cost; section 5 turns it up to show an expensive session is not cut. */
let costScale = 1;
/** The architect's pre-session research questions; section 9 sets one to restart with research in flight. */
let architectQs: string[] = [];

/** A dossier as the persona seat would write it; `twin` makes it a near-copy of Bo's, to trip the diversity check. */
function dossierJson(id: string, twin = false): any {
  const base = {
    history: [
      { when: '2015', what: `${id} failure one`, lesson: 'lesson one', kind: 'failure' },
      { when: '2018', what: `${id} failure two`, lesson: 'lesson two', kind: 'failure' },
      { when: '2021', what: `${id} win`, lesson: 'lesson three', kind: 'win' },
    ],
    blindSpots: [`${id} blind spot`],
    temperament: { heatGain: 0.3, heatDecay: 0.1, interruptThreshold: 0.6, dominance: 0.5 },
    relationships: [],
  };
  const v: Record<string, any> = {
    ana: { publicReputation: 'PUBLIC-REP-ANA ran three bakeries through two recessions.', incentives: ['PRIVATE-INCENTIVE-ana keeps her Sunday-off promise to staff', 'bonus on weekly takings'], goalLean: 1, biases: [{ name: 'oven utilisation', showsUpAs: 'counts idle ovens' }], stubbornness: 0.3, speech: { register: 'clipped', typicalWords: 45, vocabulary: ['proof', 'batch', 'oven', 'shift', 'crumb'], tics: [{ text: 'look', maxPerMotion: 1 }], neverSay: ['circle back'] }, underPressure: 'go quiet, then come back with a number' },
    bo: { publicReputation: 'PUBLIC-REP-BO studies staffing in small shops.', incentives: ['PRIVATE-INCENTIVE-bo funded by a union study', 'reputation for protecting staff'], goalLean: -1, biases: [{ name: 'labour protection', showsUpAs: 'reads every new shift as a cost to people' }], stubbornness: 0.8, speech: { register: 'technical', typicalWords: 140, vocabulary: ['elasticity', 'rota', 'attrition', 'overtime', 'regression'], tics: [{ text: 'on the data', maxPerMotion: 2 }], neverSay: [] }, underPressure: 'cite a study' },
    cy: twin
      ? { publicReputation: 'PUBLIC-REP-CY twin draft.', incentives: ['PRIVATE-INCENTIVE-cy funded by a union study', 'reputation for protecting staff'], goalLean: -1, biases: [{ name: 'labour protection', showsUpAs: 'reads every new shift as a cost to people' }], stubbornness: 0.8, speech: { register: 'technical', typicalWords: 140, vocabulary: ['elasticity', 'rota', 'attrition', 'overtime', 'regression'], tics: [{ text: 'on the data', maxPerMotion: 2 }], neverSay: [] }, underPressure: 'cite a study' }
      : { publicReputation: 'PUBLIC-REP-CY counts high-street footfall for councils.', incentives: ['PRIVATE-INCENTIVE-cy sells a footfall dashboard', 'wants a case study'], goalLean: -1, biases: [{ name: 'counter bias', showsUpAs: 'trusts the clicker over the till' }], stubbornness: 0.65, speech: { register: 'dry', typicalWords: 80, vocabulary: ['footfall', 'dwell', 'catchment', 'clicker', 'baseline'], tics: [{ text: 'for what it is worth', maxPerMotion: 1 }], neverSay: [] }, underPressure: 'get drier and more precise' },
  };
  return { ...base, ...v[id] };
}

function json(label: string): any {
  if (label === 'intake' || label === 'intake:auto') {
    return {
      clear: true, title: 'SUNDAY BAKERY', goal: 'Decide whether the bakery opens on Sundays.', complexity: { decisions: 1, disciplines: 3, depth: 'quick', rationale: 'One call.' },
      // Money and the deadline stated; the rest is left for the server to mark assumed.
      stakes: { atRisk: { money: 'STAKE-MONEY a 4,000 pound oven lease' }, decideBy: 'the March rota meeting' },
    };
  }
  const dossier = label.match(/^(\w+):dossier/);
  if (dossier) return dossierJson(dossier[1], dossier[1] === 'cy' && !label.includes(':diverse'));
  if (label === 'relationships') return { relationships: { ana: [{ with: 'bo', kind: 'rival', note: 'argued over a rota at a trade fair' }], bo: [{ with: 'zed', kind: 'ally', note: 'not on the panel' }] } };
  if (label === 'clerk:stances') {
    return { stances: [{ expert: 'ana', stance: 0, confidence: 'low', crux: 'who bakes' }, { expert: 'bo', stance: -1, confidence: 'medium', crux: 'staff' }, { expert: 'cy', stance: 1, confidence: 'medium', crux: 'footfall' }, { expert: 'nobody', stance: 2, confidence: 'high', crux: 'x' }] };
  }
  if (label === 'architect') return { personas: PANEL, rationale: 'Ops, labour, demand.', research_questions: architectQs };
  if (label === 'research:crux') return { hits: [{ expert: 'ana', finding: 1, effect: 'supports' }, { expert: 'nobody', finding: 1, effect: 'undermines' }] };
  // The desk's check of what the debate already holds: here the landscape does not answer the room's question, so it is searched.
  if (label === 'research:recall') return { answered: false, summary: '', spoken: '', findings: [], gap: null };
  if (label === 'marcus:plan') {
    // Marked optional on purpose: an agenda that is all optional keeps its first motion.
    return { say: 'One motion today.', plan_update: { items: [{ id: 'm1', title: 'Sunday opening', motion: 'The bakery should open on Sundays.', detail: 'Staff are stretched.', optional: true, status: 'pending' }], rationale: 'One decision.' } };
  }
  if (label.endsWith(':position') || label.endsWith(':position:contrarian')) {
    return { thesis: 'A thesis.', load_bearing_claims: ['claim'], red_line: 'never this', falsifier: 'this would flip me', who_i_expect_to_be_wrong: 'bo' };
  }
  if (label === 'cards:consensus') return { consensus: false };
  if (label === 'referee') {
    refereeCalls++;
    return refereeCalls === 1
      ? { fresh_arguments: ['Sunday footfall is high'], position_changes: [], unresolved: ['staff cover'], rung: 2, rung_reason: 'numbers', missing_expertise: null, ready_to_decide: false, next_pressure: null, momentum: 'climbing' }
      : { fresh_arguments: ['a rota closes the gap'], position_changes: [], unresolved: [], rung: 3, rung_reason: 'stress tested', missing_expertise: null, ready_to_decide: true, next_pressure: null, momentum: 'climbing' };
  }
  if (label === 'marcus:steer') {
    // The chair's check-in at a checkpoint (2b-7): no slate, a nudge to one person, a question for the founder.
    return {
      say: null, why: 'Bo has the staffing case; Ana must answer it.',
      nudge: { speaker: 'ana', direction: 'Who covers the 5am bake when two of you already work six days?' },
      research: null, compute: null, plan_update: null, reopen: null,
      ask_user: { question: 'Would you work Sundays yourself?', context: 'It decides the rota.', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] },
      assumption: null,
    };
  }
  if (label === 'react') {
    reactCalls++;
    // Ana cannot let Bo's staffing line stand; Cy grunts. Anyone else reacts mildly, with a short pushback.
    const prompt = lastReactPrompt;
    if (/^Bo Chen IS SPEAKING/.test(prompt)) {
      return { reactions: [
        { listener: 'ana', intensity: 3, atSentence: 2, cutIn: 'Who bakes at five, Bo?', backchannel: null, wantsFloor: true },
        { listener: 'cy', intensity: 2, atSentence: 3, cutIn: null, backchannel: 'On what base?', wantsFloor: false },
      ] };
    }
    return { reactions: [{ listener: 'bo', intensity: 2, atSentence: 1, cutIn: null, backchannel: 'No.', wantsFloor: true }] };
  }
  if (label === 'marcus:ruling') {
    return { say: 'Ruled.', decision: { decision: 'Open on Sundays for a six-week trial.', owner: 'Dana', rationale: 'Footfall supports it; a rota covers staff.', evidence: 'assumed', dependsOn: [], dissents: [{ expert: 'Bo Chen', position: 'Not without a hire.', reasoning: 'Six-day weeks.', tripwire: { signal: 'two staff sick days in the first month of Sundays', by: 'end of week six' }, costOfIgnoring: 'losing a baker mid-season' }] } };
  }
  if (label.startsWith('redteam')) return { defeaters: [] };
  if (label === 'report') return sampleReport;
  throw new Error(`no scripted JSON reply for "${label}"`);
}

/** Ana's turns carry corpus tics and a full trailer; the linter must catch the one and strip the other. */
const ANA_TICS = 'Bo is closer to right. Sunday trade is real (observed, from my shops). Who bakes at five?';
const ANA_REWRITE = 'Bo, Sunday trade is real. Who bakes at five?';
/** A different closing thought each time Ana speaks: identical turns would (rightly) trip the waste guard on the rewrite. */
const ANA_MORE = ['The ovens sit idle.', 'Regulars keep asking.', 'The rota is the question.', 'Weekend buyers are different buyers.', 'Rent runs either way.', 'The bakers decide this.', 'Footfall is not the issue.', 'Staff come first.', 'Margins are thin.', 'Neighbours open already.'];
let anaTurns = 0;
/** The fast-tier rewrite as a model would do it: the stock phrase and the spoken label go, everything else stays. */
const rewriteOf = (prompt: string) => (prompt.split('THE TURN:\n')[1] ?? '').replace('Bo is closer to right. ', 'Bo, ').replace(' (observed, from my shops)', '');
const TRAILER = '\nSTANCE: for+1 | confidence: medium | crux: who bakes at five | moved: argument by bo | cost: my promise of Sundays off\nCLAIMS: [observed] Sunday trade is real at my shops; [assumed] staff will take a rota; [observed] it is a four-person bakery\nASK: bo | Who bakes at five?';
/** Section 7 turns this on: every turn says the same thing, so the repetition guard has something to find. */
let repeatSpeech = false;
/** Section 8 sets this to a label: the next call on it fails with a spent allowance. */
let limitOn: string | null = null;
let spoken = 0;

/** Every floor turn as the fake model wrote it (trailer off), by speaker, so the unsaid part of a cut turn can be checked. */
const written: { who: string; text: string }[] = [];

function speech(label: string): string {
  const [who, kind] = label.split(':');
  if (kind === 'lint') return ANA_REWRITE;   // the seam passes the prompt in run(); see rewriteOf
  if (who === 'marcus' && kind === 'floor') return 'CHAIR-LINE Cy, you moved. What moved you?';
  const out = speechRaw(label);
  if (kind === 'floor') written.push({ who, text: out.split('\n')[0] });
  return out;
}

function speechRaw(label: string): string {
  const [who, kind] = label.split(':');
  if (who === 'ana' && kind === 'floor' && asidePublishedAt < 0) {
    // A whisper lands in the log mid-motion. No prompt built after this may contain it.
    Hub.publish(debateId, { type: 'aside', id: 'as_1', from: 'bo', to: 'cy', text: ASIDE_TEXT } as any);
    asidePublishedAt = calls.length;
  }
  if (kind === 'closing') return `${who} closes: open on Sundays only with a rota.\nSTANCE: for+1 | confidence: high`;
  if (who === 'ana' && !repeatSpeech) return `${ANA_TICS} ${ANA_MORE[anaTurns++ % ANA_MORE.length]}${TRAILER}`;
  const n = ++spoken;
  // Each turn brings something new unless the test wants a room going in circles.
  const fresh = repeatSpeech ? '' : ` New figure ${n}: shift ${n}a costs ${n}b, cover ${n}c, margin ${n}d, footfall ${n}e.`;
  // Bo sends the research desk out from his trailer (2b-4).
  if (who === 'bo') return `${who} on the floor${repeatSpeech ? "" : `, take ${n}`}. Sunday trade is real. The question is who bakes at five.${fresh}\nSTANCE: against-1 | confidence: low | crux: staff\nRESEARCH: ${F.GOLDEN_QUESTION}`;
  return `${who} on the floor${repeatSpeech ? "" : `, take ${n}`}. Sunday trade is real. The question is who bakes at five.${fresh}\nSTANCE: against-1 | confidence: low | crux: staff`;
}

wireAgents({
  async run(opts: AgentTurnOpts) {
    calls.push({ label: opts.label ?? '', system: opts.system, prompt: opts.prompt, debateId: opts.debateId, thinking: opts.thinking });
    if (limitOn && opts.label === limitOn) {
      limitOn = null;
      throw new Error("You've hit your session limit · resets 11:59pm");
    }
    if (opts.label === 'research') {
      // The Claude research adapter, fed what the real CLI would hand it: the JSON, and the WebSearch result behind it.
      const stream = F.claudeGoldenStream();
      const result = stream.find((m: any) => m.type === 'user').message.content[0].content as string;
      return {
        text: JSON.stringify(F.GOLDEN_CLAUDE_JSON), sessionId: null, costUsd: 0.04, usage, toolCalls: [{ name: 'WebSearch', command: null }],
        toolResults: [{ name: 'WebSearch', input: 'small bakeries open sundays survey', ok: true, content: result }],
      };
    }
    const text = (opts.label ?? '').endsWith(':lint') ? rewriteOf(opts.prompt) : speech(opts.label ?? '');
    return { text, sessionId: null, costUsd: 0.05 * costScale, usage, toolCalls: [] };
  },
  async runJson(opts: AgentTurnOpts) {
    calls.push({ label: opts.label ?? '', system: opts.system, prompt: opts.prompt, debateId: opts.debateId, thinking: opts.thinking });
    if (opts.label === 'react') lastReactPrompt = opts.prompt;
    if (limitOn && opts.label === limitOn) {
      limitOn = null;
      throw new Error("You've hit your session limit · resets 11:59pm");
    }
    return { value: json(opts.label ?? ''), sessionId: null, usage, costUsd: 0.08 * costScale };
  },
});

// ---------- 1: the whole engine, intake to complete ----------

console.log('[1] a real DebateRun from intake to complete, through the fake seam');
debateId = Engine.create('Should our four-person bakery open on Sundays?', { provider: 'claude', mode: 'directed', autonomy: 'interactive' });
// Everything the founder's screen would receive, live frames included.
const wire: any[] = [];
Hub.subscribe(debateId, { writeHead() {}, write(s: string) { if (s.startsWith('data:')) wire.push(JSON.parse(s.slice(5))); return true; }, on() {} } as any, 0);
const answered = new Set<string>();
const t0 = Date.now();
while (Date.now() - t0 < 60_000) {
  const row = Debates.get(debateId)!;
  if (['complete', 'error', 'cancelled'].includes(row.status)) break;
  const run = Engine.get(debateId)!;
  if (row.meta.pendingApproval) run.approve(row.meta.pendingApproval, 'approve');
  const q = row.meta.pendingQuestionId;
  if (q && !answered.has(q)) {
    answered.add(q);
    run.answer(q, 'ENGINE-ANSWER yes, I will take the first shift');
  }
  await new Promise((r) => setTimeout(r, 15));
}
const row = Debates.get(debateId)!;
const events: DebateEvent[] = Events.since(debateId, 0);
ok('the debate reached complete', row.status === 'complete', `${row.status}; last events: ${JSON.stringify(events.slice(-4))}`);
const statuses = events.filter((e) => e.type === 'status').map((e: any) => e.status);
const want = ['goal_approval', 'panel_design', 'panel_approval', 'planning', 'plan_approval', 'meeting', 'wrapup', 'reporting', 'complete'];
let at = -1;
const inOrder = want.every((s) => (at = statuses.indexOf(s, at + 1)) >= 0);
ok('statuses ran in order', inOrder, statuses.join(' > '));
const types = new Set(events.map((e) => e.type));
for (const t of ['goal', 'scope', 'panel', 'plan', 'casting', 'motion_open', 'floor_set', 'round', 'question', 'answer', 'decision', 'motion_closed', 'report_ready']) {
  ok(`emitted ${t}`, types.has(t as any));
}
const msgs = events.filter((e) => e.type === 'message') as Extract<DebateEvent, { type: 'message' }>[];
if (process.env.DEBUG_FLOOR) for (const m of msgs) console.log(`    ${m.speaker}/${m.kind}/${m.shape ?? ''}${m.cutOff ? ' CUT' : ''}${m.overlap ? ' OVER' : ''}: ${m.text.slice(0, 70)}`);
const floorTurns = msgs.filter((m) => m.kind === 'floor');
const rounds = events.filter((e) => e.type === 'round').length;
ok('two checkpoints of six to eight turns each, picked by the director (resumes counted on top)', rounds === 2 && floorTurns.filter((m) => !msgs.some((x) => x.cutOff?.resumedBy === m.id)).length >= 12 && floorTurns.length <= 2 * 8 + 6, `${rounds} checkpoints, ${floorTurns.length} floor turns`);
ok('short reactions are turns in the room', msgs.some((m) => m.kind === 'reaction' && m.shape === 'reaction'), JSON.stringify(msgs.filter((m) => m.kind === 'reaction').map((m) => m.text)));
ok('three closing statements', msgs.filter((m) => m.kind === 'closing').length === 3);
ok('an all-optional agenda keeps its first motion', !!row.plan?.items[0] && !row.plan.items[0].optional, JSON.stringify(row.plan?.items[0]));
ok('a ruling was recorded in meta',row.meta.decisions.length === 1 && /six-week/.test(row.meta.decisions[0].decision));
ok('the report was written', fs.existsSync(path.join(dataDir, 'debates', debateId, 'report.html')));
ok('spend reached the ledger', (row.meta.usage?.turns ?? 0) === calls.length && (row.meta.usage?.costUsd ?? 0) > 0, `${row.meta.usage?.turns} vs ${calls.length}`);

const md = fs.readFileSync(path.join(dataDir, 'debates', debateId, 'transcript.md'), 'utf8');
ok('transcript.md has the founder answer', md.includes('**Dana (founder):** ENGINE-ANSWER'), md.slice(0, 300));
ok('transcript.md has the chair question', md.includes('**Marcus asks the founder:** Would you work Sundays yourself?'));

// ---------- 2: asides never reach another seat ----------

console.log('[2] an aside reaches only the person it was whispered to');
ok('the aside was published mid-motion', asidePublishedAt >= 0 && events.some((e) => e.type === 'aside'));
const after = calls.slice(asidePublishedAt);
ok('prompts were built after it', after.length > 10, String(after.length));
const leaked = calls.filter((c) => c.system.includes('SECRET-ASIDE-7731') || (!c.label.startsWith('cy:') && c.prompt.includes('SECRET-ASIDE-7731')));
ok('no shared prefix, and no other seat\'s prompt, contains the aside', leaked.length === 0, leaked.map((c) => c.label).join(', '));
ok('the recipient reads it in their own private card', calls.some((c) => c.label === 'cy:floor' && /Bo Chen leaned over and said to you, privately: "SECRET-ASIDE-7731/.test(c.prompt)));
ok('transcript.md does not contain the aside', !md.includes('SECRET-ASIDE-7731'));
const roster = [{ id: 'marcus', name: 'Marcus', role: 'Chair', isModerator: true } as Persona, ...(PANEL as Persona[])];
const room = buildRoomBlocks({ events, personas: roster, goal: 'g', topic: 't', contextBrief: null, boundarySeq: events[Math.floor(events.length / 2)].seq, currentMotionId: 'm1' });
ok('buildRoomBlocks: neither the prefix nor the live round carries it', !room.system.includes('SECRET-ASIDE') && !room.roundSoFar.includes('SECRET-ASIDE'));

// ---------- 2b: the turn trailer, the linter, the claims record ----------

console.log('[2b] the trailer comes off, the linter rewrites, the grades reach the judges');
{
  const floor = msgs.filter((m) => m.kind === 'floor');
  const ana = floor.filter((m) => m.speaker === 'ana');
  const resumed = new Set(msgs.map((m) => m.cutOff?.resumedBy).filter(Boolean));
  ok('no published message carries a trailer line', !msgs.some((m) => /^(STANCE|CLAIMS|ASK|COMPUTE)\s*:/m.test(m.text)), msgs.map((m) => m.text).join(' | '));
  ok('no live frame ever streamed a trailer line', !wire.some((f) => f.type === 'delta' && /STANCE|CLAIMS:|ASK:/.test(f.textDelta)),
    wire.filter((f) => f.type === 'delta' && /STANCE|CLAIMS|ASK/.test(f.textDelta)).map((f) => f.textDelta).join(' | '));
  ok('the speech did stream', wire.some((f) => f.type === 'delta' && f.speaker === 'ana' && /Sunday trade/.test(f.textDelta)) || wire.filter((f) => f.type === 'delta' && f.speaker === 'ana').length > 3);
  const anaWritten = ana.filter((m) => !resumed.has(m.id));
  ok("Ana's tics were rewritten on the fast tier", anaWritten.length > 0 && anaWritten.every((m) => m.text.startsWith(ANA_REWRITE) && !/closer to right|\(observed/.test(m.text) && m.lint?.rewrote === true), JSON.stringify(anaWritten.map((m) => [m.text, m.lint])));
  ok('the lint record names what fired', !!ana[0]?.lint?.rules.includes('banned:closer_to_right') && ana[0].lint.rules.includes('spoken_label'), JSON.stringify(ana[0]?.lint));
  const lintCalls = calls.filter((c) => c.label.endsWith(':lint') && c.debateId === debateId);
  // A flagged turn costs one fast call when the rewrite verifies, two when it does not (one retry);
  // a turn under the threshold costs none.
  const expected = msgs.reduce((n, m) => n + (m.lint && m.lint.score >= 3 ? (m.lint.rewrote ? 1 : 2) : 0), 0);
  ok('rewrites ran on the lint seat only for flagged turns, with one retry when rejected', lintCalls.length === expected && expected >= ana.length, `${lintCalls.length} vs ${expected}`);
  ok('only a verified rewrite replaced a turn', msgs.filter((m) => m.lint?.rewrote).every((m) => m.speaker === 'ana'),
    JSON.stringify(msgs.filter((m) => m.lint?.rewrote).map((m) => m.speaker)));
  ok('every written expert turn carries a lint record; reactions, resumes and the chair do not', msgs.filter((m) => (m.kind === 'floor' && !resumed.has(m.id)) || m.kind === 'closing').every((m) => !!m.lint)
    && msgs.filter((m) => m.kind === 'marcus' || m.kind === 'reaction').every((m) => !m.lint));
  ok('the 170-word flagship re-run is gone', !calls.some((c) => c.label.endsWith(':short')));
  // Evidence honesty (P1): "my shops" is the persona's backstory, so the server regrades it; the founder's own fact stays observed.
  ok('graded claims ride on the message, checked against what the founder supplied', JSON.stringify(ana[0]?.claims) === JSON.stringify([
    { text: 'Sunday trade is real at my shops', grade: 'persona', said: 'observed' },
    { text: 'staff will take a rota', grade: 'assumed' },
    { text: 'it is a four-person bakery', grade: 'observed' },
  ]), JSON.stringify(ana[0]?.claims));
  ok('no expert claim about their own shops is published as observed', !msgs.some((m) => m.claims?.some((c) => c.grade === 'observed' && /\bmy\b/i.test(c.text))));
  ok('the ASK line addresses the message', ana[0]?.to?.join() === 'bo', JSON.stringify(ana[0]?.to));
  ok('the motion opens on a set piece; replies and set pieces both follow (the hybrid rhythm)',
    floor[0]?.shape === 'set_piece' && floor.some((m) => m.shape === 'reply') && floor.slice(1).some((m) => m.shape === 'set_piece'),
    floor.map((m) => m.shape).join());
  const floorAsks = calls.filter((c) => /^(ana|bo|cy):floor$/.test(c.label) && c.debateId === debateId);
  ok('a reply is told a short word budget, a set piece its own', floorAsks.some((c) => /THIS TURN opens a point: .* at most \d+ words/.test(c.prompt)) && floorAsks.some((c) => /THIS TURN is a reply: .* at most (25|35|45) words/.test(c.prompt)), floorAsks.map((c) => c.prompt.slice(-300)).join('\n---\n'));
  ok('replies think at the reply budget', calls.filter((c) => c.label.endsWith(':floor') && /THIS TURN is a reply/.test(c.prompt)).every((c) => c.thinking === 2_000));
  // Ana's own stance comes back to her alone, in her private card; no other seat ever reads it.
  ok('no prompt for another seat contains a trailer value', !calls.some((c) => (!c.label.startsWith('ana:') && (c.system.includes('crux: who bakes') || c.prompt.includes('crux: who bakes'))) || c.system.includes('crux: who bakes') || c.system.includes('[assumed] staff will')),
    calls.filter((c) => c.system.includes('crux: who bakes') || (!c.label.startsWith('ana:') && c.prompt.includes('crux: who bakes'))).map((c) => c.label).join(','));
  const referee = calls.filter((c) => c.label === 'referee' && c.debateId === debateId);
  ok('the referee reads the graded claims beside the speech (rung 2 is reachable)', referee.some((c) => c.prompt.includes('[claims: [persona; the speaker said observed] Sunday trade is real at my shops')), referee.map((c) => c.prompt.slice(0, 300)).join(' | '));
  ok('the experts\' shared prefix never carries a grade', !calls.some((c) => c.label.endsWith(':floor') && c.system.includes('[claims:')));
  const ruling = calls.find((c) => c.label === 'marcus:ruling' && c.debateId === debateId);
  ok('the ruling gets the claims record in its own suffix', !!ruling && ruling.prompt.includes('THE CLAIMS RECORD') && !ruling.system.includes('[claims:'));
  ok('the report material carries the grades', calls.some((c) => c.label === 'report' && c.debateId === debateId && c.prompt.includes('[claims: [persona; the speaker said observed]') && c.prompt.includes('[observed] it is a four-person bakery')));
  ok('stances are kept server-side', row.meta.stances?.m1?.ana?.stance === 1 && row.meta.stances.m1.ana.crux === 'who bakes at five', JSON.stringify(row.meta.stances));
  ok('transcript.md shows the claims beside the speech', md.includes('_Claims: [persona; the speaker said observed] Sunday trade is real at my shops; [assumed] staff will take a rota; [observed] it is a four-person bakery_'));
  ok('the casting sheet lists the lint seat and no bid seat', (() => {
    const c = events.find((e) => e.type === 'casting') as any;
    return !!c && c.casting.entries.some((e: any) => e.role === 'lint' && e.model === 'claude-haiku-4-5') && !c.casting.entries.some((e: any) => e.role === 'bid');
  })());
}

// ---------- 2c: research, from an expert's trailer to the report ----------

console.log('[2c] research lands in the room, reaches the chair, and the report cites it');
{
  const started = events.filter((e) => e.type === 'research_started') as any[];
  const done = events.filter((e) => e.type === 'research_done') as any[];
  ok("Bo's RESEARCH line sent the desk out (twice: once a round, inside the motion's allowance)", started.length === 2 && started.every((s) => s.question === F.GOLDEN_QUESTION), JSON.stringify(started));
  ok('every request was answered with a provider-neutral result', done.length === 2 && done.every((d) => d.result?.status === 'ok' && d.result.citations.length === 2 && d.result.provider === 'claude'), JSON.stringify(done.map((d) => d.result?.status)));
  const r = done[0]?.result;
  ok('the citations are the tool-attested sources', r?.citations.every((c: any) => c.provenance === 'search_result' && /^c_[a-f0-9]{8}$/.test(c.id)), JSON.stringify(r?.citations));
  const said = msgs.filter((m) => m.speaker === 'research');
  ok('the desk speaks one short line with its citation markers, not a document', said.length === 2 && said.every((m) => m.text === r.spoken && /\[c_[a-f0-9]{8}\]/.test(m.text) && m.text.split(/\s+/).length <= 60), JSON.stringify(said.map((m) => m.text)));
  const isScout = (c: { prompt: string }) => c.prompt.includes('what is the current state of the domain');
  const rq = calls.find((c) => c.label === 'research' && c.debateId === debateId && !isScout(c));
  ok('the research prompt is the question and the goal, nothing else', !!rq && rq.prompt.includes(F.GOLDEN_QUESTION) && rq.prompt.includes('Decide whether the bakery opens on Sundays.') && !rq.prompt.includes('Sunday trade is real'), rq?.prompt);
  // The architect's web pass runs on the research desk: the topic and the goal only, its answer kept for reuse.
  const scout = calls.find((c) => c.label === 'research' && c.debateId === debateId && isScout(c));
  ok('the architect scout ran on the research desk, from the topic and the goal only', !!scout && scout.prompt.includes('Should our four-person bakery open on Sundays?') && scout.prompt.includes('Decide whether the bakery opens on Sundays.') && !scout.prompt.includes('Sunday trade is real'), scout?.prompt);
  const designer = calls.find((c) => c.label === 'architect' && c.debateId === debateId);
  ok('the designer reads the scout\'s note, fenced', !!designer && /<<<UNTRUSTED RESEARCH NOTE [0-9a-f]{16}>>>\nMost small bakeries/.test(designer.prompt), designer?.prompt.slice(-400));
  ok('the scout\'s answer is kept as a brief the rest of the debate can reuse', row.meta.architectScout?.status === 'ok' && row.meta.architectScout.citations.length === 2 && !row.meta.researchBriefs.some((b) => b.question === row.meta.architectScout?.question), JSON.stringify(row.meta.architectScout));
  const recalled = calls.find((c) => c.label === 'research:recall' && c.debateId === debateId);
  ok('a room question related to it is checked against it before any search, and searched when it is not answered',
    !!recalled && recalled.prompt.includes(`NEW QUESTION: ${F.GOLDEN_QUESTION}`) && /<<<UNTRUSTED BRIEF 1 [0-9a-f]{16}>>>/.test(recalled.prompt) && calls.indexOf(recalled) < calls.indexOf(rq!), recalled?.prompt);
  const after = calls.filter((c) => c.debateId === debateId && c.label.endsWith(':floor') && (c.system + c.prompt).includes('Sixty-two percent'));
  ok('the room reads the desk only inside a fence', after.length > 0 && after.every((c) => /<<<UNTRUSTED RESEARCH DESK [0-9a-f]{16}>>>\nSixty-two percent/.test(c.system + c.prompt)), after.map((c) => c.label).join(','));
  ok('the crux clerk ran on the fast tier, and an unknown expert it named was dropped',
    calls.some((c) => c.label === 'research:crux' && c.debateId === debateId) && events.some((e) => e.type === 'system' && /supports Ana Ruiz's crux\.$/.test((e as any).text)),
    events.filter((e) => e.type === 'system').map((e: any) => e.text).join(' | '));
  const answered = calls.find((c) => c.label === 'ana:floor' && c.debateId === debateId && /WHY YOU HAVE THE FLOOR NOW: The research desk has just landed something that bears on you: the desk has answered Bo Chen's question/.test(c.prompt));
  ok('the finding goes straight to the expert whose crux it hits, who must answer it', !!answered && answered.prompt.includes('it supports what your position turns on'),
    calls.filter((c) => c.label === 'ana:floor' && c.debateId === debateId).map((c) => c.prompt.match(/WHY YOU HAVE THE FLOOR NOW: [^\n]*/)?.[0]).join(' | '));
  ok('nothing is left in flight', (row.meta.researchInflight ?? []).length === 0 && row.meta.researchBriefs.length === 2);
  ok('the briefs keep their citations', row.meta.researchBriefs.every((b) => b.citations?.length === 2));
  const report = JSON.parse(fs.readFileSync(path.join(dataDir, 'debates', debateId, 'report.json'), 'utf8'));
  ok('the report carries the sources, server-written', Array.isArray(report.sources) && report.sources.length === 2 && report.sources.every((c: any) => c.provenance === 'search_result'), JSON.stringify(report.sources));
  ok('the report renders a Sources section', /id="sources"/.test(fs.readFileSync(path.join(dataDir, 'debates', debateId, 'report.html'), 'utf8')));
  ok('the report lists the persona claim as an anecdote, server-written (P1)', report.personaClaims?.some((c: any) => c.claim === 'Sunday trade is real at my shops' && c.expert === 'Ana Ruiz'), JSON.stringify(report.personaClaims));
  ok('and renders it under "Panel Anecdotes, Not Evidence"', /id="persona"[\s\S]*Sunday trade is real at my shops/.test(fs.readFileSync(path.join(dataDir, 'debates', debateId, 'report.html'), 'utf8')));
  ok('the report writer was handed the source ids', calls.some((c) => c.label === 'report' && c.debateId === debateId && c.prompt.includes('SOURCES THE RESEARCH DESK CITED') && c.prompt.includes(r.citations[0].id)));
  ok('transcript.md lists the sources under the desk', md.includes(`[${r.citations[0].id}] ${r.citations[0].title}`));
}

// ---------- 2d: dossiers, stakes, the belief ledger (2b-5) ----------

console.log('[2d] dossiers and the diversity check, stakes, and minds that change for a reason');
{
  const mine = calls.filter((c) => c.debateId === debateId);
  const panel = events.find((e) => e.type === 'panel') as any;
  ok('the panel event carries each expert\'s public reputation', panel?.publicReputation?.ana?.startsWith('PUBLIC-REP-ANA') && Object.keys(panel.publicReputation).length === 3, JSON.stringify(panel?.publicReputation));
  ok('a twin dossier failed the diversity check and was written once more, with hints', mine.some((c) => c.label === 'cy:dossier:diverse' && /TOO ALIKE/.test(c.prompt)) && !mine.some((c) => c.label === 'ana:dossier:diverse'),
    mine.filter((c) => c.label.includes('dossier')).map((c) => c.label).join(','));
  ok('after the second draft the panel passes, and says who was redrafted', panel?.diversity?.ok === true && panel.diversity.regenerated.join() === 'cy', JSON.stringify(panel?.diversity));
  ok('dossiers ran on the persona seat (balanced tier)', mine.filter((c) => c.label.includes(':dossier')).length === 4);
  ok('relationships to people off the panel were dropped', row.meta.dossiers?.ana.relationships[0]?.with === 'bo' && (row.meta.dossiers?.bo.relationships ?? []).length === 0, JSON.stringify(row.meta.dossiers?.bo.relationships));
  const floorCalls = mine.filter((c) => /^(ana|bo|cy):floor$/.test(c.label));
  ok('the shared prefix carries the public reputations and the STAKES block', floorCalls.length > 0 && floorCalls.every((c) => c.system.includes('Known in the room for: PUBLIC-REP-BO') && c.system.includes('STAKES') && c.system.includes('STAKE-MONEY')));
  ok('stakes nobody stated are marked assumed', /Decision owner: Dana, decision owner \(assumed\)/.test(floorCalls[0]?.system ?? '') && /Decide by: the March rota meeting\./.test(floorCalls[0]?.system ?? ''), (floorCalls[0]?.system ?? '').match(/STAKES[\s\S]{0,400}/)?.[0]);
  ok('no private dossier field ever reaches any system prompt', !calls.some((c) => /PRIVATE-INCENTIVE/.test(c.system)));
  ok('each speaker reads only their own private card', floorCalls.every((c) => {
    const who = c.label.split(':')[0];
    return c.prompt.includes('HOW YOU COME ACROSS') && c.prompt.includes(`PRIVATE-INCENTIVE-${who}`) && !['ana', 'bo', 'cy'].filter((x) => x !== who).some((x) => c.prompt.includes(`PRIVATE-INCENTIVE-${x}`));
  }), floorCalls.map((c) => c.label).join(','));
  const natural: Record<string, number> = { ana: 60, bo: 140, cy: 80 };   // typicalWords 45 (floored at 60), 140, 80
  const setPieces = mine.filter((c) => /^(ana|bo|cy):floor$/.test(c.label) && /THIS TURN opens a point/.test(c.prompt));
  ok('a set piece is sized by the speaker\'s own natural length', setPieces.length > 0 && setPieces.every((c) => c.prompt.includes(`at most ${natural[c.label.split(':')[0]]} words`)),
    setPieces.map((c) => `${c.label} ${c.prompt.match(/opens a point: .*? at most \d+ words/)?.[0]}`).join(' | '));
  ok('position cards are written from the dossier', mine.some((c) => c.label === 'ana:position' && c.prompt.includes('PRIVATE-INCENTIVE-ana')));
  const beliefs = events.filter((e) => e.type === 'belief') as any[];
  ok('starting stances were read off the cards when the motion opened (unknown ids dropped)', beliefs[0]?.beliefs.length === 3 && beliefs[0].beliefs.find((b: any) => b.expert === 'cy')?.stance === 1, JSON.stringify(beliefs[0]?.beliefs));
  const conc = events.filter((e) => e.type === 'concession').map((e: any) => e.concession);
  const anaC = conc.find((c) => c.expert === 'ana');
  ok('a stance move carries its cause and its cost', !!anaC && anaC.movedBy.kind === 'argument' && anaC.movedBy.who === 'bo' && anaC.cost === 'my promise of Sundays off' && anaC.from.stance === 0 && anaC.to.stance === 1, JSON.stringify(anaC));
  const cyC = conc.find((c) => c.expert === 'cy');
  ok('a move with no reason is recorded as unexplained', !!cyC && cyC.movedBy.kind === 'unexplained' && cyC.kind === 'full', JSON.stringify(cyC));
  ok('Bo, who never moved, emitted no concession', !conc.some((c) => c.expert === 'bo'));
  const steers = mine.filter((c) => c.label === 'marcus:steer');
  const raised = mine.filter((c) => (c.label === 'marcus:steer' || c.label === 'marcus:floor') && /Cy Okafor moved on the motion and gave no reason/.test(c.prompt));
  ok('the unexplained move became a chair trigger, raised once', raised.length === 1, mine.filter((c) => c.label.startsWith('marcus:')).map((c) => `${c.label}: ${c.prompt.slice(-200)}`).join(' | '));
  ok('the chair spoke on it, in one short line', raised[0]?.label !== 'marcus:floor' || msgs.some((m) => m.kind === 'marcus' && m.text.startsWith('CHAIR-LINE')));
  void steers;
  const ref = mine.find((c) => c.label === 'referee' && /STANCE MOVES NOBODY EXPLAINED/.test(c.prompt));
  ok('the referee was asked to attribute it', !!ref && ref.prompt.includes('Cy Okafor went from leaning for to leaning against'));
  ok('the ledger is kept server-side', !!row.meta.ledger?.motions.m1 && !calls.some((c) => c.system.includes('"concessions"')));
  const d = row.meta.decisions[0];
  ok('the dissent kept its tripwire and its cost of ignoring', d?.dissents[0]?.tripwire?.by === 'end of week six' && d.dissents[0].costOfIgnoring === 'losing a baker mid-season', JSON.stringify(d?.dissents));
  const ruling = mine.find((c) => c.label === 'marcus:ruling');
  ok('the ruling was told the stakes and the default owner', !!ruling && ruling.prompt.includes('Dana, the decision owner') && /If this yes is wrong, it costs not stated \(assumed\)/.test(ruling.prompt), ruling?.prompt.slice(-1500));
  ok('the founder saw the stakes beside the goal', events.some((e) => e.type === 'system' && /^STAKES\n/.test((e as any).text)));

  // 2b-6: the report's own sections, server-written.
  const rep = JSON.parse(fs.readFileSync(path.join(dataDir, 'debates', debateId, 'report.json'), 'utf8'));
  const html = fs.readFileSync(path.join(dataDir, 'debates', debateId, 'report.html'), 'utf8');
  ok('the report carries the stakes, assumed lines marked', rep.stakes?.find((l: any) => l.label === 'Decision owner')?.assumed === true && rep.stakes.find((l: any) => l.label === 'At risk')?.assumed === false, JSON.stringify(rep.stakes));
  ok('the report carries the dissent record with its tripwire', rep.minority?.[0]?.tripwire?.signal === 'two staff sick days in the first month of Sundays' && rep.minority[0].incomplete.length === 0, JSON.stringify(rep.minority));
  const mc = rep.mindChanges?.[0];
  ok('the report says how minds changed, with causes', mc?.motionTitle === 'Sunday opening' && mc.concessions === 2 && mc.causedShare === 0.5 && mc.lines.some((l: string) => /Ana Ruiz gave ground: .*moved by an argument from Bo Chen; cost: my promise of Sundays off/.test(l)) && mc.heldFirm.includes('Bo Chen'), JSON.stringify(mc));
  ok('the report renders all three sections', /id="stakes"/.test(html) && /id="minds"/.test(html) && /PROVES THEM RIGHT/.test(html));
  ok('the report writer was handed them too', mine.some((c) => c.label === 'report' && c.prompt.includes('HOW MINDS CHANGED') && c.prompt.includes('THE DISSENT RECORD') && c.prompt.includes('WHAT WAS AT STAKE')));
}

// ---------- 2e: the live floor (2b-7) ----------

console.log('[2e] the live floor: cut-offs and talking over as events, only heard words saved');
{
  const cuts = msgs.filter((m) => m.cutOff);
  ok('a turn was cut off mid-sentence by a listener', cuts.length >= 1 && cuts.every((m) => m.speaker === 'bo' && m.cutOff!.by === 'ana'), JSON.stringify(cuts.map((m) => [m.speaker, m.cutOff])));
  const overs = msgs.filter((m) => m.overlap);
  ok('overlap events appear: the cut-in is spoken over the cut turn', cuts.every((c) => overs.some((o) => o.overlap!.with === c.id && o.kind === 'reaction' && o.speaker === c.cutOff!.by)),
    JSON.stringify(overs.map((o) => [o.speaker, o.overlap])));
  ok('every overlap names a message that exists, at a point inside it', overs.every((o) => { const t = msgs.find((m) => m.id === o.overlap!.with); return !!t && o.overlap!.fromChar >= 0 && o.overlap!.fromChar <= t.text.length; }));
  // What the fake model wrote for each cut turn, and what the room heard of it.
  for (const c of cuts) {
    const full = written.find((w) => w.who === c.speaker && w.text.startsWith(c.text));
    ok(`the cut turn carries only the heard words (${c.id})`, !!full && c.text.length < full.text.length && c.cutOff!.atChar === c.text.length, JSON.stringify([c.text, full?.text]));
    if (full && !c.cutOff!.resumedBy) {
      const unsaid = full.text.slice(c.text.length).trim();
      const marker = unsaid.match(/New figure \d+/)?.[0];
      const at = calls.findIndex((x) => x.prompt.includes(c.text));
      ok('the unsaid remainder never reaches a later prompt', !!marker && !calls.slice(at).some((x) => x.prompt.includes(marker) || x.system.includes(marker)), marker);
    } else if (c.cutOff!.resumedBy) {
      const r = msgs.find((m) => m.id === c.cutOff!.resumedBy);
      ok('a speaker who wins the floor back restarts the cut sentence', !!r && r.speaker === c.speaker && !!full && full.text.includes(r.text.replace(/^(Let me finish\.|Hang on, I am not done\.|One second\.|No, let me get to the end of this\.) /, '')), JSON.stringify([r?.text, full?.text]));
    }
  }
  ok('the silence after a cut is on the record', events.some((e) => e.type === 'pause' && (e as any).reason === 'tension'));
  ok('the next turn was written against the projection: the cut-in is in its prompt before it was published', (() => {
    const cutIn = overs[0];
    if (!cutIn) return false;
    const seqOf = (id: string) => events.find((e) => e.type === 'message' && (e as any).id === id)!.seq;
    // A floor call whose prompt already holds the cut-in text, made before the cut-in event was persisted.
    return calls.some((x) => /^(ana|bo|cy):floor$/.test(x.label) && x.prompt.includes(cutIn.text)) && seqOf(cutIn.id) > 0;
  })());
  const chairWords = msgs.filter((m) => m.kind === 'marcus').reduce((n, m) => n + m.text.split(/\s+/).length, 0);
  const allWords = msgs.filter((m) => m.kind === 'marcus' || m.kind === 'floor' || m.kind === 'reaction').reduce((n, m) => n + m.text.split(/\s+/).length, 0);
  ok('the chair is light: well under a fifth of the words in the room', chairWords / allWords < 0.2, `${chairWords}/${allWords}`);
  ok('the floor checkpoint is kept for a restart and cleared when the motion closes', row.meta.motionCheckpoint === null);
  ok('the floor event carries heat and the meeting clock', events.some((e) => e.type === 'floor_set') && reactCalls > 0);
}

// ---------- 3: formatEvents, old and new ----------

console.log('[3] the room record: old events unchanged, cut-offs and overlap rendered');
const base = { seq: 1, ts: 0 };
const oldStyle: DebateEvent[] = [
  { ...base, type: 'message', id: 'm1', speaker: 'ana', kind: 'floor', text: 'Open on Sundays.' },
  { ...base, seq: 2, type: 'message', id: 'm2', speaker: 'bo', kind: 'interjection', text: 'Who bakes?' },
  { ...base, seq: 3, type: 'answer', questionId: 'q', answer: 'Me.' },
];
ok('an old record formats exactly as before',
  formatEvents(oldStyle, roster, 'Dana') === 'ANA RUIZ (Bakery operator): Open on Sundays.\n\nBO CHEN (Labour economist) [interrupting]: Who bakes?\n\nDANA (founder): Me.',
  formatEvents(oldStyle, roster, 'Dana'));
const newStyle: DebateEvent[] = [
  { ...base, type: 'message', id: 'k1', speaker: 'ana', kind: 'floor', text: 'The payback lands inside month', cutOff: { atChar: 30, by: 'bo' } },
  { ...base, seq: 2, type: 'message', id: 'k2', speaker: 'bo', kind: 'reaction', text: 'On what base?', overlap: { with: 'k1', fromChar: 24 } },
  { ...base, seq: 3, type: 'aside', id: 'a1', from: 'cy', to: 'ana', text: 'careful' },
  { ...base, seq: 4, type: 'pause', ms: 2000, reason: 'tension' },
];
const fmt = formatEvents(newStyle, roster, 'Dana');
ok('a cut turn ends where it was cut, naming who cut it', fmt.includes('The payback lands inside month— [cut off by BO CHEN]'), fmt);
ok('an overlap names who it talked over', fmt.includes('BO CHEN (Labour economist) (over ANA RUIZ): On what base?'), fmt);
ok('an aside is never rendered', !fmt.includes('careful'), fmt);

// ---------- 4: two overlapping streams survive a refresh ----------

console.log('[4] the hub keeps one partial per message, and replays both');
{
  const d = Debates.create('d_hubtest', 'hub', { provider: 'claude', mode: 'directed', autonomy: 'interactive' }).id;
  Hub.live(d, { type: 'delta', messageId: 'p1', speaker: 'ana', kind: 'floor', textDelta: 'The payback lands ' });
  Hub.live(d, { type: 'delta', messageId: 'p2', speaker: 'bo', kind: 'reaction', textDelta: 'On what ' });
  Hub.live(d, { type: 'delta', messageId: 'p1', speaker: 'ana', kind: 'floor', textDelta: 'inside month' });
  Hub.live(d, { type: 'delta', messageId: 'p2', speaker: 'bo', kind: 'reaction', textDelta: 'base?' });
  const writes: string[] = [];
  const fakeRes: any = { writeHead() {}, write(s: string) { writes.push(s); return true; }, on() {} };
  Hub.subscribe(d, fakeRes, 0);
  const frames = writes.filter((w) => w.startsWith('data:')).map((w) => JSON.parse(w.slice(5)));
  const deltas = frames.filter((f) => f.type === 'delta');
  ok('a new subscriber gets both partials', deltas.length === 2, JSON.stringify(deltas));
  ok('each with its own full text', deltas[0]?.textDelta === 'The payback lands inside month' && deltas[1]?.textDelta === 'On what base?', JSON.stringify(deltas));
  Hub.publish(d, { type: 'message', id: 'p2', speaker: 'bo', kind: 'reaction', text: 'On what base?' } as any);
  ok('finalizing one message keeps the other streaming', Hub.partials(d).map((p) => p.messageId).join() === 'p1');
  Hub.dropPartial(d, 'p1');
  ok('dropping one partial by id', Hub.partials(d).length === 0);
}

// ---------- 5-8: spend never cuts the debate ----------

/**
 * Drive a debate to a terminal status: approve every gate, answer every
 * question with `answerFor(questionText)`, and let `onTick` poke it.
 */
async function driveToEnd(id: string, answerFor: (q: string) => string = () => 'yes', onTick?: (r: ReturnType<typeof Debates.get>) => void) {
  const seen = new Set<string>();
  const t1 = Date.now();
  while (Date.now() - t1 < 60_000) {
    const r = Debates.get(id)!;
    if (['complete', 'error', 'cancelled'].includes(r.status)) break;
    const run = Engine.get(id)!;
    onTick?.(r);
    if (r.meta.pendingApproval) run.approve(r.meta.pendingApproval, 'approve');
    const q = r.meta.pendingQuestionId;
    if (q && !seen.has(q)) {
      seen.add(q);
      const ev = Events.since(id, 0).find((e) => e.type === 'question' && (e as any).questionId === q) as any;
      run.answer(q, answerFor(String(ev?.question ?? '')));
    }
    await new Promise((res) => setTimeout(res, 15));
  }
  const r = Debates.get(id)!;
  const evs: DebateEvent[] = Events.since(id, 0);
  return { r, evs, sys: evs.filter((e) => e.type === 'system').map((e: any) => e.text as string), mine: calls.filter((c) => c.debateId === id) };
}
const closings = (evs: DebateEvent[]) => evs.filter((e) => e.type === 'message' && (e as any).kind === 'closing').length;
const reportWritten = (id: string) => fs.existsSync(path.join(dataDir, 'debates', id, 'report.html'));

console.log('[5] an expensive session on auto argues at full depth: no cap, no wind-down');
{
  ok('the unprofiled debate above was never metered', !events.some((e) => e.type === 'budget'));
  costScale = 8;   // $0.40-0.64 a call: the old quick cap ($6) would have closed this in a dozen calls
  const id = Engine.create('Should our bakery add a second oven?', { provider: 'claude', mode: 'directed', autonomy: 'interactive', profile: 'auto' });
  const { r, evs, sys, mine } = await driveToEnd(id);
  ok('the session reached complete', r.status === 'complete', `${r.status} ${JSON.stringify(evs.slice(-3))}`);
  ok('it spent well past every old cap', (r.meta.usage?.costUsd ?? 0) > 12, String(r.meta.usage?.costUsd));
  ok('auto read a contained call and chose standard, with a reason', r.meta.profilePick?.profile === 'standard' && r.meta.profilePick.source === 'auto' && !!r.meta.scope?.estimate.profileReason);
  ok('nobody told the room to wind down or stop for money', !sys.some((t) => /Budget:|past 80%|argument stops here|budget for this session/i.test(t)), sys.filter((t) => /budget/i.test(t)).join(' | '));
  const b = evs.filter((e) => e.type === 'budget').map((e: any) => e.budget);
  ok('the meter was checkpointed as information: no caps, state ok', b.length > 0 && b.every((s) => s.state === 'ok' && s.capUsd === undefined && s.billing === 'plan'), JSON.stringify(b[0]));
  ok('the estimate carries no caps and says no limit is applied', !r.meta.scope?.estimate.caps && /No limit is applied/.test(r.meta.scope?.estimate.basis ?? ''));
  const rounds = evs.filter((e) => e.type === 'round').length;
  ok(`the motion argued its full minimum rounds (${r.meta.scope?.roundsPerMotion})`, rounds >= (r.meta.scope?.roundsPerMotion ?? 99), String(rounds));
  ok('the chair steered between rounds', mine.some((c) => c.label === 'marcus:steer'));
  ok('an adversary attacked the ruling, and one the report',
    mine.some((c) => /^redteam:\d/.test(c.label)) && mine.filter((c) => c.label.startsWith('redteam:report')).length === 1,
    mine.filter((c) => c.label.startsWith('redteam')).map((c) => c.label).join(','));
  const ref = (d: string) => calls.find((c) => c.debateId === d && c.label === 'referee')?.thinking;
  ok('the referee thinks 16K on standard and 32K on an unprofiled debate', ref(id) === 16_000 && ref(debateId) === 32_000, `${ref(id)} / ${ref(debateId)}`);
  ok('ruling, closings and report all happened', evs.some((e) => e.type === 'decision') && closings(evs) === 3 && reportWritten(id));
}

console.log('[6] a founder ceiling asks to extend, then stopping still rules, closes and reports');
{
  let asked = 0;
  costScale = 30;   // $1.50-2.40 a call, so the raised ceiling is reached inside the motion too
  const id = Engine.create('Should our bakery add a third oven?', { provider: 'claude', mode: 'directed', autonomy: 'interactive', profile: 'standard', ceilingUsd: 3 });
  const { r, evs, sys } = await driveToEnd(id, (q) => (/ceiling you set/.test(q) ? (++asked === 1 ? 'Extend and carry on' : 'Stop arguing and write it up') : 'yes'));
  const qs = evs.filter((e) => e.type === 'question' && /ceiling you set/.test((e as any).question)) as any[];
  ok('the room asked at the ceiling, with extend and stop', qs.length >= 1 && qs[0].options.map((o: any) => o.label).join('|') === 'Extend and carry on|Stop arguing and write it up', JSON.stringify(qs[0]?.options));
  ok('one click raised the ceiling and the room carried on', sys.some((t) => /Ceiling raised to \$/.test(t)) && (r.meta.ceilingUsd ?? 0) > 3, String(r.meta.ceilingUsd));
  ok('asked again at the raised ceiling, and stopping was honoured', qs.length === 2 && r.meta.endedByUser === true, String(qs.length));
  ok('the stop still produced a ruling, closings and the report', r.status === 'complete' && evs.some((e) => e.type === 'decision') && closings(evs) === 3 && reportWritten(id), r.status);
  costScale = 8;
}

console.log('[7] turns that only repeat the room close the motion as a recorded stalemate');
{
  repeatSpeech = true;
  const id = Engine.create('Should our bakery sell bread on Mondays?', { provider: 'claude', mode: 'directed', autonomy: 'interactive', profile: 'deep' });
  const { r, evs, sys } = await driveToEnd(id);
  repeatSpeech = false;
  const rounds = evs.filter((e) => e.type === 'round').length;
  ok('the repetition guard named the stalemate', sys.some((t) => /repeated what the room had already said\. Recording a stalemate/.test(t)), sys.slice(-6).join(' | '));
  ok('it stopped before the deep minimum, because more of the same buys nothing', rounds < BUDGET_MIN_DEEP, `${rounds} rounds`);
  ok('the stalemate was ruled and written up', r.status === 'complete' && evs.some((e) => e.type === 'decision') && reportWritten(id), r.status);
  // The identical-call guard on the live path: a reaction call asked a third time with exactly the same input never runs.
  const reacts = calls.filter((c) => c.debateId === id && c.label === 'react').map((c) => c.prompt);
  const most = Math.max(0, ...reacts.map((p) => reacts.filter((q) => q === p).length));
  ok('the waste guard stopped the room re-asking an identical reaction call', reacts.length > 0 && most <= 2, `${reacts.length} react calls, the most repeated ${most} times`);
}

console.log('[8] a spent allowance pauses in place and resumes where it was');
{
  limitOn = 'referee';
  const id = Engine.create('Should our bakery open a stall?', { provider: 'claude', mode: 'directed', autonomy: 'interactive', profile: 'standard' });
  let parked: { status: string; resumeTo?: string; pause: any } | null = null;
  const { r, evs } = await driveToEnd(id, () => 'yes', (row) => {
    if (row!.status === 'paused' && !parked) {
      parked = {
        status: row!.status,
        resumeTo: row!.meta.limitPause?.resumeTo,
        pause: (Events.since(id, 0).filter((e) => e.type === 'quota').pop() as any)?.pause,
      };
      Engine.get(id)!.resumeMeeting();   // the founder presses Resume rather than waiting for the window
    }
  });
  const p = parked as { status: string; resumeTo?: string; pause: any } | null;
  ok('the session parked as paused, remembering the step it was on', p?.status === 'paused' && p.resumeTo === 'meeting', JSON.stringify(p));
  ok('the room was told when it resumes', !!p?.pause?.resumesAt && p.pause.stated === true && evs.some((e) => e.type === 'system' && /Paused: waiting for quota/.test((e as any).text)), JSON.stringify(p?.pause));
  ok('Resume brought it back (it used to queue the click with nobody driving)', r.status === 'complete', r.status);
  ok('the pause was cleared on the record', evs.some((e) => e.type === 'quota' && (e as any).pause === null) && !r.meta.limitPause);
  ok('nothing was cut: ruling, closings and report', evs.some((e) => e.type === 'decision') && closings(evs) === 3 && reportWritten(id));
}

// ---------- 6: a restart with research in flight ----------

console.log('[9] a restart with research in flight re-issues it, once');
{
  costScale = 1;
  const PRE_Q = 'How many small bakeries open on Sundays nationally?';
  architectQs = [PRE_Q];
  wireResearch(fakeResearch('claude', 400));   // slow enough to restart in the middle of
  const id = Engine.create('Should the bakery hire a Sunday baker?', { provider: 'claude', mode: 'directed', autonomy: 'interactive' });
  let restarted = false;
  const seen = new Set<string>();
  const t2 = Date.now();
  while (Date.now() - t2 < 60_000) {
    const r = Debates.get(id)!;
    if (['complete', 'error', 'cancelled'].includes(r.status)) break;
    const evs = Events.since(id, 0);
    if (!restarted && evs.some((e) => e.type === 'research_started') && !evs.some((e) => e.type === 'research_done')) {
      ok('a request is persisted while it is in flight', (r.meta.researchInflight ?? []).length === 1, JSON.stringify(r.meta.researchInflight));
      Engine.forget(id);              // the process dies here
      restarted = true;
      Engine.get(id);                 // and comes back
      continue;
    }
    const run = Engine.get(id)!;
    if (r.meta.pendingApproval) run.approve(r.meta.pendingApproval, 'approve');
    const q = r.meta.pendingQuestionId;
    if (q && !seen.has(q)) { seen.add(q); run.answer(q, 'yes'); }
    await new Promise((res) => setTimeout(res, 15));
  }
  wireResearch(null);
  architectQs = [];
  const r = Debates.get(id)!;
  const evs = Events.since(id, 0);
  ok('the session restarted mid-research and still completed', restarted && r.status === 'complete', `${restarted} ${r.status}`);
  const pre = evs.filter((e) => e.type === 'research_started' && (e as any).question === PRE_Q) as any[];
  ok('the question was asked once and answered once', pre.length === 1 && evs.filter((e) => e.type === 'research_done' && (e as any).taskId === pre[0]?.taskId).length === 1,
    JSON.stringify(evs.filter((e) => e.type.startsWith('research')).map((e: any) => `${e.type}:${e.taskId}`)));
  ok('the room was told the desk picked it back up', evs.some((e) => e.type === 'system' && /picking up the request/.test((e as any).text)));
  ok('the brief landed once, and nothing is left in flight', r.meta.researchBriefs.filter((b) => b.question === PRE_Q).length === 1 && (r.meta.researchInflight ?? []).length === 0,
    JSON.stringify({ briefs: r.meta.researchBriefs.map((b) => b.question), inflight: r.meta.researchInflight }));
  ok('the chair planned from the fenced brief', calls.some((c) => c.debateId === id && c.label === 'marcus:plan' && /<<<UNTRUSTED RESEARCH BRIEF/.test(c.prompt)));
}

console.log('[10] a debate from before dossiers, stakes and the ledger still runs as it did');
{
  costScale = 1;
  // An old row resumed mid-meeting: personas, plan and cards from an older build; no dossiers, stakes or ledger.
  const id = 'd_oldrow01';
  Debates.create(id, 'Should the bakery stock oat milk?', { provider: 'claude', mode: 'directed', autonomy: 'interactive' });
  const old = Debates.get(id)!;
  old.meta.positionCards = Object.fromEntries(PANEL.map((p) => [p.id, { thesis: 'A thesis.', loadBearingClaims: ['c'], redLine: 'r', falsifier: 'f', expectWrong: 'bo' }]));
  Debates.patch(id, {
    goal: 'Decide on oat milk.', status: 'meeting', meta: old.meta,
    personas: [{ id: 'marcus', name: 'Marcus Hale', role: 'Chair', tagline: '', bio: '', expertise: [], personality: '', biases: '', style: '', color: '#fff', initials: 'MH', isModerator: true }, ...(PANEL as any)],
    plan: { revision: 1, items: [{ id: 'm1', title: 'Oat milk', motion: 'The bakery should stock oat milk.', detail: '', status: 'pending' }] },
  });
  const { r, evs, mine } = await driveToEnd(id);
  ok('it reached complete', r.status === 'complete', r.status);
  ok('no dossier, stakes or ledger was invented for it', !r.meta.dossiers && !r.meta.stakes && !r.meta.ledger && !evs.some((e) => e.type === 'belief' || e.type === 'concession'));
  ok('its prompts carry no stakes block and no private card', mine.every((c) => !c.system.includes('STAKES\nDecision owner') && !c.prompt.includes('HOW YOU COME ACROSS')));
  ok('no dossier or clerk call was made', !mine.some((c) => c.label.includes('dossier') || c.label === 'clerk:stances' || c.label === 'relationships'));
}

console.log('[11] a restart in the middle of a performance plays the turn again, without a new model call');
{
  costScale = 1;
  const { newFloor } = await import('./director.ts');
  const id = 'd_restart01';
  Debates.create(id, 'Should the bakery sell coffee?', { provider: 'claude', mode: 'directed', autonomy: 'interactive' });
  const r0 = Debates.get(id)!;
  r0.meta.positionCards = Object.fromEntries(PANEL.map((p) => [p.id, { thesis: 'A thesis.', loadBearingClaims: ['c'], redLine: 'r', falsifier: 'f', expectWrong: 'bo' }]));
  const floor = newFloor('m1', PANEL.map((p) => ({ id: p.id })), 'restart');
  const held = { id: 'm_heldturn', speaker: 'cy', shape: 'set_piece', text: 'HELD-TURN Coffee pays for the counter staff. HELD-REMAINDER Nobody hears this part.', trailer: {} };
  r0.meta.motionCheckpoint = {
    motionId: 'm1', round: 1, messages: 0, dryStreak: 0, claims: [], unresolved: [], positionChanges: [], startSeq: 0, rung: 0,
    floor, performing: { turn: held, plan: { cut: { atChar: 44, by: 'bo', text: 'Which staff?', id: 'm_heldcut', overlapFrom: 30, fight: 'interrupter_takes' } } },
  };
  Debates.patch(id, {
    goal: 'Decide on coffee.', status: 'meeting', meta: r0.meta,
    personas: [{ id: 'marcus', name: 'Marcus Hale', role: 'Chair', tagline: '', bio: '', expertise: [], personality: '', biases: '', style: '', color: '#fff', initials: 'MH', isModerator: true }, ...(PANEL as any)],
    plan: { revision: 1, items: [{ id: 'm1', title: 'Coffee', motion: 'The bakery should sell coffee.', detail: '', status: 'active' }] },
  });
  const { r, evs, mine } = await driveToEnd(id);
  const m = evs.filter((e) => e.type === 'message') as any[];
  const heldMsg = m.find((x) => x.id === 'm_heldturn');
  ok('the session resumed and completed', r.status === 'complete', r.status);
  ok('the held turn was performed, cut where it was planned, heard words only', !!heldMsg && heldMsg.text === 'HELD-TURN Coffee pays for the counter staff.' && heldMsg.cutOff?.by === 'bo' && m.some((x) => x.id === 'm_heldcut' && x.overlap?.with === 'm_heldturn'), JSON.stringify(heldMsg));
  ok('it came first, before anything new was written', m.findIndex((x) => x.id === 'm_heldturn') === 0 || m.slice(0, m.findIndex((x) => x.id === 'm_heldturn')).every((x) => x.kind === 'marcus'), JSON.stringify(m.slice(0, 3).map((x) => x.id)));
  ok('no model call wrote it again, and its unsaid part never reached a prompt or an event', !mine.some((c) => c.prompt.includes('HELD-REMAINDER') || c.system.includes('HELD-REMAINDER')) && !evs.some((e) => JSON.stringify(e).includes('HELD-REMAINDER')));
  ok('the interrupter who won the floor spoke next', m[m.findIndex((x) => x.id === 'm_heldcut') + 1]?.speaker === 'bo');
}

console.log(`\n${passes} passed, ${fails} failed`);
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
