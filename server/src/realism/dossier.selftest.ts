/**
 * Dossier validation, diversity check, voice card and roster tests. Pure, offline.
 *   npx tsx src/realism/dossier.selftest.ts
 */
import { pathToFileURL } from 'node:url';
import { suite } from './check.ts';
import { CONVERGED_PANEL, RAW_DOSSIER_GOOD, VARIED_PANEL, dossier } from './fixtures.ts';
import {
  DOSSIER_RULES, MAX_FIELD_CHARS, VOICE_CARD_MAX_CHARS, pressureClause, checkDiversity, contentTokens, effectiveNeverSay, jaccard, parseDossier,
  relevantIncentives, rosterText, stubbornnessLine, voiceCard, type PanelEntry,
} from './dossier.ts';
import { BANNED_PHRASES, bannedPhrasesIn } from './lint-rules.ts';
import type { Belief } from '../../../shared/types.ts';

const clone = <T>(x: T): T => structuredClone(x);

export function run(): number {
  const t = suite('dossier');

  t.section('parseDossier');
  {
    const r = parseDossier(RAW_DOSSIER_GOOD, { personaId: 'ana', panelIds: ['ana', 'bo', 'cy'] });
    t.ok('a decent dossier parses', r.ok, r);
    if (r.ok) {
      const d = r.dossier;
      t.ok('personaId comes from the caller', d.personaId === 'ana');
      t.ok('history trimmed to 2 failures + 2 wins', d.history.filter((h) => h.kind === 'failure').length === 2 && d.history.filter((h) => h.kind === 'win').length === 2, d.history);
      t.ok('incentives de-duplicated', d.incentives.length === 2, d.incentives);
      t.ok('stubbornness clamped to 1', d.stubbornness === 1);
      t.ok('missing temperament field defaulted', d.temperament.dominance === 0.5 && d.temperament.heatGain === 0.3);
      t.ok('typicalWords clamped to 160', d.speech.typicalWords === 160);
      t.ok('vocabulary trimmed to 8 max and lowercased', d.speech.vocabulary.length <= 8 && d.speech.vocabulary[0] === 'footfall');
      t.ok('a bare-string tic becomes a budgeted tic', d.speech.tics[0].text === 'here is the thing' && d.speech.tics[0].maxPerMotion === 1);
      t.ok('relationships to self and to strangers dropped', d.relationships.length === 1 && d.relationships[0].with === 'bo', d.relationships);
      t.ok('priorPublicStance kept', !!d.priorPublicStance);
      t.ok('warnings say what was fixed', r.warnings.some((w) => /stubbornness/.test(w)) && r.warnings.some((w) => /relationship dropped/.test(w)), r.warnings);
    }
    const bad = parseDossier({ ...RAW_DOSSIER_GOOD, speech: { ...RAW_DOSSIER_GOOD.speech, register: 'posh' }, history: [] }, { personaId: 'x' });
    t.ok('unknown register and empty history fail', !bad.ok && bad.errors.some((e) => /register/.test(e)) && bad.errors.some((e) => /failures/.test(e)), bad);
    const long = parseDossier({ ...RAW_DOSSIER_GOOD, publicReputation: 'word '.repeat(200), underPressure: 'x'.repeat(5000) }, { personaId: 'x' });
    t.ok('model-written strings are capped (reputation by words, others by chars)', long.ok && long.dossier.publicReputation.split(' ').length === DOSSIER_RULES.publicReputationMaxWords && long.dossier.underPressure.length === MAX_FIELD_CHARS, long.ok ? long.dossier.underPressure.length : long);
    t.ok('not an object fails', !parseDossier('nope', { personaId: 'x' }).ok);
    t.ok('missing stubbornness fails', !parseDossier({ ...RAW_DOSSIER_GOOD, stubbornness: undefined }, { personaId: 'x' }).ok);
    const banTic = parseDossier({ ...RAW_DOSSIER_GOOD, speech: { ...RAW_DOSSIER_GOOD.speech, tics: ['closer to right'] } }, { personaId: 'x' });
    t.ok('a tic that is a banned phrase fails', !banTic.ok && banTic.errors.some((e) => /banned/.test(e)), banTic);
    const fewVocab = parseDossier({ ...RAW_DOSSIER_GOOD, speech: { ...RAW_DOSSIER_GOOD.speech, vocabulary: ['a', 'b'] } }, { personaId: 'x' });
    t.ok('too little vocabulary fails', !fewVocab.ok);
    t.ok('no panel list: relationships kept except self', (() => {
      const r2 = parseDossier(RAW_DOSSIER_GOOD, { personaId: 'ana' });
      return r2.ok && r2.dossier.relationships.length === 2;
    })());
    t.ok('effectiveNeverSay = banned list + own', (() => {
      const d = VARIED_PANEL[0].dossier;
      const e = effectiveNeverSay(d);
      return e.includes('circle back') && BANNED_PHRASES.every((p) => e.includes(p));
    })());
  }

  t.section('diversity check: varied panel passes');
  {
    const r = checkDiversity(VARIED_PANEL);
    t.ok('varied panel ok', r.ok, r.failures);
    t.ok('nobody to regenerate', r.regenerate.length === 0);
    t.ok('measures reported', r.measures.registerShare === 1 && r.measures.lengthRatio >= 3 && r.measures.opposedPairs >= 2, r.measures);
    t.ok('deterministic', JSON.stringify(r) === JSON.stringify(checkDiversity(clone(VARIED_PANEL))));
  }

  t.section('diversity check: converged panel fails');
  {
    const r = checkDiversity(CONVERGED_PANEL);
    const fired = new Set(r.failures.map((f) => f.rule));
    t.ok('converged panel fails', !r.ok);
    for (const rule of ['registers', 'length_spread', 'vocabulary_overlap', 'stubbornness_low', 'stubbornness_high', 'opposed_incentives', 'bias_overlap', 'incentive_overlap', 'pressure_overlap', 'shared_tic'] as const) {
      t.ok(`flags ${rule}`, fired.has(rule), [...fired]);
    }
    t.ok('regenerate list is in panel order', JSON.stringify(r.regenerate) === JSON.stringify(['ana', 'bo', 'cy', 'di'].filter((id) => r.regenerate.includes(id))));
    t.ok('every regenerated expert has a hint', r.regenerate.every((id) => (r.hints[id] ?? []).length > 0), r.hints);
    t.ok('hints never script banned wording', Object.values(r.hints).flat().every((h) => bannedPhrasesIn(h).length === 0));
  }

  t.section('diversity check: single-rule failures');
  {
    const one = (mut: (p: PanelEntry[]) => void) => {
      const p = clone(VARIED_PANEL);
      mut(p);
      return checkDiversity(p);
    };
    const reg = one((p) => { p[1].dossier.speech.register = 'storyteller'; p[2].dossier.speech.register = 'storyteller'; });
    t.ok('two duplicate registers in four (2/4 distinct) fails', reg.failures.some((f) => f.rule === 'registers'), reg.failures);
    t.ok('register hint names a free register', Object.values(reg.hints).flat().some((h) => /free: /.test(h)), reg.hints);
    const reg3 = one((p) => { p[1].dossier.speech.register = 'storyteller'; });
    t.ok('3 of 4 distinct (0.75) passes the register rule', !reg3.failures.some((f) => f.rule === 'registers'), reg3.failures);
    const len = one((p) => p.forEach((e) => (e.dossier.speech.typicalWords = 90)));
    t.ok('equal lengths fail the spread rule', len.failures.some((f) => f.rule === 'length_spread') && len.regenerate.length === 1, len.failures);
    const voc = one((p) => (p[3].dossier.speech.vocabulary = [...p[2].dossier.speech.vocabulary]));
    t.ok('copied vocabulary fails and regenerates the later one', voc.failures.some((f) => f.rule === 'vocabulary_overlap') && voc.regenerate.includes('di') && !voc.regenerate.includes('cy'), voc);
    const lo = one((p) => (p[0].dossier.stubbornness = 0.5));
    t.ok('no easy-to-move expert fails', lo.failures.some((f) => f.rule === 'stubbornness_low') && lo.hints.ana?.some((h) => /easy to move/.test(h)), lo);
    const hi = one((p) => (p[1].dossier.stubbornness = 0.6));
    t.ok('no hard-to-move expert fails', hi.failures.some((f) => f.rule === 'stubbornness_high'), hi);
    const opp = one((p) => p.forEach((e) => (e.goalLean = 1)));
    t.ok('everyone gains from the goal fails', opp.failures.some((f) => f.rule === 'opposed_incentives') && opp.measures.opposedPairs === 0, opp.measures);
    const opp1 = one((p) => { p[2].goalLean = 0; p[3].goalLean = 0; });
    t.ok('one opposed pair (need two) fails and regenerates a neutral', opp1.measures.opposedPairs === 1 && opp1.failures.some((f) => f.rule === 'opposed_incentives' && f.who[0] === 'di'), opp1);
    const tic = one((p) => (p[3].dossier.speech.tics = [{ text: 'On what base', maxPerMotion: 1 }]));
    t.ok('a shared tic (case-insensitive) fails', tic.failures.some((f) => f.rule === 'shared_tic'), tic.failures);
  }

  t.section('diversity check: small panels');
  {
    t.ok('one expert: nothing to compare', checkDiversity([VARIED_PANEL[0]]).ok);
    const three = checkDiversity(VARIED_PANEL.slice(0, 3));
    t.ok('three varied experts pass', three.ok, three.failures);
    const two = clone(VARIED_PANEL.slice(0, 2));
    const r2 = checkDiversity(two);
    t.ok('two experts need only one opposed pair', !r2.failures.some((f) => f.rule === 'opposed_incentives'), r2.failures);
    t.ok('stubbornness extremes never ask one person for both', (() => {
      const p = clone(VARIED_PANEL.slice(0, 2));
      p[0].dossier.stubbornness = 0.5;
      p[1].dossier.stubbornness = 0.5;
      const r = checkDiversity(p);
      const lo = r.failures.find((f) => f.rule === 'stubbornness_low')?.who[0];
      const hi = r.failures.find((f) => f.rule === 'stubbornness_high')?.who[0];
      return !!lo && !!hi && lo !== hi;
    })());
  }

  t.section('similarity helpers');
  t.ok('jaccard of identical sets is 1', jaccard(new Set([1, 2]), new Set([1, 2])) === 1);
  t.ok('jaccard of empty sets is 0', jaccard(new Set(), new Set()) === 0);
  t.ok('content tokens drop stopwords and stem', [...contentTokens('The bakers are baking breads')].join(',') === 'baker,bak,bread', [...contentTokens('The bakers are baking breads')]);

  t.section('voice card');
  {
    const d = VARIED_PANEL[2].dossier; // cy, the accountant
    const belief: Belief = { expert: 'cy', motionId: 'm1', stance: -1, confidence: 'medium', crux: 'overtime eats the Sunday margin', reasons: [], sinceSeq: 4 };
    const card = voiceCard(d, { motion: 'Open on Sundays with the current payroll', belief, ticUse: { 'on what base': 2 } });
    t.ok('has the register and length', /socratic register/.test(card) && /about 70 words/.test(card), card);
    t.ok('has the vocabulary', d.speech.vocabulary.every((v) => card.includes(v)));
    t.ok('a spent tic says so', /spent this motion/.test(card), card);
    t.ok('an unspent tic shows what is left', /at most 1 more/.test(voiceCard(d, { ticUse: { 'on what base': 1 } })));
    t.ok('has the current belief in words', /leaning against \(medium confidence\)/.test(card) && card.includes(belief.crux));
    t.ok('picks the incentive relevant to the motion first', relevantIncentives(d, 'payroll changes on Sundays')[0] === 'charges by the hour for payroll changes');
    t.ok('two incentives at most', relevantIncentives(d, '', 2).length === 2);
    t.ok('has the stubbornness behaviour', card.includes(stubbornnessLine(d.stubbornness)));
    t.ok('stays inside the size cap', card.length <= VOICE_CARD_MAX_CHARS, card.length);
    t.ok('never contains a banned phrase', bannedPhrasesIn(card).length === 0, bannedPhrasesIn(card));
    const own = dossier('zed', { speech: { register: 'plain', typicalWords: 60, vocabulary: ['a1', 'b1', 'c1', 'd1', 'e1'], tics: [{ text: 'right then', maxPerMotion: 1 }], neverSay: ['closer to right', 'circle back'] } });
    const card2 = voiceCard(own);
    t.ok('own neverSay is listed, globally banned ones are not (no seeding)', card2.includes('"circle back"') && bannedPhrasesIn(card2).length === 0, card2);
    const huge = dossier('big', {
      incentives: ['x'.repeat(400), 'y'.repeat(400)],
      underPressure: 'z'.repeat(300),
      priorPublicStance: 'p'.repeat(300),
      speech: { register: 'dry', typicalWords: 80, vocabulary: ['a2', 'b2', 'c2', 'd2', 'e2'], tics: [{ text: 'quite', maxPerMotion: 1 }], neverSay: ['n'.repeat(200)] },
    });
    const big = voiceCard(huge);
    t.ok('an oversized card is cut to the cap', big.length <= VOICE_CARD_MAX_CHARS, big.length);
    t.ok('the cut drops low-priority lines first', !big.includes('On record in public') && big.includes('VOICE:'), big.slice(0, 200));
    t.ok('under-pressure clause is second person and ends on a stop', pressureClause('Goes quiet then comes back hard') === 'go quiet then come back hard.' && pressureClause('You get more technical.') === 'get more technical.', pressureClause('Goes quiet then comes back hard'));
    t.ok('stubbornness lines differ by band', new Set([0.1, 0.5, 0.9].map(stubbornnessLine)).size === 3);
  }

  t.section('roster');
  {
    const members = VARIED_PANEL.map((e) => ({ id: e.id, name: e.id.toUpperCase(), role: 'expert', dossier: e.dossier }));
    const r = rosterText(members);
    t.ok('one line per expert', r.split('\n').length === members.length + 1);
    t.ok('contains public reputations', VARIED_PANEL.every((e) => r.includes(e.dossier.publicReputation)));
    const privateBits = VARIED_PANEL.flatMap((e) => [...e.dossier.incentives, e.dossier.underPressure, ...e.dossier.biases.map((b) => b.showsUpAs), ...e.dossier.speech.tics.map((x) => x.text)]).filter((p) => p.length > 3);
    t.ok('contains no private field', privateBits.every((p) => !r.includes(p)), privateBits.filter((p) => r.includes(p)));
    t.ok('byte-identical across calls (cache-safe)', r === rosterText(clone(members)));
    t.ok('old debate (no dossier) falls back to name and role', rosterText([{ id: 'a', name: 'Ana Ruiz', role: 'Growth lead' }]).endsWith('- Ana Ruiz (Growth lead).'));
    t.ok('newlines in a reputation cannot break the block', !rosterText([{ id: 'a', name: 'A', role: 'R', dossier: { publicReputation: 'one\ntwo' } }]).includes('one\ntwo'));
    t.ok('empty panel gives empty text', rosterText([]) === '');
    t.ok('roster has no banned phrase', bannedPhrasesIn(r).length === 0);
  }
  t.ok('rules expose the plan thresholds', DOSSIER_RULES.diversity.maxVocabJaccard === 0.2 && DOSSIER_RULES.diversity.minLengthRatio === 3);
  return t.done();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(run() ? 1 : 0);
