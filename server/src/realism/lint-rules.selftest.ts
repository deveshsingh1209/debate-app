/**
 * Realism lint rule tests. Pure, offline.
 *   npx tsx src/realism/lint-rules.selftest.ts
 */
import { pathToFileURL } from 'node:url';
import { suite } from './check.ts';
import { BASELINE_TURNS, CLEAN_TURNS } from './fixtures.ts';
import {
  BANNED_PHRASES, LINT_CONFIG, bannedPhrasesIn, countAntithesis, fourGrams, lintTurn, opener, phraseRegex, sentences,
  shouldRewrite, toLintRecord,
} from './lint-rules.ts';

export function run(): number {
  const t = suite('lint-rules');
  const rules = (text: string, ctx = {}) => lintTurn(text, ctx).rules;

  t.section('the one banned list');
  t.ok('list is non-empty and lowercase', BANNED_PHRASES.length >= 10 && BANNED_PHRASES.every((p) => p === p.toLowerCase()), BANNED_PHRASES);
  t.ok('list has no duplicates', new Set(BANNED_PHRASES).size === BANNED_PHRASES.length);
  t.ok('each phrase matches itself', BANNED_PHRASES.every((p) => bannedPhrasesIn(`x ${p} y`).length >= 1));
  t.ok('case and whitespace tolerant', bannedPhrasesIn('Ana is CLOSER   TO\nRIGHT here').length === 1);
  t.ok('curly apostrophe matches', bannedPhrasesIn('I’ll name the cost now').length === 1);
  t.ok('word-bounded (no match inside a word)', bannedPhrasesIn('my falsifiers').length === 0 && bannedPhrasesIn('enclose to rightly').length === 0);
  t.ok('positions are reported in text order', bannedPhrasesIn('my falsifier, closer to right').map((b) => b.phrase).join('|') === 'my falsifier|closer to right');
  t.ok('extra list is honoured for prompt checks', bannedPhrasesIn('please circle back', ['circle back']).length === 1);
  t.ok('a clean prompt has none', bannedPhrasesIn('Answer the person who asked, not the chair. Keep it short.').length === 0);
  t.ok('regex escapes punctuation', phraseRegex('a.b').test('a.b') && !phraseRegex('a.b').test('axb'));

  t.section('baseline tics fire');
  t.ok('closer to right is banned', rules(BASELINE_TURNS.closerToRight).includes('banned_phrase'));
  t.ok('steelman formula is banned', rules(BASELINE_TURNS.steelman).includes('banned_phrase'));
  t.ok('spoken evidence label', rules(BASELINE_TURNS.label).includes('spoken_label'));
  t.ok('two antitheses in one turn', rules(BASELINE_TURNS.antithesisTwice).includes('antithesis'), countAntithesis(BASELINE_TURNS.antithesisTwice));
  t.ok('one antithesis alone is allowed', !rules('Fourteen percent is not a reserve, it is a hope.').includes('antithesis'));
  t.ok('short form "not a X, a Y." counts', countAntithesis('Not a reserve, a hope.') === 1);
  t.ok('filler praise', rules(BASELINE_TURNS.filler).includes('filler_praise'));
  t.ok('em-dashes', rules(BASELINE_TURNS.emDash).includes('em_dash'));
  t.ok('spaced en-dash counts as a dash', rules('The ovens – all three – are full.').includes('em_dash'));
  t.ok('hyphenated words are not dashes', !rules('A six-day week is long.').includes('em_dash'));
  t.ok('markdown list', rules(BASELINE_TURNS.markdown).includes('markdown'));
  t.ok('bold markdown', rules('That is **not** the point.').includes('markdown'));
  t.ok('summary ending', rules(BASELINE_TURNS.summary).includes('summary_ending'));
  t.ok('summary ending needs three sentences', !rules('Ovens are full. So no.').includes('summary_ending'));
  t.ok('meta speech', rules(BASELINE_TURNS.meta).includes('meta_speech'));
  t.ok('melodrama', rules(BASELINE_TURNS.melodrama).includes('melodrama'));
  t.ok('template turn (name + concession, attack, chair request)', rules(BASELINE_TURNS.closerToRight, { names: ['Ana', 'Bo'], chairName: 'Marcus' }).includes('template_turn'), lintTurn(BASELINE_TURNS.closerToRight, { names: ['Ana', 'Bo'], chairName: 'Marcus' }).hits);
  t.ok('every baseline turn scores above zero', Object.values(BASELINE_TURNS).every((x) => lintTurn(x, { stanceMoved: false }).score > 0));
  t.ok('the corpus turn is sent to rewrite', shouldRewrite(lintTurn(BASELINE_TURNS.closerToRight, { names: ['Ana', 'Bo'], chairName: 'Marcus' })));

  t.section('clean turns pass');
  for (const c of CLEAN_TURNS) {
    const r = lintTurn(c);
    t.ok(`clean: "${c.slice(0, 40)}"`, r.score === 0, r.hits);
  }
  t.ok('a question to a colleague passes', lintTurn('Bo, which base is that payback on?').score === 0);

  t.section('context rules');
  t.ok('neverSay from the dossier', rules('We should circle back on this.', { neverSay: ['circle back'] }).includes('never_say'));
  t.ok('neverSay duplicate of the banned list counts once as banned', (() => {
    const r = lintTurn('Ana is closer to right.', { neverSay: ['closer to right'] });
    return r.rules.includes('banned_phrase') && !r.rules.includes('never_say');
  })());
  t.ok('length over budget', rules('word '.repeat(70), { wordBudget: [12, 60] }).includes('length_budget'));
  t.ok('length under budget', rules('No.', { wordBudget: [12, 60] }).includes('length_budget'));
  t.ok('length inside budget', !rules('No, not on that base.', { wordBudget: [2, 15] }).includes('length_budget'));
  t.ok('reply to colleague opening on chair', rules('Marcus, Bo has the margin wrong.', { chairName: 'Marcus', replyTo: 'bo' }).includes('addresses_chair'));
  t.ok('answering the chair may name the chair', !rules('Marcus, yes.', { chairName: 'Marcus', replyTo: 'marcus' }).includes('addresses_chair'));
  t.ok('naming the chair mid-turn is fine', !rules('Bo, Marcus asked for this already.', { chairName: 'Marcus', replyTo: 'bo' }).includes('addresses_chair'));
  t.ok('courtesy concession without a stance move', rules(BASELINE_TURNS.courtesy, { stanceMoved: false }).includes('courtesy_concession'));
  t.ok('a real concession (stance moved) is fine', !rules(BASELINE_TURNS.courtesy, { stanceMoved: true }).includes('courtesy_concession'));
  t.ok('ledger not live: quiet', !rules(BASELINE_TURNS.courtesy).includes('courtesy_concession'));
  const recent = ['What everyone forgets is the rota.', 'What everyone forgets is the lease.'];
  t.ok('shared opener with recent turns', rules('What everyone forgets is the oven.', { recentTurns: recent }).includes('shared_opener'));
  t.ok('names normalised in openers', opener('Ana, the rota is full', ['ana']) === opener('Bo, the rota is full', ['bo']));
  t.ok('shared opener with names', rules('Ana, the rota is full.', { recentTurns: ['Bo, the rota is thin.'], names: ['Ana', 'Bo'] }).includes('shared_opener'));
  t.ok('opener window only looks back 30 turns', !rules('What everyone forgets is x.', { recentTurns: ['What everyone forgets is y.', ...Array(30).fill('Different.')] }).includes('shared_opener'));
  const mine = ['The Saturday proving schedule already starts at four in the morning.'];
  t.ok('recycled 4-grams from own recent turns', rules('Again, the Saturday proving schedule already starts at four.', { speakerRecentTurns: mine }).includes('recycled_ngram'));
  t.ok('stopword-only grams ignored', fourGrams('it is in the').size === 0);
  t.ok('one shared gram is not enough', !rules('Our Saturday proving schedule already moved.', { speakerRecentTurns: ['The Saturday proving schedule already is hard'] }).includes('recycled_ngram'));
  const tics = [{ text: 'on what base', maxPerMotion: 2, used: 2 }];
  t.ok('tic over budget', rules('On what base?', { tics }).includes('tic_over_budget'));
  t.ok('tic inside budget', !rules('On what base?', { tics: [{ text: 'on what base', maxPerMotion: 2, used: 1 }] }).includes('tic_over_budget'));
  t.ok('tic use is reported for the caller', lintTurn('On what base?', { tics }).ticsUsed[0] === 'on what base');
  t.ok('room antithesis budget', rules('That is not a plan, it is a wish.', { roomAntithesis: { used: 5, budget: 5 } }).includes('antithesis_budget'));
  t.ok('room antithesis under budget', !rules('That is not a plan, it is a wish.', { roomAntithesis: { used: 2, budget: 5 } }).includes('antithesis_budget'));

  t.section('result shape');
  const r = lintTurn(BASELINE_TURNS.closerToRight, { names: ['Ana', 'Bo'], chairName: 'Marcus' });
  t.ok('score is the sum of hit weights', r.score === r.hits.reduce((a, h) => a + h.weight, 0));
  t.ok('weights come from LINT_CONFIG', r.hits.every((h) => h.weight === LINT_CONFIG.weights[h.rule]));
  t.ok('rules are de-duplicated', new Set(r.rules).size === r.rules.length);
  t.ok('pure: same input, same output', JSON.stringify(r) === JSON.stringify(lintTurn(BASELINE_TURNS.closerToRight, { names: ['Ana', 'Bo'], chairName: 'Marcus' })));
  const rec = toLintRecord(r, true);
  t.ok('lint record matches the message contract', rec.rewrote === true && rec.score === r.score && Array.isArray(rec.rules) && rec.rules !== (r.rules as unknown));
  t.ok('words counted', lintTurn('one two three').words === 3);
  t.ok('sentence split keeps questions', sentences('No. Which base? Fine!').length === 3);
  t.ok('empty turn is harmless', lintTurn('').score === 0);
  return t.done();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(run() ? 1 : 0);
