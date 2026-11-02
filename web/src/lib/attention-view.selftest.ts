/**
 * The browser side of notifications, without a DOM: the badge count and the
 * notification words. Run by `npm run qa`.
 *
 *   npx tsx web/src/lib/attention-view.selftest.ts
 */
import { badgeTitle, freshKey, needsYouCount, notificationCopy } from './attention-view.ts';

let fails = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (!cond) fails++;
  console.log(`${cond ? '  ok  ' : '  FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};

const rows = [
  { id: 'a', attention: 'question' as const, attentionKey: 'question:q1' },
  { id: 'b', attention: 'approval' as const, attentionKey: 'approval:goal' },
  { id: 'c', attention: 'report' as const, attentionKey: 'report' },
  { id: 'd', attention: 'error' as const, attentionKey: 'error' },
  { id: 'e', attention: null, attentionKey: null },
];
const none = new Set<string>();

ok('actionable states count; old reports and errors do not', needsYouCount(rows, { fresh: none, viewing: null, visible: false }) === 2);
ok('a report that arrived this session counts until seen',
  needsYouCount(rows, { fresh: new Set([freshKey('c', 'report')]), viewing: null, visible: false }) === 3);
ok('the debate on screen does not count', needsYouCount(rows, { fresh: none, viewing: 'a', visible: true }) === 1);
ok('...but does when the tab is hidden', needsYouCount(rows, { fresh: none, viewing: 'a', visible: false }) === 2);
ok('rows from an older server (no attention field) count as nothing',
  needsYouCount([{ id: 'x' } as any], { fresh: none, viewing: null, visible: false }) === 0);

ok('title badge', badgeTitle(1, 'The Debate App') === '(1) Needs you · The Debate App');
ok('no badge at zero', badgeTitle(0, 'The Debate App') === 'The Debate App');

const one = notificationCopy([{ id: 'd_1', kind: 'question', title: 'Pricing' }]);
ok('one change: specific headline, title as body, opens the debate',
  one.title === 'A debate needs your answer' && one.body === 'Pricing' && one.path === '/debate/d_1' && one.tag === 'debate-d_1');
ok('a report opens the report', notificationCopy([{ id: 'd_1', kind: 'report' }]).path === '/debate/d_1/report');
const many = notificationCopy([{ id: 'd_1', kind: 'question', title: 'A' }, { id: 'd_2', kind: 'error', title: 'B' }]);
ok('several changes coalesce into one notification for the deck', many.title === '2 debates need you' && many.path === '/' && many.body === 'A · B');

console.log(`\nattention-view selftest: ${fails ? `${fails} failed` : 'all passed'}`);
// Thrown rather than process.exit: this file typechecks with the browser's types, not node's.
if (fails) throw new Error(`${fails} attention-view self-test(s) failed`);
