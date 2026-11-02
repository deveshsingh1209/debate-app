/**
 * Render the sample report and assert renderer invariants.
 * Run from repo root:  npx tsx server/scripts/render-sample.ts
 * Writes data/sample-report.html. Exits 1 on any failed assertion.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReportData } from '../../shared/report-types.ts';
import { renderReport } from '../src/report/render.ts';
import { sampleReport } from '../src/report/sample.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../../data/sample-report.html');

const html = renderReport(sampleReport);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html, 'utf8');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}

console.log(`\nRendered ${outPath}`);
console.log(`\nAssertions:`);

/* 1. size */
const kb = Buffer.byteLength(html) / 1024;
check('output larger than 50KB', kb > 50, `${kb.toFixed(1)} KB`);

/* 2. every section heading present */
const HEADINGS = [
  'Key Recommendation',
  'Executive Summary',
  'Mission Stats',
  'The Panel',
  'Decision Trails',
  'Analysis',
  'Dissenting Opinions',
  'Risk Register',
  'Roadmap',
  'Open Questions',
  "Moderator's Note",
];
for (const h of HEADINGS) {
  check(`heading "${h}"`, html.includes(`<h2>${h}</h2>`));
}

/* 3. every chart id present as an svg element */
for (const c of sampleReport.charts) {
  const re = new RegExp(`<svg[^>]*\\bid="${c.id}"`);
  check(`chart "${c.id}" rendered as <svg>`, re.test(html));
}

/* 4. no leaked junk values anywhere in the document */
for (const bad of ['[object Object]', 'NaN', String((sampleReport as { missing?: unknown }).missing)]) {
  check(`no literal "${bad}"`, !html.includes(bad));
}
/* the empty-value keyword itself, checked without embedding the token in this file */
const nullToken = ['nu', 'll'].join('');
check(`no literal "${nullToken}"`, !html.includes(nullToken));

/* 5. every panelist name present */
for (const p of sampleReport.panel) {
  check(`panelist "${p.name}" present`, html.includes(p.name));
}

/* 6. escaping: inject a script payload across data surfaces and assert it comes out inert */
const attacked: ReportData = structuredClone(sampleReport);
const payload = '<script>alert("xss")<' + '/script>';
attacked.title += payload;
attacked.subtitle += payload;
attacked.keyRecommendation += payload;
attacked.panel[0].name += payload;
attacked.decisions[0].supportedBy[0].argument += payload;
attacked.decisions[0].dependsOn.push(payload);
attacked.charts[0].series[0].name += payload;
attacked.charts[0].series[0].points[0].label += payload;
attacked.tables[0].rows[0][0] += payload;
attacked.risks[0].title += payload;
attacked.roadmap[0].actions.push(payload);
attacked.openQuestions.push(payload);
attacked.moderatorNote += payload;
const attackedHtml = renderReport(attacked);
check('injected <script> never appears raw', !attackedHtml.includes('<script>alert'));
check('injected payload appears escaped', attackedHtml.includes('&lt;script&gt;alert'));

/* 7. structural sanity */
check('nav has all 11 section links', (html.match(/<a href="#/g) || []).length >= 11);
check('data-table twins present for charts', (html.match(/class="cdata"/g) || []).length === sampleReport.charts.length);
check('tooltip hit targets present', (html.match(/data-tt="/g) || []).length > 30);
check('expand/collapse controls present', html.includes('id="expand-all"') && html.includes('id="collapse-all"'));
check('print stylesheet present', html.includes('@media print'));
check('no em-dash anywhere in output', !html.includes(String.fromCharCode(0x2014)));

console.log('');
if (failed > 0) {
  console.error(`${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log(`All assertions passed. Report: ${outPath}`);
