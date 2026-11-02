/**
 * Budget, after the owner's "quality over cost" decision: the meter is
 * information only, profiles shape depth, 'auto' sends hard calls deep, the
 * optional ceiling asks rather than cuts, quota pauses resume on a schedule,
 * and the waste guards stop duplicates and repetition, never argument. Plus
 * the semaphore's research reservation. Offline; no model, no network.
 *   npx tsx src/budget.selftest.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-budget-test-'));
process.env.MAX_AGENTS = '4';
process.env.AGENT_CLI_PATH = '/usr/bin/false';

const { budgetSnapshot, profileOf, pickProfile, ceilingOf, extendCeiling, ceilingQuestion, nextLimitTry, CEILING_STOP } = await import('./budget.ts');
const B = await import('../../shared/budget.ts');
const { BUDGET_PROFILES, QUOTA, WASTE } = B;
const { scopeFrom, projectTurns, estimateCost } = await import('./scope.ts');
const { Semaphore, slotUsage, SLOTS, asUsageLimit, parseRetryAfter, wireAgents, runAgent, runJsonAgent } = await import('./agents/sdk.ts');
const { Waste, isWasteGuard } = await import('./agents/waste.ts');
const { NoveltyLedger, staleRun } = await import('./engine/novelty.ts');

let fails = 0;
let passes = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) passes++;
  else fails++;
  console.log(`${cond ? '  ok  ' : '  FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};
const zero = { usd: 0, output: 0, flagshipCalls: 0, calls: 0, turns: 0 };

console.log('[1] the meter is information only');
{
  ok('no cap, wind-down or close threshold is exported any more',
    !('WIND_DOWN_AT' in B) && !('CLOSE_AT' in B) && !('RESERVE' in B) && Object.values(BUDGET_PROFILES).every((p) => !('usdCap' in p) && !('turnCap' in p) && !('callCap' in p)));
  const est = { lowUsd: 6, highUsd: 10 };
  const s = budgetSnapshot('standard', 'claude', zero, { estimate: est });
  ok('before anyone speaks, the projection is the middle of the estimate', s.projectedUsd === 8, String(s.projectedUsd));
  ok('it carries the estimate for estimate-vs-actual', s.estimateLowUsd === 6 && s.estimateHighUsd === 10);
  const huge = budgetSnapshot('standard', 'claude', { usd: 500, output: 9e6, flagshipCalls: 4000, calls: 9000, turns: 3000 }, { estimate: est });
  ok('any spend at all with no ceiling stays ok (nothing acts on it)', huge.state === 'ok' && huge.ceilingUsd === null, JSON.stringify(huge));
  ok('Claude reads as plan-equivalent, OpenAI as pay-per-use, Codex as none',
    s.billing === 'plan' && budgetSnapshot('standard', 'openai', zero).billing === 'payg' && budgetSnapshot('standard', 'codex', zero).billing === 'none');
  ok('the projection carries the rate to the expected turns',
    Math.abs(budgetSnapshot('standard', 'claude', { ...zero, usd: 2, turns: 10 }, { expectedTurns: 40 }).projectedUsd - 8) < 0.01);
  ok('Codex projects no dollars', budgetSnapshot('standard', 'codex', { ...zero, usd: 3, turns: 2 }).projectedUsd === 0);
  const at = budgetSnapshot('quick', 'openai', { ...zero, usd: 12 }, { ceilingUsd: 10 });
  ok('a founder ceiling shows on the meter and marks the state', at.state === 'ceiling' && at.ceilingUsd === 10);
  ok('Codex ignores a ceiling (no dollars to hold it against)', budgetSnapshot('quick', 'codex', { ...zero, usd: 12 }, { ceilingUsd: 10 }).state === 'ok');
}

console.log('[2] profiles shape depth; auto sends hard calls deep');
{
  ok('profiles grow in depth: experts, motions, rounds, adversaries',
    BUDGET_PROFILES.quick.maxExperts < BUDGET_PROFILES.deep.maxExperts && BUDGET_PROFILES.quick.minRounds < BUDGET_PROFILES.deep.minRounds
    && BUDGET_PROFILES.standard.adversarySeats <= BUDGET_PROFILES.deep.adversarySeats);
  ok('every profile has at least one adversary on rulings and on the report',
    Object.values(BUDGET_PROFILES).every((p) => p.adversarySeats >= 1 && p.reportAdversarySeats >= 1));
  ok('blurbs describe process, not dollars', Object.values(BUDGET_PROFILES).every((p) => !/\$|never more than/.test(p.blurb)));
  ok("'auto' runs as standard until the intake has read the ask", profileOf({ profile: 'auto' }) === 'standard');
  ok('a persisted pick wins over the setup choice', profileOf({ profile: 'auto' }, { profile: 'deep' }) === 'deep' && profileOf({ profile: 'quick' }, { profile: 'standard' }) === 'standard');
  ok('an explicit profile stands', profileOf({ profile: 'quick' }) === 'quick');
  ok('a debate from before profiles stays unprofiled', profileOf({}) === null);
  const read = (o: Partial<{ decisions: number; disciplines: number; depth: 'quick' | 'standard' | 'exhaustive' }>) =>
    ({ decisions: 1, disciplines: 3, depth: 'standard' as const, rationale: '', ...o });
  ok('the intake asking for exhaustive depth goes deep', pickProfile(read({ depth: 'exhaustive' }), 'a plain topic').profile === 'deep');
  ok('more decisions than standard seats goes deep', pickProfile(read({ decisions: 4 }), 'x').profile === 'deep');
  ok('more disciplines than standard seats goes deep', pickProfile(read({ disciplines: 4 }), 'x').profile === 'deep');
  const stakes = pickProfile(read({}), 'Should we accept the term sheet and raise a $4m seed round?');
  ok('a high-stakes brief goes deep, and says why', stakes.profile === 'deep' && /term sheet|\$4m/i.test(stakes.reason), stakes.reason);
  ok('the stakes words do not override an intake that called it quick', pickProfile(read({ depth: 'quick' }), 'a quick lawsuit question').profile === 'standard');
  ok('a contained call stays standard; auto never picks quick', pickProfile(read({}), 'Which day should the bakery close?').profile === 'standard');
}

console.log('[3] scope: the profile shapes the session; the estimate is informational');
{
  const read = { decisions: 5, disciplines: 9, depth: 'standard' as const, rationale: 'Big ask.' };
  const q = scopeFrom(read, 'claude', false, 'quick');
  ok('quick seats its smaller panel and agenda', q.experts === 3 && q.motions === 1, `${q.experts}/${q.motions}`);
  ok('the rationale points at deep for the full shape', /choose deep/.test(q.rationale), q.rationale);
  ok('the estimate carries no caps', !q.estimate.caps && q.estimate.profile === 'quick');
  ok('the basis warns the estimate is uncalibrated and says no limit is applied', /No limit is applied/.test(q.estimate.basis) && /Uncalibrated estimate/.test(q.estimate.basis) && /much higher/.test(q.estimate.basis), q.estimate.basis);
  ok('the basis does not promise a stop', !/stops the session|winds down|80%/.test(q.estimate.basis));
  const free = scopeFrom(read, 'claude', false, null);
  ok('an unprofiled debate is sized as before', free.experts === 11 && free.motions === 5 && free.roundsPerMotion === 3, `${free.experts}/${free.motions}/${free.roundsPerMotion}`);
  const d = scopeFrom(read, 'claude', false, 'deep');
  ok('deep seats the bigger panel and argues at least its minimum rounds', d.experts === 8 && d.motions === 5 && d.roundsPerMotion === BUDGET_PROFILES.deep.minRounds, `${d.experts}/${d.motions}/${d.roundsPerMotion}`);
  const t = projectTurns({ experts: 8, motions: 6, roundsPerMotion: 10, depth: 'exhaustive', rationale: '' }, false, 'quick');
  ok('spoken turns are projected in full, never clipped', t.floor >= 6 * 10 * 7 && t.reactionTurns === 210 && t.react >= 6 * 10 * 4, JSON.stringify(t));
  const big = estimateCost({ experts: 8, motions: 6, roundsPerMotion: 10, depth: 'exhaustive', rationale: '' }, 'claude', false, 'deep');
  ok('a big estimate is shown as it is, not clipped to any figure', big.highUsd > 45, String(big.highUsd));
  const c = estimateCost({ experts: 4, motions: 2, roundsPerMotion: 3, depth: 'standard', rationale: '' }, 'codex', false, 'standard', 30);
  ok('Codex: no dollars and no ceiling', c.lowUsd === 0 && c.ceilingUsd === null);
  const withCeiling = estimateCost({ experts: 4, motions: 2, roundsPerMotion: 3, depth: 'standard', rationale: '' }, 'openai', false, 'standard', 30);
  ok('a founder ceiling is stated beside the estimate, as a question not a cut', withCeiling.ceilingUsd === 30 && /asked whether to extend/.test(withCeiling.basis), withCeiling.basis);
}

console.log('[4] the optional ceiling asks, it never cuts');
{
  ok('off by default', ceilingOf('claude', undefined, undefined, null) === null);
  ok('BUDGET_CEILING_USD applies when the debate sets none', ceilingOf('claude', undefined, undefined, 40) === 40);
  ok("the debate's own beats the env; an extension beats both", ceilingOf('openai', undefined, 20, 40) === 20 && ceilingOf('openai', 35, 20, 40) === 35);
  ok('Codex has none', ceilingOf('codex', undefined, 20, 40) === null);
  ok('one click adds half (at least $5) above what is spent', extendCeiling(20, 21) === 31 && extendCeiling(4, 4) === 9);
  const q = ceilingQuestion(21, 20, 'payg');
  ok('the question offers extend and stop, and promises nothing is cut',
    q.options.length === 2 && q.options[1].label === CEILING_STOP && /Nothing has been cut/.test(q.context) && /OpenAI key/.test(q.question), JSON.stringify(q));
}

console.log('[5] quota pauses resume on a schedule');
{
  const now = Date.UTC(2026, 9, 26, 12, 0);
  ok('a stated reset wakes just after it', nextLimitTry({ resetAt: now + 3600_000, attempts: 1 }, now) === now + 3600_000 + QUOTA.afterResetMs);
  ok('a reset already past still waits the minimum', nextLimitTry({ resetAt: now - 10 * 60_000, attempts: 1 }, now) === now + QUOTA.minWaitMs);
  const waits = [1, 2, 3, 4, 5, 6, 9].map((a) => nextLimitTry({ resetAt: null, attempts: a }, now) - now);
  ok('no stated reset: doubling backoff from the first wait', waits[0] === QUOTA.firstBackoffMs && waits[1] === 2 * QUOTA.firstBackoffMs, waits.join(','));
  ok('the backoff is capped', waits.every((w) => w <= QUOTA.maxBackoffMs) && waits[6] === QUOTA.maxBackoffMs, waits.join(','));
  ok('the give-up bound outlasts a weekly window', QUOTA.giveUpAfterMs > 7 * 24 * 3600_000);
  ok('Retry-After seconds are read', parseRetryAfter('429 rate limit from OpenAI (retry after 20s): slow down', now) === now + 20_000);
  ok('"try again in 3 minutes" is read', parseRetryAfter('Rate limit reached. Please try again in 3 minutes.', now) === now + 180_000);
  ok('nothing to read gives null', parseRetryAfter('429 too many requests', now) === null);
  const lim = asUsageLimit(new Error('429 rate limit from OpenAI (retry after 30s): too many requests'));
  ok('a 429 with Retry-After becomes a limit with a reset time', !!lim && lim.resetAt !== null && lim.resetAt > Date.now(), String(lim?.resetAt));
  const claude = asUsageLimit(new Error("You've hit your session limit · resets 5:20pm (Europe/London)"));
  ok('the Claude 5-hour wording still parses as a session limit with a clock reset', !!claude && claude.kind === 'session' && claude.resetAt !== null);
}

console.log('[6] the waste guards: duplicates and loops, never argument');
{
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  wireAgents({
    async run(opts) {
      calls++;
      if (opts.label === 'slow') await gate;
      return { text: `reply to ${opts.prompt}`, sessionId: null, costUsd: 0, usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, toolCalls: [] };
    },
    async runJson() {
      calls++;
      return { value: { ok: true } };
    },
  });
  const base = { model: 'claude-opus-5-5', system: 'S', debateId: 'd_waste1' };
  const a = runAgent({ ...base, prompt: 'same', label: 'slow' });
  const b = runAgent({ ...base, prompt: 'same', label: 'slow' });
  release();
  const [ra, rb] = await Promise.all([a, b]);
  ok('an identical call already in flight is shared, not run twice', calls === 1 && ra.text === rb.text, String(calls));
  await runAgent({ ...base, prompt: 'same', label: 'slow' });
  ok('a second identical success is allowed', calls === 2, String(calls));
  let refused: unknown = null;
  try { await runAgent({ ...base, prompt: 'same', label: 'slow' }); } catch (e) { refused = e; }
  ok(`after ${WASTE.maxIdenticalCalls} identical successes the next is refused as a loop`, isWasteGuard(refused) && calls === 2, String(refused));
  await runAgent({ ...base, prompt: 'different', label: 'slow' });
  ok('a different prompt is always a different call', calls === 3);
  await runAgent({ ...base, prompt: 'same', label: 'redteam:2' });
  ok('a different seat with the same prompt is a different call (adversary seats stay independent)', calls === 4);
  await runAgent({ ...base, debateId: 'd_waste2', prompt: 'same', label: 'slow' });
  ok('another debate is not affected', calls === 5);
  await runJsonAgent({ ...base, prompt: 'json', label: 'j' });
  await runJsonAgent({ ...base, prompt: 'json', label: 'j' });
  let jr: unknown = null;
  try { await runJsonAgent({ ...base, prompt: 'json', label: 'j' }); } catch (e) { jr = e; }
  ok('JSON calls are guarded the same way', isWasteGuard(jr) && calls === 7, String(calls));
  ok('the guard counts what it spared', Waste.spared('d_waste1') === 3, String(Waste.spared('d_waste1')));
  Waste.drop('d_waste1');
  await runAgent({ ...base, prompt: 'same', label: 'slow' });
  ok('dropping a debate forgets its history', calls === 8);
  wireAgents(null);
  ok('retry counts come from the one config file', WASTE.agentRetries >= 1 && WASTE.jsonRepairs >= 1);
}

console.log('[7] the repetition check');
{
  const ledger = new NoveltyLedger(['Sunday trade is real but the question is who bakes at five in the morning every weekend.']);
  const repeat = 'Sunday trade is real but the question is who bakes at five in the morning every weekend, honestly.';
  const fresh = 'A rota of two part-timers covers the five o\'clock bake for about four hundred pounds a month, which the footfall data pays for.';
  ok('a restatement scores near zero novelty', (ledger.novelty(repeat) ?? 1) < WASTE.minNovelty, String(ledger.novelty(repeat)));
  ok('a turn with a new mechanism and number scores high', (ledger.novelty(fresh) ?? 0) > 0.6, String(ledger.novelty(fresh)));
  ok('a one-line reaction is not judged', ledger.novelty('On what base?') === null);
  const l2 = new NoveltyLedger(['Sunday trade is real but the question is who bakes at five in the morning every weekend.']);
  ok('repeats count up, a short reaction leaves the run alone, something new resets it',
    staleRun(0, [repeat, repeat, 'On what base?'], l2) === 2 && staleRun(2, [fresh], l2) === 0);
  ok('the stalemate threshold lives in the config', WASTE.staleTurnsToClose >= 3);
}

console.log('[8] the semaphore keeps a slot for research and never lets research crowd out the floor');
{
  ok('defaults: 4 slots, research at most 2', SLOTS.total === 4 && SLOTS.researchSlots === 2, `${SLOTS.total}/${SLOTS.researchSlots}`);
  let critical = 0;
  const held: Promise<void>[] = [];
  for (let i = 0; i < 5; i++) held.push(Semaphore.acquire('critical').then(() => { critical++; }));
  await new Promise((r) => setTimeout(r, 10));
  ok('the critical path takes 3 slots and waits for a 4th', critical === 3 && slotUsage().waiting === 2, JSON.stringify(slotUsage()));
  let research = 0;
  const r1 = Semaphore.acquire('research').then(() => { research++; });
  await new Promise((r) => setTimeout(r, 10));
  ok('research starts in its reserved slot while the floor is full', research === 1, JSON.stringify(slotUsage()));
  Semaphore.release('critical');
  await new Promise((r) => setTimeout(r, 10));
  ok('a freed slot goes to a waiting critical turn', critical === 4, JSON.stringify(slotUsage()));
  const r2 = Semaphore.acquire('research').then(() => { research++; });
  const r3 = Semaphore.acquire('research').then(() => { research++; });
  Semaphore.release('critical');
  Semaphore.release('critical');
  await new Promise((r) => setTimeout(r, 10));
  ok('research never holds more than its two slots, and the third waits', slotUsage().research === 2 && research === 2 && slotUsage().waiting === 1, JSON.stringify(slotUsage()));
  void held; void r1; void r2; void r3;   // left held: the process exits below
}

console.log(`\n${passes} passed, ${fails} failed`);
fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
