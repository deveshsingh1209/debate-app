/**
 * The web reducer, offline: refresh with two overlapping streams, the new
 * realism events, and an old debate folding exactly as it did before.
 *   npx tsx web/src/lib/debate-state.selftest.ts
 */
import { initialState, reducer, type DebateState } from './debate-state';
import type { DebateDetail, DebateEvent, WireFrame } from '../../../shared/types';
import { emptyUsage } from '../../../shared/types';

let fails = 0;
let passes = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) passes++;
  else fails++;
  console.log(`${cond ? '  ok  ' : '  FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};

const persona = (id: string, name: string) => ({ id, name, role: 'r', tagline: '', bio: '', expertise: [], personality: '', biases: '', style: '', color: '#fff', initials: name.slice(0, 2) });
const detail = (events: DebateEvent[]): DebateDetail => ({
  id: 'd1', title: 'T', status: 'meeting', config: { provider: 'claude', mode: 'directed', autonomy: 'interactive' },
  createdAt: 0, updatedAt: 0, messageCount: 0, topic: 't', ownerName: 'Dana', goal: 'g',
  personas: [persona('ana', 'Ana Ruiz'), persona('bo', 'Bo Chen')], plan: null, events,
  pendingQuestion: null, pendingApproval: null, decisions: [], activeMotionId: null,
  hasReport: false, hasPdf: false, usage: emptyUsage(),
});
const fold = (s: DebateState, frames: WireFrame[]) => frames.reduce((acc, frame) => reducer(acc, { type: 'frame', frame }), s);

console.log('[1] an old debate folds as before');
{
  const evs: DebateEvent[] = [
    { seq: 1, ts: 1, type: 'status', status: 'meeting' },
    { seq: 2, ts: 2, type: 'message', id: 'm1', speaker: 'ana', kind: 'floor', text: 'Open.' },
    { seq: 3, ts: 3, type: 'bids', round: 1, bids: [{ speaker: 'bo', urgency: 7, hook: 'no' }] },
    { seq: 4, ts: 4, type: 'message', id: 'm2', speaker: 'quant', kind: 'quant', text: 'figures' },
  ];
  const s = reducer(initialState, { type: 'bootstrap', detail: detail(evs) });
  ok('the old message is in the feed', s.feed.some((f) => f.fk === 'msg' && f.key === 'm1'));
  ok('the quant desk still gets no bubble', !s.feed.some((f) => f.fk === 'msg' && f.key === 'm2'));
  ok('old bids still fold', s.lastBids?.bids.length === 1);
  ok('no streams, no budget, no floor', s.streams.length === 0 && s.budget === null && s.floor === null);
}

console.log('[2] two overlapping streams, and a refresh in the middle of them');
{
  let s = reducer(initialState, { type: 'bootstrap', detail: detail([]) });
  s = fold(s, [
    { type: 'delta', messageId: 'p1', speaker: 'ana', kind: 'floor', textDelta: 'The payback lands ' },
    { type: 'delta', messageId: 'p2', speaker: 'bo', kind: 'reaction', textDelta: 'On what ' },
    { type: 'delta', messageId: 'p1', speaker: 'ana', kind: 'floor', textDelta: 'inside month' },
  ]);
  ok('both stream at once', s.streams.length === 2 && s.streams[0].text === 'The payback lands inside month', JSON.stringify(s.streams));
  // A refresh: fresh bootstrap, then the hub's replay of each partial as one synthetic delta.
  let r = reducer(initialState, { type: 'bootstrap', detail: detail([]) });
  r = fold(r, [
    { type: 'delta', messageId: 'p1', speaker: 'ana', kind: 'floor', textDelta: 'The payback lands inside month' },
    { type: 'delta', messageId: 'p2', speaker: 'bo', kind: 'reaction', textDelta: 'On what ' },
  ]);
  ok('a refresh reconstructs both streams', r.streams.map((m) => `${m.id}:${m.text}`).join('|') === 'p1:The payback lands inside month|p2:On what ', JSON.stringify(r.streams));
  s = fold(s, [{ seq: 10, ts: 10, type: 'message', id: 'p1', speaker: 'ana', kind: 'floor', text: 'The payback lands inside month', cutOff: { atChar: 30, by: 'bo' } }]);
  ok('finalizing the cut turn leaves the other streaming', s.streams.length === 1 && s.streams[0].id === 'p2');
  s = fold(s, [{ seq: 11, ts: 11, type: 'message', id: 'p2', speaker: 'bo', kind: 'reaction', text: 'On what base?', overlap: { with: 'p1', fromChar: 24 } }]);
  ok('the reaction is a real turn in the feed', s.streams.length === 0 && s.feed.some((f) => f.fk === 'msg' && f.ev.kind === 'reaction'));
  const cutMsg = s.feed.find((f) => f.fk === 'msg' && f.key === 'p1');
  ok('the cut-off rides on the message', cutMsg?.fk === 'msg' && cutMsg.ev.cutOff?.by === 'bo');
  const late = fold(s, [{ type: 'delta', messageId: 'p1', speaker: 'ana', kind: 'floor', textDelta: ' late' }]);
  ok('a late delta for a finished message is ignored', late.streams.length === 0);
  const orphan = fold(s, [
    { type: 'delta', messageId: 'p9', speaker: 'ana', kind: 'floor', textDelta: 'never finished' },
    { seq: 12, ts: 12, type: 'status', status: 'reporting' },
  ]);
  ok('a stream never finalized is cleared when the room stops', orphan.streams.length === 0);
}

console.log('[3] the new events');
{
  let s = reducer(initialState, { type: 'bootstrap', detail: detail([]) });
  s = fold(s, [
    { seq: 1, ts: 1, type: 'aside', id: 'a1', from: 'ana', to: 'bo', text: 'watch this' },
    { seq: 2, ts: 2, type: 'pause', ms: 3000, reason: 'after_concession' },
    { seq: 3, ts: 3, type: 'concession', concession: { motionId: 'm', expert: 'bo', from: { stance: -1, confidence: 'high' }, to: { stance: 0, confidence: 'medium' }, kind: 'partial', movedBy: { kind: 'evidence', ref: 'c_1' }, cost: 'a red line', messageId: 'x' } },
    { seq: 4, ts: 4, type: 'floor', motionId: 'm', heat: { ana: 0.7 }, handsUp: ['bo'], clock: { elapsedSec: 60, slotSec: 600 } },
    { seq: 5, ts: 5, type: 'belief', motionId: 'm', beliefs: [] },
    { type: 'budget', budget: { profile: 'standard', spentUsd: 1, capUsd: 12, outputTokens: 0, outputCap: 1, flagshipCalls: 0, flagshipCap: 1, calls: 0, callCap: 1, turns: 0, turnCap: 1, projectedUsd: 2, pressure: 0.1, binding: 'usd', state: 'ok' } },
    { type: 'delta', messageId: 'zz', speaker: 'ana', kind: 'floor', textDelta: 'x' },
    { seq: 6, ts: 6, type: 'some_future_event' } as any,
  ]);
  ok('the aside is shown to the founder', s.feed.some((f) => f.fk === 'aside' && f.text === 'watch this'));
  ok('the pause is a line', s.feed.some((f) => f.fk === 'pause' && f.ms === 3000));
  ok('the concession is a chip', s.feed.some((f) => f.fk === 'concession'));
  ok('the floor checkpoint is held', s.floor?.handsUp[0] === 'bo');
  ok('an old capped-era budget frame still folds', s.budget?.capUsd === 12);
  ok('an unknown future event does not crash or change the feed', s.feed.length === 3 && s.lastSeq === 6);
}

console.log('[4] research with sources (2b-4), and an old research event');
{
  const cite = { id: 'c_0123abcd', url: 'https://example.org/a', title: 'A', retrievedAt: 0, provenance: 'model_reported' as const, provider: 'codex' as const };
  let s = reducer(initialState, { type: 'bootstrap', detail: detail([]) });
  s = fold(s, [
    { seq: 1, ts: 1, type: 'research_started', taskId: 'r1', question: 'Q?' },
    { seq: 2, ts: 2, type: 'research_done', taskId: 'r1', summary: 'short', result: { requestId: 'r1', status: 'ok', summary: 'The full summary [c_0123abcd].', spoken: 's', findings: [], citations: [cite], searches: 1, durationMs: 1, costUsd: 0, provider: 'codex', model: 'm' } },
    { seq: 3, ts: 3, type: 'research_started', taskId: 'r2', question: 'Old?' },
    { seq: 4, ts: 4, type: 'research_done', taskId: 'r2', summary: 'An old brief, no result.' },
  ]);
  ok('the result\'s summary and citations are held', s.research.r1?.summary === 'The full summary [c_0123abcd].' && s.research.r1.citations?.[0]?.provenance === 'model_reported');
  ok('an old research_done still folds, summary only', s.research.r2?.summary === 'An old brief, no result.' && !s.research.r2.citations);
}

console.log('[5] the info-only meter and a quota pause');
{
  let s = reducer(initialState, { type: 'bootstrap', detail: detail([]) });
  s = fold(s, [
    { type: 'budget', budget: { profile: 'deep', spentUsd: 61, outputTokens: 0, flagshipCalls: 400, calls: 900, turns: 300, projectedUsd: 70, estimateLowUsd: 30, estimateHighUsd: 55, billing: 'payg', ceilingUsd: null, state: 'ok' } },
    { seq: 1, ts: 1, type: 'status', status: 'paused' },
    { seq: 2, ts: 2, type: 'quota', pause: { resumesAt: 1_800_000_000_000, kind: 'session', stated: true } },
  ]);
  ok('a new snapshot needs no caps', s.budget?.spentUsd === 61 && s.budget.capUsd === undefined && s.budget.billing === 'payg');
  ok('the quota pause is held with its resume time', s.status === 'paused' && s.quotaPause?.resumesAt === 1_800_000_000_000);
  const back = fold(s, [{ seq: 3, ts: 3, type: 'quota', pause: null }, { seq: 4, ts: 4, type: 'status', status: 'meeting' }]);
  ok('resuming clears it', back.quotaPause === null && back.status === 'meeting');
  const moved = fold(s, [{ seq: 3, ts: 3, type: 'status', status: 'wrapup' }]);
  ok('leaving paused by any route clears it too', moved.quotaPause === null);
}

console.log('[2b-5] the latest concession per message wins; the panel carries its dossier check');
{
  const c = { motionId: 'm', expert: 'cy', from: { stance: 1, confidence: 'medium' }, to: { stance: -1, confidence: 'medium' }, kind: 'full' as const, movedBy: { kind: 'unexplained' as const }, cost: 'face', messageId: 'mx' };
  let s = fold(initialState, [
    { seq: 1, ts: 1, type: 'concession', concession: c },
    { seq: 2, ts: 2, type: 'concession', concession: { ...c, movedBy: { kind: 'argument', who: 'bo' } } },
  ]);
  const chips = s.feed.filter((f) => f.fk === 'concession');
  ok('a referee attribution replaces the chip in place', chips.length === 1 && (chips[0] as any).concession.movedBy.kind === 'argument', JSON.stringify(chips));
  s = fold(s, [{ seq: 3, ts: 3, type: 'panel', personas: [persona('ana', 'Ana')], rationale: 'r', publicReputation: { ana: 'ran bakeries' }, diversity: { ok: false, problems: ['Nobody is hard to persuade.'], regenerated: ['ana'] } }]);
  ok('the panel event carries reputations and the diversity flag', s.reputations.ana === 'ran bakeries' && s.panelDiversity?.ok === false);
}

console.log(`\n${passes} passed, ${fails} failed`);
// Thrown rather than process.exit: this file typechecks with the browser's types, not node's.
if (fails) throw new Error(`${fails} reducer self-test(s) failed`);
