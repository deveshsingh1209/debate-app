import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { renderReport } from './render.ts';
import { renderTranscriptHtml } from './transcript-pdf.ts';
import { runPrintQa, type QaResult } from './qa.ts';
import { stressFixtures } from './stress.ts';

/**
 * `npm run qa` — the standard, made runnable.
 *
 * Renders the hostile corpus (and any real report.json handed to it) at print
 * width and measures the resulting layout. Exits non-zero on any finding, so
 * it can gate a deploy the same way a test suite does. This is what "the PDF
 * is always well formatted" is allowed to mean: not that someone looked, but
 * that a machine measured every page of a set of documents chosen to break it,
 * and found no element outside its box, over another, or off the sheet.
 */

const WIDTH_MM = 182; // A4 (210mm) minus the 14mm horizontal @page margins

function report(name: string, r: QaResult): boolean {
  if (r.ok) {
    console.log(`  PASS  ${name.padEnd(24)} ${r.measuredNodes} nodes measured`);
    return true;
  }
  console.log(`  FAIL  ${name.padEnd(24)} ${r.measuredNodes} nodes measured`);
  for (const i of r.issues) {
    console.log(`        [${i.check}] x${i.count}`);
    for (const s of i.samples) console.log(`          - ${s}`);
  }
  return false;
}

async function main() {
  const extra = process.argv.slice(2);
  let allOk = true;

  const fixture = stressFixtures().find((f) => f.name === 'with-realism')!;
  const dissent = fixture.data.minority![0];
  dissent.tripwire = { signal: 'More than three requests by 28 February', by: '28 February' };
  assert.match(renderReport(fixture.data), /More than three requests by 28 February<\/p>/);
  dissent.tripwire = { signal: 'More than three requests', by: '28 February' };
  assert.match(renderReport(fixture.data), /More than three requests <span class="dis-by">by 28 February<\/span>/);

  // Evidence honesty (P1): the anecdotes section, and the persona labels on a trail and an audit row, are printed.
  const persona = renderReport(stressFixtures().find((f) => f.name === 'with-persona')!.data);
  assert.match(persona, /<section class="sec" id="persona" data-sec>/);
  assert.match(persona, /Panel Anecdotes, Not Evidence/);
  assert.match(persona, /class="dep-chip dep-assumed">Assumption, not evidence/);
  assert.match(persona, /<td class="au-im"><span class="assumed-tag">assumption<\/span> /);
  assert.doesNotMatch(renderReport(stressFixtures().find((f) => f.name === 'minimal')!.data), /id="persona"/);

  console.log('\nPrint QA: hostile corpus');
  for (const f of stressFixtures()) {
    allOk = report(f.name, await runPrintQa(renderReport(f.data), { contentWidthMm: WIDTH_MM })) && allOk;
  }

  for (const file of extra) {
    if (!fs.existsSync(file)) continue;
    console.log(`\nPrint QA: ${path.basename(file)}`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw.title && raw.decisions) {
      allOk = report('report', await runPrintQa(renderReport(raw), { contentWidthMm: WIDTH_MM })) && allOk;
    }
  }

  console.log(allOk ? '\nAll documents measured clean.\n' : '\nLayout faults found; the template is wrong, not the data.\n');
  process.exit(allOk ? 0 : 1);
}

main();
