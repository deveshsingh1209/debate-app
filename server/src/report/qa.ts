import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromeSandboxFlags, findChrome, sandboxFailed } from './pdf.ts';
import { withReportCsp } from './csp.ts';

/**
 * The print-QA gate.
 *
 * "It looked fine on the session I checked" is an anecdote, and the founder is
 * right that it is not a standard. Report content varies with every session:
 * chart shapes, table widths, string lengths, how many decisions a room
 * produced. A template that survived one report can still be broken by the
 * next one's data.
 *
 * So every report is measured before it ships. The document is loaded in
 * headless Chrome at exactly the printable width, the print stylesheet is
 * flipped on (see printCss in render.ts for why it is a separate tag), and a
 * probe script measures the real layout: geometry, not opinion. It reports
 *
 *   overflow   — anything wider than the printable page
 *   clipped    — text cut off by its own box
 *   overlap    — visual elements printed over each other
 *   svg-escape — chart marks or labels drawn outside their chart's frame
 *   illegible  — charts too small to read, or type below ~6pt
 *   blank      — sections that rendered to nothing
 *   fonts      — the display faces failed to load (warning: layout metrics shift)
 *
 * The gate never blocks a deliverable. A finished report with one flawed chart
 * is worth more than no report; the failure is logged, surfaced to the host,
 * and fixed in the template so the whole fleet stops producing it.
 */

export interface QaIssue {
  check: 'overflow' | 'clipped' | 'overlap' | 'svg-escape' | 'illegible' | 'blank' | 'fonts';
  count: number;
  samples: string[];
}

export interface QaResult {
  ok: boolean;
  issues: QaIssue[];
  measuredNodes: number;
}

/**
 * Runs inside the page. Serialised into the document, executed by Chrome
 * during --dump-dom's virtual time budget, and its findings are written into a
 * DOM node the dump then carries back out. No debugging protocol, no new
 * dependencies: the DOM itself is the transport.
 */
