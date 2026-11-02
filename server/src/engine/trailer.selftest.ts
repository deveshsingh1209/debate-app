/**
 * The turn trailer: parsing, the "only at the end" rule, and the streaming
 * hold-back. Pure; no engine, no model.
 *
 *   npx tsx src/engine/trailer.selftest.ts
 */
import { splitTrailer, TrailerStreamFilter } from './trailer.ts';

let fails = 0;
let passes = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) passes++;
  else fails++;
  console.log(`${cond ? '  ok  ' : '  FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};
const j = (v: unknown) => JSON.stringify(v);

console.log('[1] a full trailer comes off and parses');
{
  const raw = [
    'Inside month two? On what base? Your payback ignores the returns.',
    '',
    'STANCE: against-2 | confidence: high | crux: payback after returns',
    'CLAIMS: [observed] returns ran nine percent at my last shop; [assumed] Sunday buyers return less',
    'ASK: kabir | Which base is that payback on?',
    'COMPUTE: payback months after returns and fulfilment, from the cost sheet',
    'RESEARCH: typical return rates for online bakery orders in 2025',
  ].join('\n');
  const s = splitTrailer(raw);
  ok('the spoken text is only the speech', s.text === 'Inside month two? On what base? Your payback ignores the returns.', j(s.text));
  ok('stance parsed', s.trailer.stance?.stance === -2 && s.trailer.stance.confidence === 'high' && s.trailer.stance.crux === 'payback after returns', j(s.trailer.stance));
  ok('claims parsed with their grades', j(s.trailer.claims) === j([
    { text: 'returns ran nine percent at my last shop', grade: 'observed' },
    { text: 'Sunday buyers return less', grade: 'assumed' },
  ]), j(s.trailer.claims));
  ok('ask parsed', s.trailer.ask?.to === 'kabir' && s.trailer.ask.question === 'Which base is that payback on?', j(s.trailer.ask));
  ok('compute parsed', s.trailer.compute === 'payback months after returns and fulfilment, from the cost sheet');
  ok('research parsed', s.trailer.research === 'typical return rates for online bakery orders in 2025');
  ok('keys listed in order', s.keys.join() === 'STANCE,CLAIMS,ASK,COMPUTE,RESEARCH', s.keys.join());
}

console.log('[2] bold markers, bullets and case');
{
  const s = splitTrailer('No.\n**STANCE:** for+1 | confidence: low\n- **claims**: [Measured] the till shows 40 Sunday covers');
  ok('bold and bulleted keys are recognised', s.text === 'No.' && s.trailer.stance?.stance === 1 && s.trailer.stance.confidence === 'low', j(s));
  ok('grade is case-insensitive', s.trailer.claims?.[0]?.grade === 'measured' && s.trailer.claims[0].text === 'the till shows 40 Sunday covers', j(s.trailer.claims));
  const w = splitTrailer('Fine.\nSTANCE: neutral 0 | crux: whether staff agree');
  ok('neutral 0', w.trailer.stance?.stance === 0 && w.trailer.stance.crux === 'whether staff agree', j(w.trailer.stance));
  ok('a word alone is a stance', splitTrailer('x\nSTANCE: against').trailer.stance?.stance === -1);
  ok('"against 2" is -2', splitTrailer('x\nSTANCE: against 2').trailer.stance?.stance === -2);
  ok('an out-of-range stance is clamped', splitTrailer('x\nSTANCE: for+2 | confidence: high').trailer.stance?.stance === 2);
}

console.log('[3] malformed lines');
{
  const s = splitTrailer('Speech.\nSTANCE: maybe\nCLAIMS:\nASK: \nCOMPUTE: x\nRESEARCH: y');
  ok('malformed values are dropped, the lines still come off', s.text === 'Speech.' && j(s.trailer) === '{}', j(s));
  ok('and the keys are still listed', s.keys.length === 5);
  const u = splitTrailer('Speech.\nCLAIMS: most buyers decide on the day');
  ok('an ungraded claim is graded assumed', u.trailer.claims?.[0]?.grade === 'assumed', j(u.trailer.claims));
  const wrap = splitTrailer('Speech.\nCLAIMS: [observed] one thing;\n[assumed] a second thing that wrapped');
  ok('a wrapped CLAIMS line continues', wrap.trailer.claims?.length === 2 && wrap.text === 'Speech.', j(wrap));
}

console.log('[4] a trailer-looking line in the middle of a turn stays speech');
{
  const raw = 'Claims: that is the word the brochure uses.\nCOMPUTE: something long enough to run\nBut the real question is the rota.';
  const s = splitTrailer(raw);
  ok('nothing is stripped', s.text === raw && s.keys.length === 0, j(s));
  const t = splitTrailer('Ask Bo about the ovens. He knows.');
  ok('"Ask Bo" is speech', t.text === 'Ask Bo about the ovens. He knows.' && !t.trailer.ask);
  const v = splitTrailer('STANCE: for+1\nThen I said what I said.\nCLAIMS: [observed] it happened');
  ok('only the block at the end counts', v.text === 'STANCE: for+1\nThen I said what I said.' && v.trailer.claims?.length === 1 && !v.trailer.stance, j(v));
  ok('no trailer, text unchanged', splitTrailer('  Just speech.  ').text === 'Just speech.');
}

console.log('[5] the streaming hold-back');
const stream = (raw: string, chunk: number) => {
  let out = '';
  const f = new TrailerStreamFilter((t) => (out += t));
  for (let i = 0; i < raw.length; i += chunk) f.push(raw.slice(i, i + chunk));
  return out;
};
{
  const raw = 'Who bakes at five? Nobody has said.\nSTANCE: against-1 | confidence: medium\nCLAIMS: [assumed] nobody wants the shift';
  for (const n of [1, 3, 7, 1000]) {
    const out = stream(raw, n);
    ok(`chunks of ${n}: the trailer never reaches the screen`, !/STANCE|CLAIMS|nobody wants/.test(out), j(out));
    ok(`chunks of ${n}: the speech does`, out.startsWith('Who bakes at five? Nobody has said.'), j(out));
  }
  const mid = 'COMPUTE: a line that looks like a call\nBut then the speaker kept talking.';
  ok('a held line is released when speech follows', stream(mid, 4) === mid, j(stream(mid, 4)));
  const cl = 'Close it.\nCLAIMS: [observed] one;\n[assumed] two';
  ok('a wrapped trailer stays hidden', !/observed|assumed/.test(stream(cl, 2)), j(stream(cl, 2)));
  const speech = 'Asking the obvious: Stan said Sunday. Clairvoyance aside, who works?';
  ok('words that start like keys are not held for good', stream(speech, 2) === speech, j(stream(speech, 2)));
  const bold = 'Right.\n**COMPUTE:** refunds over revenue in Q3';
  ok('a bold desk call is held back', stream(bold, 3).trim() === 'Right.', j(stream(bold, 3)));
}

console.log('[persona] the persona grade (P1)');
{
  const s = splitTrailer('My head baker walked after eight Sundays.\nCLAIMS: [persona] my head baker quit after eight weeks of covering Sundays; [Persona experience] my good Sunday ran on weekend hires; [assumed] losing a key baker costs more than a Sunday trial earns');
  ok('[persona] and [persona experience] both parse as persona', j(s.trailer.claims?.map((c) => c.grade)) === j(['persona', 'persona', 'assumed']), j(s.trailer.claims));
  ok('the claim text loses the grade word', s.trailer.claims?.[1]?.text === 'my good Sunday ran on weekend hires', j(s.trailer.claims));
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
