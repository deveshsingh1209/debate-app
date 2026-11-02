/**
 * Design-system checks, no browser: reads the real tokens.css and asserts
 * WCAG AA contrast for every text role on every surface it sits on, in both
 * themes; that no external font or CDN URL is left anywhere in web/; and that
 * the sound cues are rate-limited and silent until enabled.
 *
 *   tsx web/scripts/design.selftest.ts      (part of npm run qa)
 *
 * Lives outside web/src so the browser build's tsconfig never sees node APIs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const css = fs.readFileSync(path.join(webRoot, 'src/design/tokens.css'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL', msg); }
}

// ---------- colour maths ----------

function hex(h: string): [number, number, number] {
  const m = h.replace('#', '');
  const v = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as [number, number, number];
}
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const unlin = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a: [number, number, number], b: [number, number, number]): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** color-mix(in oklab, a p%, b), as the browser computes it. */
function mixOklab(a: [number, number, number], b: [number, number, number], pa: number): [number, number, number] {
  const toLab = (rgb: [number, number, number]) => {
    const [r, g, bl] = rgb.map(lin);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  const fromLab = ([L, A, B]: number[]): [number, number, number] => {
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
    return rgb.map((c) => Math.min(1, Math.max(0, unlin(c)))) as [number, number, number];
  };
  const la = toLab(a);
  const lb = toLab(b);
  return fromLab(la.map((v, i) => v * pa + lb[i] * (1 - pa)));
}

// ---------- read the themes from the file ----------

function block(selectorRe: RegExp): Record<string, string> {
  const m = css.match(selectorRe);
  if (!m) throw new Error(`theme block not found: ${selectorRe}`);
  const start = css.indexOf('{', m.index!);
  const end = css.indexOf('}', start);
  const out: Record<string, string> = {};
  for (const mm of css.slice(start, end).matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,6})\b/g)) out[mm[1]] = mm[2];
  return out;
}
const primary = block(/:root\s*\{\s*--primary-fill/);
const primaryLight = block(/:root\[data-theme='light'\]\s*\{\s*--primary-fill/);
const themes: Record<string, Record<string, string>> = {
  dark: { ...block(/:root,\s*:root\[data-theme='dark'\]/), ...primary },
  light: { ...block(/:root\[data-theme='light'\]\s*\{\s*color-scheme/), ...primary, ...primaryLight },
};

// Persona colours the server hands out (mock cast + the chair); the light
// theme deepens them by --seat-mix-pct toward black.
const SEATS = ['#22d3ee', '#a78bfa', '#34d399', '#f472b6', '#fb923c', '#d9b45b', '#7aa7c7', '#3ee0ff'];

for (const [name, t] of Object.entries(themes)) {
  console.log(`theme ${name}`);
  const need = ['ground', 'surface', 'raised', 'active', 'sunken', 'text', 'muted', 'faint', 'accent', 'positive', 'negative', 'warning', 'info', 'border', 'control'];
  for (const k of need) ok(!!t[k], `${name}: --${k} defined`);
  const surfaces = ['ground', 'surface', 'raised'];
  const textRoles = ['text', 'muted', 'faint', 'accent', 'positive', 'negative', 'warning', 'info'];
  for (const s of surfaces) {
    for (const r of textRoles) {
      const c = ratio(hex(t[r]), hex(t[s]));
      ok(c >= 4.5, `${name}: --${r} on --${s} is ${c.toFixed(2)}:1 (needs 4.5)`);
    }
  }
  for (const r of ['text', 'muted']) {
    const c = ratio(hex(t[r]), hex(t.active));
    ok(c >= 4.5, `${name}: --${r} on --active is ${c.toFixed(2)}:1`);
  }
  // status text on its own pale pill
  for (const [ink, bg] of [['positive', 'pill-positive-bg'], ['negative', 'pill-negative-bg'], ['warning', 'pill-warning-bg']]) {
    const c = ratio(hex(t[ink]), hex(t[bg]));
    ok(c >= 4.5, `${name}: --${ink} on --${bg} is ${c.toFixed(2)}:1`);
  }
  // Heat and the selection line carry meaning on their own: 3:1 against the
  // ground (WCAG 1.4.11). Control borders never do (every control has a
  // label), so they only have to be visibly there: 2:1.
  for (const r of ['heat-cool', 'heat-warm', 'heat-hot', 'accent-line', 'control']) {
    const c = ratio(hex(t[r]), hex(t.ground));
    ok(c >= (r === 'control' ? 2 : 3), `${name}: --${r} on --ground is ${c.toFixed(2)}:1 (mark)`);
  }
  const pc = ratio(hex(t['primary-ink']), hex(t['primary-fill']));
  ok(pc >= 4.5, `${name}: primary label on primary fill is ${pc.toFixed(2)}:1`);
  // seat colours as ink
  const pct = name === 'light' ? 0.62 : 1;
  for (const s of SEATS) {
    const ink = name === 'light' ? mixOklab(hex(s), [0, 0, 0], pct) : hex(s);
    for (const surf of ['ground', 'surface']) {
      const c = ratio(ink, hex(t[surf]));
      ok(c >= 4.5, `${name}: seat ${s} as ink on --${surf} is ${c.toFixed(2)}:1`);
    }
  }
}
ok(/--seat-mix-pct:\s*38%/.test(css), 'light theme deepens seat colours by 38% (the test above assumes it)');

// ---------- no outside requests ----------

console.log('no external fonts or CDNs');
const banned = /fonts\.googleapis|fonts\.gstatic|use\.typekit|cdn\.jsdelivr|unpkg\.com|cdnjs\.|fonts\.bunny/i;
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}
for (const f of walk(webRoot)) {
  if (!/\.(tsx?|css|html|json)$/.test(f) || f === fileURLToPath(import.meta.url)) continue;
  const src = fs.readFileSync(f, 'utf8');
  ok(!banned.test(src), `${path.relative(webRoot, f)} has no external font/CDN URL`);
  if (/\.css$/.test(f)) ok(!/@import\s+url\(\s*['"]?https?:/i.test(src), `${path.relative(webRoot, f)} imports nothing over http`);
}
// The report and the transcript PDF are rendered by the server and opened
// from disk; they must not reach a font CDN either.
for (const f of walk(path.resolve(webRoot, '../server/src/report'))) {
  if (!/\.ts$/.test(f)) continue;
  ok(!banned.test(fs.readFileSync(f, 'utf8')), `server ${path.basename(f)} has no external font/CDN URL`);
}

const dist = path.join(webRoot, 'dist');
if (fs.existsSync(dist)) {
  for (const f of walk(dist)) {
    if (!/\.(js|css|html)$/.test(f)) continue;
    ok(!banned.test(fs.readFileSync(f, 'utf8')), `built ${path.relative(webRoot, f)} has no external font/CDN URL`);
  }
}

// ---------- sound: silent until enabled, rate-limited ----------

console.log('sound');
const { createLimiter, CUE_SPEC } = await import('../src/lib/sound-core.ts');
{
  const lim = createLimiter();
  let t = 0;
  const fired: string[] = [];
  for (let i = 0; i < 40; i++) { if (lim.allow('tick', t)) fired.push('tick'); t += 50; }
  ok(fired.length <= Math.ceil(2000 / CUE_SPEC.tick.minGapMs) + 1, `tick spam over 2s is held to its gap (${fired.length} fired)`);
  const lim2 = createLimiter();
  let n = 0;
  const kinds = Object.keys(CUE_SPEC) as (keyof typeof CUE_SPEC)[];
  for (let i = 0; i < 200; i++) if (lim2.allow(kinds[i % kinds.length], i * 30)) n++;
  ok(n <= 6 + 1, `at most ~6 cues in any 10s window of mixed spam (${n} in 6s)`);
  const lim3 = createLimiter();
  ok(lim3.allow('gavel', 0) && !lim3.allow('gavel', 100), 'same cue twice inside its gap is dropped');
  ok(lim3.allow('gavel', CUE_SPEC.gavel.minGapMs + 300), 'same cue after its gap plays');
}

console.log(`\ndesign selftest: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