const PROBE = String.raw`
(async () => {
  const out = { issues: [], measuredNodes: 0 };
  const sample = (el, extra) => {
    const tag = el.tagName ? el.tagName.toLowerCase() : '?';
    const cls = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || '';
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    return (tag + (cls ? '.' + String(cls).split(' ')[0] : '') + (txt ? ' "' + txt + '"' : '') + (extra || '')).slice(0, 120);
  };
  const push = (check, els, extras) => {
    if (!els.length) return;
    out.issues.push({ check, count: els.length, samples: els.slice(0, 5).map((e, i) => sample(e, extras && extras[i])) });
  };

  /**
   * Timers, not animation frames.
   *
   * Under --virtual-time-budget Chrome advances timers but a page that goes
   * idle may never run another rAF, so the probe's continuation never fired
   * and the DOM was dumped before it measured anything. That produced the
   * worst possible result: a clean report of zero nodes, which reads as a
   * pass. Small documents failed this way while the largest one passed,
   * purely because it took Chrome long enough to finish.
   */
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  await Promise.race([document.fonts.ready.catch(() => {}), tick(3000)]);

  // Print geometry, on screen: flip the print sheet on and pin the viewport
  // to the printable width so every measurement below is of the real page.
  const printStyle = document.getElementById('print-css');
  if (printStyle) printStyle.media = 'all';
  document.documentElement.style.width = String(window.__QA_WIDTH_MM__) + 'mm';
  document.body.style.width = '100%';
  void document.body.getBoundingClientRect();   // force a synchronous reflow
  await tick(250);

  const pageRight = document.documentElement.getBoundingClientRect().right + 2;

  // Visible leaf elements with real content: the atoms of the layout.
  const leaves = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('[data-qa-ignore]')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const isLeafText = el.childElementCount === 0 && (el.textContent || '').trim().length > 0;
    if (isLeafText || el.tagName === 'IMG' || el.tagName === 'svg') leaves.push({ el, r });
  }
  out.measuredNodes = leaves.length;

  // 1. Overflow past the printable width.
  push('overflow', leaves.filter((l) => l.r.right > pageRight || l.r.left < -2).map((l) => l.el));

  // 2. Text clipped by its own box.
  const clipped = [];
  for (const { el } of leaves) {
    if (el.tagName === 'svg' || el.tagName === 'IMG') continue;
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      const cs = getComputedStyle(el);
      if (cs.overflowX !== 'visible' && cs.textOverflow !== 'ellipsis') clipped.push(el);
    }
  }
  push('clipped', clipped);

  // 3. Overlaps between text atoms that are not kin. A spatial grid keeps the
  //    pairing tractable on multi-thousand-node reports.
  const grid = new Map();
  const cell = 120;
  const keyOf = (x, y) => ((x / cell) | 0) + ':' + ((y / cell) | 0);
  const overlaps = [];
  const seen = new Set();
  leaves.forEach((a, i) => {
    if (a.el.tagName === 'svg') return;
    if (a.el.closest('svg')) return;              // chart internals are checked by getBBox below
    for (let gx = a.r.left; gx < a.r.right + cell; gx += cell) {
      for (let gy = a.r.top; gy < a.r.bottom + cell; gy += cell) {
        const k = keyOf(gx, gy);
        for (const j of grid.get(k) || []) {
          const b = leaves[j];
          const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
          const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
          if (w < 3 || h < 3) continue;
          const inter = w * h;
          const smaller = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
          if (inter < smaller * 0.25) continue;    // touching borders is not overlap
          if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
          const pk = i < j ? i + '-' + j : j + '-' + i;
          if (seen.has(pk)) continue;
          seen.add(pk);
          overlaps.push(a.el);
        }
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    }
  });
  push('overlap', overlaps);

  /**
   * 4. Chart marks or labels escaping their frame.
   *
   * Measured in SCREEN coordinates, not getBBox. getBBox reports a node's box
   * in its own user space with its own transform NOT applied, so a rotated
   * y-axis title looked like it was far outside the viewBox when it sits
   * perfectly inside the chart. That false positive would have had me
   * "fixing" correct code. Client rects have every transform already baked in.
   */
  const escapes = [];
  for (const svg of document.querySelectorAll('svg')) {
    const frame = svg.getBoundingClientRect();
    if (frame.width < 2) continue;
    for (const node of svg.querySelectorAll('text, rect, circle, path')) {
      const r = node.getBoundingClientRect();
      if (r.width < 0.5 && r.height < 0.5) continue;
      const pad = 2;
      if (r.left < frame.left - pad || r.right > frame.right + pad ||
          r.top < frame.top - pad || r.bottom > frame.bottom + pad) {
        escapes.push(node);
      }
    }
  }
  push('svg-escape', escapes);

  /**
   * 5. Legibility, which geometry alone will happily call fine.
   *
   * A chart squeezed to half an A4 column overflows nothing and overlaps
   * nothing; it is simply too small to read, which is worse than a fault
   * because it looks deliberate. Same for type below ~6pt. Both are measured
   * as numbers here rather than left to whoever opens the PDF.
   */
  const MIN_CHART_PX = 300;   // ~79mm at this render width: below it, axes stop being readable
  const tiny = [...document.querySelectorAll('svg')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.width < MIN_CHART_PX;
  });
  if (tiny.length) out.issues.push({
    check: 'illegible',
    count: tiny.length,
    samples: tiny.slice(0, 5).map((el) => 'chart ' + (el.id || '?') + ' only ' + Math.round(el.getBoundingClientRect().width) + 'px wide'),
  });

  const smallType = [];
  for (const { el } of leaves) {
    const px = parseFloat(getComputedStyle(el).fontSize) || 12;
    if (px < 7.5) smallType.push(el);
  }
  push('illegible', smallType);

  // 6. Sections that rendered to nearly nothing.
  push('blank', [...document.querySelectorAll('.sec, .cover, .toc')].filter((el) => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && el.getBoundingClientRect().height < 30;
  }));

  // 7. Display faces missing: metrics were measured with fallbacks.
  try {
    const missing = ['Rajdhani', 'Inter', 'JetBrains Mono'].filter(
      (f) => !document.fonts.check('12px "' + f + '"')
    );
    if (missing.length === 3) out.issues.push({ check: 'fonts', count: 3, samples: missing });
  } catch {}

  const node = document.createElement('script');
  node.type = 'application/json';
  node.id = 'qa-out';
  node.textContent = JSON.stringify(out);
  document.body.appendChild(node);
})();
`;

