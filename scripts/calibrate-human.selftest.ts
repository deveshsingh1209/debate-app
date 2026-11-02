/**
 * Self-test for scripts/calibrate-human.ts. Tiny synthetic NXT fixtures written
 * here by hand: no corpus data, no network. Run: npx tsx scripts/calibrate-human.selftest.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  parseWords, joinText, parseAmiDaTypes, parseAmiDialogActs, icsiGeneralTags, parseIcsiDialogActs,
  buildTurns, incomplete, toDebateInput, analyseMeeting, analyseWindows, dist, scoreWithBands,
  type Unit, type Meeting, type BandFile,
} from './calibrate-human.ts';
import { computeMetrics, fromEvents, realismIndex, REALISM_TARGETS } from './transcript-metrics.ts';

let fails = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
  if (!cond) fails++;
};
const near = (a: number, b: number, e = 1e-9) => Math.abs(a - b) <= e;

// ---------- words ----------

const amiWords = `<?xml version="1.0"?><nite:root nite:id="X1.A.words" xmlns:nite="http://nite.sourceforge.net/">
   <w nite:id="X1.A.w0" starttime="1.0" endtime="1.3">Hi</w>
   <w nite:id="X1.A.w1" starttime="1.3" endtime="1.3" punc="true">,</w>
   <w nite:id="X1.A.w2" starttime="1.3" endtime="1.6">I&#39;m</w>
   <vocalsound nite:id="X1.A.v0" starttime="1.6" endtime="1.9" type="laugh"/>
   <w nite:id="X1.A.w3" starttime="1.9" endtime="2.4">Ana</w>
   <w nite:id="X1.A.w4" starttime="2.4" endtime="2.4" punc="true">.</w>
   <w nite:id="X1.A.w5" starttime="3.0" endtime="3.2">Why</w>
   <w nite:id="X1.A.w6" starttime="3.2" endtime="3.2" punc="true">?</w>
   <w nite:id="X1.A.w7" starttime="4.0" endtime="4.3">Mm-hmm</w>
</nite:root>`;
const aw = parseWords(amiWords);
ok('AMI words: every element with an id, in order, non-words kept', aw.length === 9 && aw[3].id === 'X1.A.v0' && !aw[3].word);
ok('AMI words: punctuation is not a word; entities decoded', aw.filter((t) => t.word).map((t) => t.text).join('|') === "Hi|I'm|Ana|Why|Mm-hmm", aw.map((t) => t.text).join('|'));
ok('AMI words: times parsed', aw[0].start === 1 && aw[0].end === 1.3);
ok('joinText attaches punctuation and skips non-words', joinText(aw.slice(0, 8)) === "Hi, I'm Ana. Why?", joinText(aw.slice(0, 8)));

const icsiWords = `<nite:root nite:id="Y1.B.words">
   <w nite:id="Y1.w.1" starttime="10.0" endtime="" c="W">we</w>
   <w nite:id="Y1.w.2" starttime="" endtime="10.4" c="W">'re</w>
   <w nite:id="Y1.w.3" starttime="10.4" endtime="10.6" c="W">on</w>
   <w nite:id="Y1.w.4" starttime="10.6" endtime="10.6" c=".">.</w>
   <pause nite:id="Y1.p.1" starttime="10.6" endtime="11.0"/>
   <w nite:id="Y1.w.5" starttime="11.0" endtime="" c="W">Mm</w>
   <w nite:id="Y1.w.6" starttime="" endtime="" c="HYPH">-</w>
   <w nite:id="Y1.w.7" starttime="" endtime="11.4" c="W">hmm</w>
   <w nite:id="Y1.w.8" starttime="12.0" endtime="12.2" c="TRUNCW">th</w>
   <w nite:id="Y1.w.9" starttime="12.2" endtime="12.4" c="APOSS">'s</w>
</nite:root>`;
const iw = parseWords(icsiWords);
ok('ICSI words: a clitic is not a separate word', iw.filter((t) => t.word).length === 5, iw.filter((t) => t.word).map((t) => t.text).join('|'));
ok('ICSI words: empty times are NaN, not 0', Number.isNaN(iw[0].end) && Number.isNaN(iw[1].start));
ok('ICSI words: clitics and hyphens glue', joinText(iw) === "we're on. Mm-hmm th's", joinText(iw));

// ---------- dialogue acts ----------

const daTypes = parseAmiDaTypes(`<da-type nite:id="cmrda" name="da-type">
   <da-type nite:id="ami_daclass_0" name="minor" gloss="Minor"><da-type nite:id="ami_da_1" name="bck" gloss="Backchannel"/></da-type>
   <da-type nite:id="ami_da_4" name="inf" gloss="Inform"/>
   <da-type nite:id="ami_da_5" name="el.inf" gloss="Elicit-Inform"/>
</da-type>`);
ok('AMI da-types: id -> name', daTypes.get('ami_da_1') === 'bck' && daTypes.get('ami_da_5') === 'el.inf');
const amiDa = `<nite:root>
   <dact nite:id="d1"><nite:pointer role="da-aspect"  href="da-types.xml#id(ami_da_4)"/><nite:child href="X1.A.words.xml#id(X1.A.w0)..id(X1.A.w4)"/></dact>
   <dact nite:id="d2"><nite:pointer role="da-aspect"  href="da-types.xml#id(ami_da_5)"/><nite:child href="X1.A.words.xml#id(X1.A.w5)..id(X1.A.w6)"/></dact>
   <dact nite:id="d3"><nite:pointer role="da-aspect"  href="da-types.xml#id(ami_da_1)"/><nite:child href="X1.A.words.xml#id(X1.A.w7)"/></dact>
   <dact nite:id="d4"><nite:child href="X1.A.words.xml#id(X1.A.v0)"/></dact>
</nite:root>`;
const au = parseAmiDialogActs(amiDa, aw, 'A', daTypes);
ok('AMI acts: a wordless act (a laugh) is dropped', au.length === 3, String(au.length));
ok('AMI acts: words, text and times from the word range', au[0].words === 3 && au[0].text === "Hi, I'm Ana." && au[0].start === 1 && au[0].end === 2.4, JSON.stringify(au[0]));
ok('AMI acts: elicit-* is a question, bck is a backchannel, single-id range resolves', au[1].question && !au[1].backchannel && au[2].backchannel && au[2].text === 'Mm-hmm');

ok('ICSI general tags', icsiGeneralTags('fh|s^aa').join() === 'fh,s' && icsiGeneralTags('qy^d^rt').join() === 'qy' && icsiGeneralTags('b.%').join() === 'b' && icsiGeneralTags('s:s').join() === 's', icsiGeneralTags('s:s').join());
const icsiDa = `<nite:root>
   <dialogueact nite:id="a1" starttime="10.0" endtime="10.6" type="s.%-" participant="me1"><nite:child href="Y1.B.words.xml#id(Y1.w.1)..id(Y1.w.4)"/></dialogueact>
   <dialogueact nite:id="a2" starttime="11.0" endtime="11.4" type="b" participant="me1"><nite:child href="Y1.B.words.xml#id(Y1.w.5)..id(Y1.w.7)"/></dialogueact>
   <dialogueact nite:id="a3" starttime="12.0" endtime="12.4" type="qy^rt.%--" participant="me1"><nite:child href="Y1.B.words.xml#id(Y1.w.8)..id(Y1.w.9)"/></dialogueact>
</nite:root>`;
const iu = parseIcsiDialogActs(icsiDa, iw, 'B');
ok('ICSI acts: times from the act, not the words', iu.length === 3 && iu[0].start === 10 && iu[0].end === 10.6);
ok('ICSI acts: %- is interrupted, %-- (abandoned) is not', iu[0].interruptedDa && !iu[2].interruptedDa);
ok('ICSI acts: b is a backchannel, qy a question', iu[1].backchannel && !iu[0].backchannel && iu[2].question && !iu[0].question);

// ---------- turns ----------

const U = (speaker: string, start: number, end: number, text: string, extra: Partial<Unit> = {}): Unit => ({
  speaker, start, end, text, words: text.split(/\s+/).filter((w) => /\w/.test(w)).length, da: 'inf', backchannel: false, question: text.includes('?'), interruptedDa: false, ...extra,
});
ok('incomplete: no terminal punctuation', incomplete('and then we') && !incomplete('Done.') && !incomplete('Why?') && !incomplete('"Quoted."'));

// A speaks; B backchannels inside; A goes on (one turn). C cuts A off mid-sentence; A stops first.
// D starts over C late (0.2 s before C's finished act ends) and C is not cut.
const units: Unit[] = [
  U('A', 0, 4, 'We should price it at forty.'),
  U('B', 2, 2.4, 'Mm-hmm', { backchannel: true, da: 'bck' }),
  U('A', 4.2, 8, 'And the reason is that the'),
  U('C', 7, 10, 'No, the margin cannot carry that, why would it?'),
  U('D', 9.8, 12, 'Because volume.'),
];
const turns = buildTurns(units);
ok('a backchannel does not end a turn; A\'s two acts are one turn', turns.length === 3 && turns[0].speaker === 'A' && turns[0].units.length === 2, turns.map((t) => t.speaker).join());
ok('turn text and words join the acts', turns[0].text === 'We should price it at forty. And the reason is that the' && turns[0].words === 12, `${turns[0].text} / ${turns[0].words}`);
ok('overlap seconds: C starts 1 s before A\'s act ends', near(turns[1].overlapSec, 1), String(turns[1].overlapSec));
ok('A, cut mid-sentence and stopping first, is cut off', turns[0].cutOff);
ok('C finished its sentence, so D overlapping it is not a cut', !turns[1].cutOff && near(turns[2].overlapSec, 0.2, 1e-9), JSON.stringify(turns.map((t) => [t.cutOff, t.overlapSec])));
ok('with backchannels, B becomes a turn and splits A', buildTurns(units, { withBackchannels: true }).map((t) => t.speaker).join() === 'A,B,A,C,D');
const noCut = buildTurns([U('A', 0, 10, 'I will keep talking over you here'), U('B', 2, 4, 'Wait, what?')]);
ok('an overlapped speaker who keeps talking past the newcomer is not cut off', !noCut[0].cutOff && noCut[1].overlapSec === 2);

// ---------- meetings into the debate metrics ----------

const meeting: Meeting = { id: 'syn1', corpus: 'ami', kind: 'scenario', chair: 'A', units };
const di = toDebateInput(meeting, turns);
ok('the chair\'s turns are chair turns; the rest are floor turns', di.turns.map((t) => t.kind).join() === 'marcus,floor,floor');
ok('overlap is flagged at the 0.5 s threshold only', di.turns[1].overlap === true && di.turns[2].overlap === false);
const res = analyseMeeting(meeting);
ok('computeMetrics counts the two non-chair turns as expert turns', res.metrics.expertTurns === 2 && res.metrics.chairTurns === 1, JSON.stringify([res.metrics.expertTurns, res.metrics.chairTurns]));
ok('a cut chair turn is not an expert interruption (like the engine)', res.metrics.interruptionRate === 0);
ok('overlap and question rates in script units', res.metrics.overlapRate === 50 && res.metrics.questionShare === 0.5, JSON.stringify([res.metrics.overlapRate, res.metrics.questionShare]));
ok('extras: backchannels per 100 expert turns, overlap at 0/0.5/1 s', res.extras.backchannelPer100 === 50 && res.extras.overlapAnyPer100 === 100 && res.extras.overlap05Per100 === 50 && res.extras.overlap1Per100 === 50, JSON.stringify(res.extras));
ok('extras: no ICSI interrupted-act rate for AMI', res.extras.interruptedDaPer100 === null);
const noChair = analyseMeeting({ ...meeting, chair: null, corpus: 'icsi' });
ok('without a chair every speaker is an expert, and the cut on A counts', noChair.metrics.expertTurns === 3 && near(noChair.metrics.interruptionRate, 33.3, 0.05), String(noChair.metrics.interruptionRate));

// Windows: 10 alternating speakers, windows of 4 expert turns -> 2 windows, remainder dropped.
const alt: Unit[] = Array.from({ length: 10 }, (_, i) => U(i % 2 ? 'B' : 'C', i * 2, i * 2 + 1.5, `Point number ${i}.`));
const win = analyseWindows({ id: 'w', corpus: 'icsi', kind: 'x', chair: null, units: alt }, 4);
ok('windows of n expert turns, short remainder dropped', win.length === 2 && win.every((w) => w.metrics.expertTurns === 4) && win[1].id === 'w#1', JSON.stringify(win.map((w) => [w.id, w.metrics.expertTurns])));

// ---------- distributions and bands ----------

const d = dist([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
ok('dist: linear quantiles', d.median === 6 && d.p10 === 2 && d.p90 === 10 && d.q1 === 3.5 && d.iqr === 5 && d.n === 11, JSON.stringify(d));

const fx = (f: string) => {
  const raw = JSON.parse(fs.readFileSync(path.join(path.dirname(import.meta.filename ?? ''), 'fixtures', f), 'utf8'));
  return computeMetrics(fromEvents(f, f, raw.events));
};
const before = fx('realism-baseline.json');
const after = fx('realism-target.json');
ok('an empty band file scores exactly like realismIndex()', scoreWithBands(after, { bands: {} }) === realismIndex(after).index && scoreWithBands(before, { bands: {} }) === realismIndex(before).index);
const proposedPath = path.join(path.dirname(import.meta.filename ?? ''), '..', 'docs', 'calibration-proposed-bands.json');
const proposed = JSON.parse(fs.readFileSync(proposedPath, 'utf8')) as BandFile;
const known = new Set(REALISM_TARGETS.map((t) => t.key));
ok('the proposed band file names only metrics the index knows', Object.keys(proposed.bands).every((k) => known.has(k)), Object.keys(proposed.bands).filter((k) => !known.has(k)).join());
ok('every proposed band is a band (lo <= hi, scale > 0)', Object.values(proposed.bands).every((b) => (b.lo ?? -Infinity) <= (b.hi ?? Infinity) && (b.scale ?? 1) > 0));
const pb = scoreWithBands(before, proposed), pa = scoreWithBands(after, proposed);
ok('under the proposed bands the target fixture still beats the baseline one by 20+', pa > pb + 20, `${pb} -> ${pa}`);

console.log(fails ? `${fails} failed` : 'all calibrate-human self-tests passed');
process.exit(fails ? 1 : 0);
