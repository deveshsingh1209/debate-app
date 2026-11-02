/**
 * The realism linter on synthetic turns, and the rewrite verifier with a fake
 * rewriter. Pure; no engine, no model.
 *
 *   npx tsx src/engine/lint.selftest.ts
 */
import { lintTurn, lintAndRewrite, verifyRewrite, numbersOf, LINT_THRESHOLD, WORD_BUDGET, type LintContext } from './lint.ts';

let fails = 0;
let passes = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) passes++;
  else fails++;
  console.log(`${cond ? '  ok  ' : '  FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};

const ctx = (over: Partial<LintContext> = {}): LintContext => ({
  shape: 'reply',
  budget: WORD_BUDGET.reply,
  speaker: 'ana',
  names: ['Ana', 'Bo', 'Cy', 'Marcus'],
  chairName: 'Marcus',
  replyToColleague: true,
  recent: [],
  stanceMoved: null,
  antithesisSoFar: 0,
  ...over,
});
const rules = (t: string, c = ctx()) => lintTurn(t, c).rules;

console.log('[1] clean speech passes');
{
  const r = lintTurn('Which base? If it is gross, your payback is a month short.', ctx());
  ok('a short, plain reply scores zero', r.score === 0, JSON.stringify(r));
  ok('the threshold is three', LINT_THRESHOLD === 3);
}

console.log('[2] each rule fires on its tell');
ok('a corpus tic is banned', rules('Bo is closer to right, and the rota proves it.').includes('banned:closer_to_right'));
ok('speech about speech is banned', rules("I'll say it plainly: nobody wants Sundays.").includes('banned:meta_speech'));
ok('position-card jargon is banned', rules('My falsifier has not fired yet.').includes('banned:falsifier_jargon'));
ok('a spoken evidence label', rules('Sundays sell out (observed, from my two shops).').includes('spoken_label'));
ok('the antithesis twice in one turn',
  rules('Fourteen percent is not a reserve, it is a hope. And the rota is not a plan, it is a wish.').includes('antithesis_repeat'));
ok('one antithesis is fine on a fresh motion', !rules('Fourteen percent is not a reserve, it is a hope.').some((r) => r.startsWith('antithesis')));
ok('one antithesis over the room budget costs a point',
  rules('Fourteen percent is not a reserve, it is a hope.', ctx({ antithesisSoFar: 3 })).includes('antithesis_budget'));
ok('filler', rules('Great point, Bo. The ovens still run hot.').includes('filler'));
ok('an em-dash', rules('The ovens — all three — run hot.').includes('em_dash'));
ok('markdown', rules('Three things:\n- ovens\n- staff\n- rent').includes('markdown'));
ok('a summary ending', rules('Ovens run hot. Staff are tired. Rent is due. So the answer is no Sundays.').includes('summary_ending'));
ok('an opener shared with a recent turn',
  rules('Look, the ovens are the issue here.', ctx({ recent: [{ speaker: 'bo', text: 'Look, the ovens cannot take it.' }] })).includes('shared_opener'));
ok('recycled phrasing from the same speaker',
  rules('Again the first cohort of weekend buyers decides it.', ctx({ recent: [{ speaker: 'ana', text: 'The first cohort of weekend buyers decides this, as I said.' }] })).includes('recycled_4gram'));
{
  const long = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ') + '.';
  const r = rules(long);
  ok('a reply over its budget', r.includes('too_long') && r.includes('far_too_long'), r.join());
  ok('a thin set piece', rules('Open on Sundays.', ctx({ shape: 'set_piece', budget: WORD_BUDGET.set_piece, replyToColleague: false })).includes('too_short'));
}
ok('addressing the chair in a reply to a colleague', rules('Marcus, Bo has no rota.').includes('chair_address'));
ok('addressing the chair when opening a point is fine', !rules('Marcus, nobody has costed the ovens.', ctx({ replyToColleague: false })).includes('chair_address'));
ok('the template: concede, attack, hand the chair a request',
  rules("You're right that footfall is up. But the rota breaks. Marcus, get the desk to price it.", ctx({ replyToColleague: false })).includes('template'));
ok('a courtesy concession with no stance move',
  rules("You're right that footfall is up, but it changes nothing.", ctx({ stanceMoved: false })).includes('courtesy_concession'));
ok('a concession backed by a stance move is not courtesy',
  !rules("You're right that footfall is up.", ctx({ stanceMoved: true })).includes('courtesy_concession'));
ok('melodrama', rules('This could sink the company by spring.').includes('melodrama'));
ok('a speaker\'s own never-say list', rules('Synergy, frankly.', ctx({ neverSay: ['synergy'] })).includes('never_say'));
{
  const r = lintTurn("Bo is closer to right. I'll say it plainly — (observed) Sundays sell.", ctx());
  ok('scores add up past the threshold', r.score >= LINT_THRESHOLD * 2, String(r.score));
}

console.log('[3] the verifier rejects a rewrite that moved substance');
{
  const original = 'Bo is closer to right: nineteen dollars landed at 10,000 units, per [c_ab12], and Ana knows it.';
  const c = ctx({ replyToColleague: false, budget: WORD_BUDGET.set_piece, shape: 'reply' });
  ok('numbers are read as digits and words', numbersOf(original).join() === '10000,nineteen', numbersOf(original).join());
  const good = 'Bo has it: nineteen dollars landed at 10,000 units, per [c_ab12], and Ana knows it.';
  ok('a form-only rewrite passes', verifyRewrite(original, good, c).ok, JSON.stringify(verifyRewrite(original, good, c)));
  const num = verifyRewrite(original, 'Bo has it: twenty dollars landed at 10,000 units, per [c_ab12], and Ana knows it.', c);
  ok('a changed number is rejected', !num.ok && num.reasons.some((r) => /numbers changed/.test(r)), JSON.stringify(num));
  const name = verifyRewrite(original, 'Bo has it: nineteen dollars landed at 10,000 units, per [c_ab12], and she knows it.', c);
  ok('a dropped name is rejected', !name.ok && name.reasons.some((r) => /names were dropped: Ana/.test(r)), JSON.stringify(name));
  const added = verifyRewrite(original, 'Bo has it: nineteen dollars landed at 10,000 units, per [c_ab12], and Ana and Priya know it.', c);
  ok('an invented name is rejected', !added.ok && added.reasons.some((r) => /names were added: Priya/.test(r)), JSON.stringify(added));
  const cite = verifyRewrite(original, 'Bo has it: nineteen dollars landed at 10,000 units, and Ana knows it.', c);
  ok('a lost citation id is rejected', !cite.ok && cite.reasons.some((r) => /citation/.test(r)), JSON.stringify(cite));
  const same = verifyRewrite(original, original, c);
  ok('an "edit" that fixes nothing is rejected', !same.ok && same.reasons.some((r) => /still scored/.test(r)), JSON.stringify(same));
  const trailer = verifyRewrite(original, `${good}\nSTANCE: for+1`, c);
  ok('a rewrite carrying a trailer line is rejected', !trailer.ok, JSON.stringify(trailer));
  const long = verifyRewrite('Bo is closer to right.', Array.from({ length: 80 }, () => 'word').join(' '), ctx());
  ok('a rewrite over the budget is rejected', !long.ok && long.reasons.some((r) => /over the/.test(r)), JSON.stringify(long));
}

console.log('[4] lint-and-rewrite: one retry, then the original ships');
{
  const original = "Bo is closer to right. I'll say it plainly: the rota fails in week three.";
  const c = ctx({ replyToColleague: false });
  let calls = 0;
  const fixed = await lintAndRewrite(original, c, { name: 'Ana Ruiz', style: 'Short.' }, async () => { calls++; return 'Bo has it. The rota fails in week three.'; });
  ok('a good rewrite is taken on the first try', fixed.text === 'Bo has it. The rota fails in week three.' && fixed.record.rewrote && calls === 1, JSON.stringify(fixed));
  ok('the record keeps the original score and rules', fixed.record.score >= 6 && fixed.record.rules.includes('banned:closer_to_right'), JSON.stringify(fixed.record));

  const prompts: string[] = [];
  let n = 0;
  const retried = await lintAndRewrite(original, c, { name: 'Ana Ruiz', style: 'Short.' }, async (req) => {
    prompts.push(req.prompt);
    n++;
    return n === 1 ? 'Bo has it. The rota fails in week four.' : 'Bo has it. The rota fails in week three.';
  });
  ok('a rejected rewrite is retried once, with the reason', n === 2 && retried.record.rewrote && /numbers changed/.test(prompts[1]), JSON.stringify(retried));

  let m = 0;
  const kept = await lintAndRewrite(original, c, { name: 'Ana Ruiz', style: 'Short.' }, async () => { m++; return 'Bo has it. The rota fails in week four.'; });
  ok('two failures ship the original, marked not rewritten', kept.text === original && !kept.record.rewrote && m === 2, JSON.stringify(kept));

  const thrown = await lintAndRewrite(original, c, { name: 'Ana Ruiz', style: 'Short.' }, async () => { throw new Error('model down'); });
  ok('a rewriter that throws costs only the polish', thrown.text === original && !thrown.record.rewrote);

  let never = 0;
  const clean = await lintAndRewrite('Which base?', c, { name: 'Ana Ruiz', style: 'Short.' }, async () => { never++; return 'x'; });
  ok('below the threshold no model is called', never === 0 && clean.text === 'Which base?' && clean.record.score === 0);
}

console.log('[persona] first-person anecdote told as fact (P1, lines from the 2026-10-28 run)');
{
  const real = [
    'My head baker said the same thing, "I\'m fine", then walked after eight Sundays.',
    'Marcus, Priya\'s 360 is my number too. My busiest Bristol counter never saw a third of that.',
    'The bad one leaned on Saturday people, and that\'s how I lost my head baker.',
    'And yes, Priya, Saturday was selling out by eleven before my good Sunday.',
  ];
  for (const t of real) {
    const r = lintTurn(t, ctx());
    ok(`flagged: "${t.slice(0, 48)}..."`, r.rules.includes('persona_anecdote'), JSON.stringify(r.hits));
  }
  const plain = ['Priya, your 450 to 600 pounds: is that weekday rate?', 'On my numbers Sunday fails.', 'I ran the numbers again and it still fails.', 'That\'s my point: the third line stops him cutting Saturday hours.'];
  for (const t of plain) ok(`not flagged: "${t.slice(0, 48)}"`, !rules(t).includes('persona_anecdote'), JSON.stringify(lintTurn(t, ctx()).hits));
  const r = lintTurn(real[0], ctx());
  ok('the flag weighs nothing, so it never triggers a rewrite by itself', r.score === 0, JSON.stringify(r));
  let asked = '';
  await lintAndRewrite(`${real[0]} Bo is closer to right.`, ctx(), { name: 'Marisol', style: 'Blunt.' }, async (req) => { asked = req.prompt; return real[0]; });
  ok('a rewrite for another reason is not told to remove the story', asked !== '' && !/persona_anecdote/.test(asked) && !asked.includes('WHAT TO FIX:\n- persona'), asked);
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