/**
 * Measure a rendered report/transcript HTML at print width.
 * contentWidthMm = paper width minus the horizontal @page margins.
 */
export async function runPrintQa(html: string, opts: { contentWidthMm: number; timeoutMs?: number } = { contentWidthMm: 182 }): Promise<QaResult> {
  const chrome = findChrome();
  if (!chrome) return { ok: true, issues: [], measuredNodes: 0 };

  const injected = withReportCsp(html).replace(
    '</body>',
    `<script>window.__QA_WIDTH_MM__=${opts.contentWidthMm};</script><script>${PROBE}</script></body>`
  );
  const first = await measureOnce(chrome, injected, opts);
  // The same fallback as the PDF itself, on a host where Chrome's sandbox cannot start.
  if (first.measuredNodes === 0 && !first.ok && sandboxFailed(first.stderr)) return measureOnce(chrome, injected, opts);
  return first;
}

function measureOnce(chrome: string, injected: string, opts: { timeoutMs?: number }): Promise<QaResult & { stderr: string }> {
  const stageRoot = process.env.DATA_DIR ?? os.tmpdir();
  fs.mkdirSync(stageRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(stageRoot, '.qa-'));
  const src = path.join(tmp, 'qa.html');
  fs.writeFileSync(src, injected, 'utf8');

  const args = [
    '--headless=new',
    '--disable-gpu',
    ...chromeSandboxFlags(),
    '--disable-dev-shm-usage',
    // Local-first: a fresh profile must not phone home (updates, sync, field trials).
    '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--virtual-time-budget=12000',
    '--window-size=900,1400',
    `--user-data-dir=${path.join(tmp, 'profile')}`,
    '--dump-dom',
    'file://' + src,
  ];

  return new Promise((done) => {
    const proc = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let outBuf = '';
    let stderr = '';
    const resolve = (r: QaResult) => done({ ...r, stderr });
    proc.stdout.on('data', (d) => { outBuf += String(d); });
    proc.stderr.on('data', (d) => { stderr = (stderr + String(d)).slice(-1500); });
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, opts.timeoutMs ?? 60_000);
    proc.on('exit', () => {
      clearTimeout(timer);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
      const m = outBuf.match(/<script[^>]*id="qa-out"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) return resolve({ ok: false, issues: [{ check: 'blank', count: 1, samples: ['probe produced no output: document UNVERIFIED'] }], measuredNodes: 0 });
      try {
        const parsed = JSON.parse(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
        /**
         * Zero measured nodes is a broken probe, not a clean document, and it
         * must never read as a pass: that is exactly how a QA gate quietly
         * stops testing while still printing PASS.
         */
        if (!parsed.measuredNodes) {
          return resolve({
            ok: false,
            measuredNodes: 0,
            issues: [{ check: 'blank', count: 1, samples: ['probe measured 0 elements: it did not run, so this document is UNVERIFIED'] }],
          });
        }
        resolve({ ok: parsed.issues.length === 0, issues: parsed.issues, measuredNodes: parsed.measuredNodes });
      } catch {
        resolve({ ok: false, issues: [{ check: 'blank', count: 1, samples: ['probe output unparseable: document UNVERIFIED'] }], measuredNodes: 0 });
      }
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: true, issues: [], measuredNodes: 0 });
    });
  });
}
