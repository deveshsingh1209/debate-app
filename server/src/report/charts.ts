/**
 * DEBATE report - inline SVG chart builders.
 * Pure functions: ChartSpec in, SVG (plus small HTML legend/aux) string out.
 * Zero runtime deps. All colors are CSS custom properties defined by render.ts
 * (validated categorical palette, dark screen values + light print values),
 * so every chart restyles itself automatically under @media print.
 *
 * Honesty rules applied throughout: bar/line y-axes start at 0, axes are
 * labeled with units, no 3D, one axis per chart, fixed-order categorical
 * palette (never cycled - overflow folds into "Other"), and every chart
 * ships a data-table twin (built by chartDataTable) as the WCAG relief
 * channel for tooltips and for sub-3:1 print fills.
 */

import type { ChartSpec } from '../../../shared/report-types.ts';

/* ------------------------------------------------------------------ */
/* Escaping + formatting                                               */
/* ------------------------------------------------------------------ */

/** HTML-escape any interpolated value. Nullish becomes empty string. */
export function esc(v: unknown): string {
  if (v === void 0 || (typeof v === 'object' && !v)) return '';
  return String(v).replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

/** Escape for use inside an attribute, preserving newlines as entities. */
function escAttr(v: unknown): string {
  return esc(v).replace(/\n/g, '&#10;');
}

function trim1(n: number): string {
  const r = Math.round(n * 10) / 10;
  return String(Number.isInteger(r) ? r : r.toFixed(1));
}

/** Format a value with its unit. Indian grouping for rupee figures. */
export function fmtVal(v: number, unit?: string): string {
  if (!Number.isFinite(v)) return '';
  if (unit === '₹') {
    const a = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    if (a >= 1e7) return `${sign}₹${trim1(a / 1e7)} Cr`;
    if (a >= 1e5) return `${sign}₹${trim1(a / 1e5)} L`;
    return `${sign}₹${a.toLocaleString('en-IN', { maximumFractionDigits: a < 10 ? 1 : 0 })}`;
  }
  if (unit === '%') return `${trim1(v)}%`;
  if (unit === 'mo') return `${trim1(v)} mo`;
  const abs = Math.abs(v);
  const base =
    abs >= 1e6 ? `${trim1(v / 1e6)}M` : abs >= 1e4 ? v.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : trim1(v);
  return unit ? `${base} ${unit}` : base;
}

/**
 * The unit as it may appear on an AXIS TICK — a symbol, never a sentence.
 *
 * `unit` is model-supplied, and a writer describing what it measured rather
 * than naming a symbol ("USD per complete lead") used to be stapled onto every
 * tick by fmtVal: a real report shipped an axis reading "0 USD per complete
 * lead / 1 USD per complete lead / …", which overflowed its plot and escaped
 * the SVG on all ten ticks. The long form still has a home — the axis TITLE,
 * which is a sentence-shaped place — so nothing is lost by refusing it here.
 */
const TICK_UNIT_MAX = 3;
function tickUnit(u?: string): string | undefined {
  if (!u) return undefined;
  const t = u.trim();
  return t.length <= TICK_UNIT_MAX ? t : undefined;
}

/* ------------------------------------------------------------------ */
/* Scale helpers                                                       */
/* ------------------------------------------------------------------ */

function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(max)));
  const f = max / p;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 4 ? 4 : f <= 5 ? 5 : f <= 8 ? 8 : 10;
  return nf * p;
}

/**
 * A vertical domain that can hold negative values.
 *
 * niceMax only ever described the top of the axis, so a series containing a
 * negative number mapped below the plot floor and the line, its points and its
 * end labels were drawn outside the SVG frame entirely. The QA corpus caught
 * 41 escaped marks from one such chart. Real reports produce negatives all the
 * time: margin bridges, variances, churn deltas.
 */
function niceDomain(values: number[]): { lo: number; hi: number } {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return { lo: 0, hi: 1 };
  const rawHi = Math.max(...finite);
  const rawLo = Math.min(...finite);
  if (rawLo >= 0) return { lo: 0, hi: niceMax(rawHi) || 1 };
  if (rawHi <= 0) return { lo: -(niceMax(-rawLo) || 1), hi: 0 };
  return { lo: -(niceMax(-rawLo) || 1), hi: niceMax(rawHi) || 1 };
}

function n2(v: number): number {
  return Math.round(v * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Categorical slot assignment (fixed order, never cycled)             */
/* ------------------------------------------------------------------ */

/** Approx hue anchor of each validated palette slot (blue, orange, aqua,
 *  yellow, magenta, green, violet, red). Order is the CVD-safety mechanism. */
const SLOT_HUES = [212, 17, 158, 41, 338, 120, 249, 0];

function hueOf(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return -1;
  const int = parseInt(m[1], 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 0.08) return -1; // too gray to carry a hue hint
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = Math.round(h * 60);
  return (h + 360) % 360;
}

function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Map each series to a palette slot (0-7). A provided hex color is a hint:
 * it snaps to the nearest free slot hue so charts always use validated,
 * mode-stepped colors. Unhinted series take the next free slot in order.
 */
function assignSlots(hints: (string | undefined)[]): number[] {
  const taken = new Set<number>();
  const out: number[] = hints.map(() => -1);
  hints.forEach((c, i) => {
    const h = c ? hueOf(c) : -1;
    if (h < 0) return;
    let best = -1;
    let bd = Infinity;
    for (let s = 0; s < 8; s++) {
      if (taken.has(s)) continue;
      const d = hueDist(h, SLOT_HUES[s]);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    if (best >= 0) {
      out[i] = best;
      taken.add(best);
    }
  });
  for (let i = 0; i < out.length; i++) {
    if (out[i] >= 0) continue;
    let free = -1;
    for (let s = 0; s < 8; s++) {
      if (!taken.has(s)) {
        free = s;
        break;
      }
    }
    out[i] = free >= 0 ? free : 7;
    if (free >= 0) taken.add(free);
  }
  return out;
}

function slotVar(slot: number): string {
  return `var(--c${slot + 1})`;
}

/* ------------------------------------------------------------------ */
/* Shared fragments                                                    */
/* ------------------------------------------------------------------ */

/**
 * Fit a label to a pixel budget or cut it with an ellipsis.
 *
 * Every escape the print-QA gate caught came from the same assumption: that a
 * label is short. The report writer supplies labels like "$4/mo subscription,
 * category median (15% monthly churn)", and SVG text neither wraps nor clips;
 * it just keeps going, out of the chart and off the page. Nothing may draw a
 * label without stating the space it is drawing into. Full text always
 * survives in the tooltip and the chart's data table.
 */
const AVG_CH = 7.4; // wider than the 6.9px/char the layouts assume: truncation must undershoot, never overshoot
function fitText(label: string, maxPx: number): string {
  const chars = Math.max(3, Math.floor(maxPx / AVG_CH));
  const t = String(label);
  return t.length <= chars ? t : t.slice(0, chars - 1).trimEnd() + '\u2026';
}

/** Anchor an x-axis tick so the outermost labels stay inside the frame. */
function tickAnchor(i: number, last: number): string {
  return i === 0 ? 'start' : i === last ? 'end' : 'middle';
}

function svgOpen(id: string, w: number, h: number, label: string): string {
  return `<svg id="${esc(id)}" class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escAttr(label)}" preserveAspectRatio="xMidYMid meet">`;
}

function hit(tag: string, cls: string, attrs: string, tt: string): string {
  const klass = cls ? `hit ${cls}` : 'hit';
  return `<${tag} class="${klass}" tabindex="0" data-tt="${escAttr(tt)}" aria-label="${escAttr(tt)}" ${attrs}><title>${esc(tt)}</title></${tag}>`;
}

function legendHtml(items: { name: string; slot: number; line?: boolean }[]): string {
  if (items.length < 2) return ''; // single series: the title names it, no legend box
  const chips = items
    .map(
      (it) =>
        `<span class="lg-item"><span class="${it.line ? 'lg-line' : 'lg-swatch'}" style="background:${slotVar(it.slot)}"></span>${esc(it.name)}</span>`,
    )
    .join('');
  return `<div class="chart-legend">${chips}</div>`;
}

function roundTopRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, Math.max(h, 0));
  const [X, Y, W, H, R] = [x, y, w, h, rr].map(n2);
  return `M${X},${Y + H} L${X},${Y + R} Q${X},${Y} ${X + R},${Y} L${X + W - R},${Y} Q${X + W},${Y} ${X + W},${Y + R} L${X + W},${Y + H} Z`;
}

function roundRightRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h / 2, Math.max(w, 0));
  const [X, Y, W, H, R] = [x, y, w, h, rr].map(n2);
  return `M${X},${Y} L${X + W - R},${Y} Q${X + W},${Y} ${X + W},${Y + R} L${X + W},${Y + H - R} Q${X + W},${Y + H} ${X + W - R},${Y + H} L${X},${Y + H} Z`;
}

function wrapLabel(label: string, max: number): string[] {
  if (label.length <= max) return [label];
  const words = label.split(' ');
  if (words.length === 1) return [label];
  let best = 0;
  let bd = Infinity;
  let acc = 0;
  for (let i = 0; i < words.length - 1; i++) {
    acc += words[i].length + 1;
    const d = Math.abs(acc - label.length / 2);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return [words.slice(0, best + 1).join(' '), words.slice(best + 1).join(' ')];
}

/* ------------------------------------------------------------------ */
/* BAR - single series renders horizontal, multi-series grouped columns */
/* ------------------------------------------------------------------ */

function barChart(spec: ChartSpec): string {
  const series = spec.series.slice(0, 8);
  if (!series.length || !series[0].points.length) return emptyChart(spec);
  return series.length === 1 ? hBarChart(spec) : groupedColumns(spec);
}

function hBarChart(spec: ChartSpec): string {
  const s = spec.series[0];
  const pts = s.points;
  const slot = assignSlots([s.color])[0];
  const W = 720;
  const maxLabel = Math.max(...pts.map((p) => p.label.length));
  const labelW = Math.round(Math.min(200, Math.max(96, maxLabel * 6.9 + 12)));
  const x0 = labelW + 12;
  const valueW = Math.max(78, ...pts.map((p) => fmtVal(p.value, tickUnit(spec.unit)).length * 9 + 16));
  const x1 = Math.max(x0 + 40, W - valueW);
  const rowH = 34;
  const top = 14;
  const plotBottom = top + pts.length * rowH;
  const H = plotBottom + 40;
  const NM = niceMax(Math.max(...pts.map((p) => Math.max(0, p.value)))) || 1;
  const sx = (v: number) => x0 + ((x1 - x0) * Math.max(0, Math.min(NM, v))) / NM;

  let out = svgOpen(spec.id, W, H, spec.title);
  // vertical gridlines + ticks (baseline at 0 uses the axis stroke)
  for (let i = 0; i <= 4; i++) {
    const tv = (NM * i) / 4;
    const tx = n2(sx(tv));
    out += `<line class="${i === 0 ? 'axis' : 'grid'}" x1="${tx}" y1="${top - 4}" x2="${tx}" y2="${plotBottom + 4}"/>`;
    out += `<text class="ax" x="${tx}" y="${plotBottom + 18}" text-anchor="middle">${esc(fmtVal(tv, tickUnit(spec.unit)))}</text>`;
  }
  pts.forEach((p, i) => {
    const y = top + i * rowH + (rowH - 20) / 2;
    const w = Math.max(0, sx(p.value) - x0);
    const tt = `${p.label}: ${fmtVal(p.value, spec.unit)}`;
    out += `<g class="grp">`;
    out += `<text class="cat" x="${labelW}" y="${n2(y + 14)}" text-anchor="end">${esc(fitText(p.label, labelW - 6))}</text>`;
    out += `<path class="mark" d="${roundRightRect(x0, y, w, 20, 4)}" fill="${slotVar(slot)}"/>`;
    out += `<text class="vl" x="${n2(x0 + w + 8)}" y="${n2(y + 14)}">${esc(fmtVal(p.value, tickUnit(spec.unit)))}</text>`;
    out += hit('rect', '', `x="0" y="${n2(top + i * rowH)}" width="${W}" height="${rowH}"`, tt);
    out += `</g>`;
  });
  const axl = spec.xLabel || (spec.unit ? unitName(spec.unit) : '');
  if (axl) out += `<text class="axl" x="${n2((x0 + x1) / 2)}" y="${H - 6}" text-anchor="middle">${esc(fitText(axl, x1 - x0))}</text>`;
  out += `</svg>`;
  return out;
}

function groupedColumns(spec: ChartSpec): string {
  const series = spec.series.slice(0, 8);
  const labels = series[0].points.map((p) => p.label);
  const slots = assignSlots(series.map((s) => s.color));
  const W = 720;
  const H = 300;
  const l = 64;
  const r = 14;
  const top = 22;
  const bottom = 52;
  const plotW = W - l - r;
  const plotH = H - top - bottom;
  const NM = niceMax(Math.max(...series.flatMap((s) => s.points.map((p) => Math.max(0, p.value))))) || 1;
  const sy = (v: number) => top + plotH - (plotH * v) / NM;
  const gw = plotW / labels.length;
  const nS = series.length;
  const colW = Math.min(22, Math.max(6, (gw * 0.66 - 2 * (nS - 1)) / nS));
  const groupW = nS * colW + 2 * (nS - 1);

  let out = svgOpen(spec.id, W, H, spec.title);
  for (let i = 0; i <= 4; i++) {
    const tv = (NM * i) / 4;
    const ty = n2(sy(tv));
    out += `<line class="${i === 0 ? 'axis' : 'grid'}" x1="${l - 6}" y1="${ty}" x2="${W - r}" y2="${ty}"/>`;
    out += `<text class="ax" x="${l - 12}" y="${ty + 4}" text-anchor="end">${esc(fmtVal(tv, tickUnit(spec.unit)))}</text>`;
  }
  labels.forEach((lab, gi) => {
    const gx = l + gi * gw + (gw - groupW) / 2;
    const ttLines = [lab, ...series.map((s) => `${s.name}: ${fmtVal(s.points[gi] ? s.points[gi].value : 0, spec.unit)}`)];
    out += `<g class="grp">`;
    series.forEach((s, si) => {
      const p = s.points[gi];
      if (!p) return;
      const x = gx + si * (colW + 2);
      const y = Math.max(top, Math.min(top + plotH, sy(p.value)));
      out += `<path class="mark" d="${roundTopRect(x, y, colW, Math.max(0, top + plotH - y), 4)}" fill="${slotVar(slots[si])}"/>`;
    });
    out += hit('rect', '', `x="${n2(l + gi * gw)}" y="${top - 8}" width="${n2(gw)}" height="${n2(plotH + 16)}"`, ttLines.join('\n'));
    const lines = wrapLabel(lab, 14);
    lines.slice(0, 2).forEach((ln, li) => {
      out += `<text class="ax" x="${n2(gx + groupW / 2)}" y="${n2(top + plotH + 16 + li * 13)}" text-anchor="middle">${esc(fitText(ln, Math.max(60, gw + 18)))}</text>`;
    });
    out += `</g>`;
  });
  const yl = spec.yLabel || (spec.unit ? unitName(spec.unit) : '');
  if (yl) out += `<text class="axl" x="4" y="12">${esc(fitText(yl, 220))}</text>`;
  out += `</svg>`;
  return legendHtml(series.map((s, i) => ({ name: s.name, slot: slots[i] }))) + out;
}

function unitName(u: string): string {
  return u === '₹' ? 'INR (₹)' : u === '%' ? 'Percent' : u === 'mo' ? 'Months' : u;
}

/* ------------------------------------------------------------------ */
/* LINE                                                                */
/* ------------------------------------------------------------------ */

function lineChart(spec: ChartSpec): string {
  const series = spec.series.slice(0, 8);
  if (!series.length || series[0].points.length < 2) return emptyChart(spec);
  const labels = series[0].points.map((p) => p.label);
  const slots = assignSlots(series.map((s) => s.color));
  const W = 720;
  const H = 300;
  const top = 22;
  const bottom = 44;
  const l = 60;
  const plotH = H - top - bottom;
  const dom = niceDomain(series.flatMap((s) => s.points.map((p) => p.value)));
  const span = dom.hi - dom.lo || 1;
  const sy = (v: number) => {
    const y = top + plotH - (plotH * (v - dom.lo)) / span;
    return Math.max(top, Math.min(top + plotH, y));   // never draw outside the frame
  };

  // decide whether direct end labels fit without colliding (else legend only)
  const endYs = series.map((s) => sy(s.points[s.points.length - 1].value)).sort((a, b) => a - b);
  let endLabels = series.length >= 2;
  for (let i = 1; i < endYs.length; i++) if (endYs[i] - endYs[i - 1] < 15) endLabels = false;
  const r = endLabels ? 128 : 20;
  const plotW = W - l - r;
  const sx = (i: number) => l + (plotW * i) / (labels.length - 1);

  let out = svgOpen(spec.id, W, H, spec.title);
  for (let i = 0; i <= 4; i++) {
    const tv = dom.lo + (span * i) / 4;
    const ty = n2(sy(tv));
    out += `<line class="${Math.abs(tv) < 1e-9 ? 'axis' : 'grid'}" x1="${l - 6}" y1="${ty}" x2="${W - r + 6}" y2="${ty}"/>`;
    out += `<text class="ax" x="${l - 12}" y="${ty + 4}" text-anchor="end">${esc(fmtVal(tv, tickUnit(spec.unit)))}</text>`;
  }
  // x tick labels, thinned to avoid collisions
  const step = Math.max(1, Math.ceil(labels.length / Math.floor(plotW / 62)));
  labels.forEach((lab, i) => {
    if (i % step !== 0 && i !== labels.length - 1) return;
    out += `<text class="ax" x="${n2(sx(i))}" y="${n2(top + plotH + 18)}" text-anchor="${tickAnchor(i, labels.length - 1)}">${esc(fitText(lab, 84))}</text>`;
  });
  // series paths
  series.forEach((s, si) => {
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${n2(sx(i))},${n2(sy(p.value))}`).join(' ');
    out += `<g class="grp"><path class="lmark" d="${d}" fill="none" stroke="${slotVar(slots[si])}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    s.points.forEach((p, i) => {
      const last = i === s.points.length - 1;
      out += `<circle cx="${n2(sx(i))}" cy="${n2(sy(p.value))}" r="${last ? 4.5 : 4}" fill="${slotVar(slots[si])}" stroke="var(--chart-surface)" stroke-width="2"/>`;
    });
    if (endLabels) {
      const ly = sy(s.points[s.points.length - 1].value);
      out += `<text class="endl" x="${n2(W - r + 14)}" y="${n2(ly + 1)}"><tspan class="cat">${esc(fitText(s.name, r - 20))}</tspan></text>`;
      out += `<text class="vl" x="${n2(W - r + 14)}" y="${n2(ly + 14)}">${esc(fmtVal(s.points[s.points.length - 1].value, tickUnit(spec.unit)))}</text>`;
    }
    out += `</g>`;
  });
  // hover bands: one tooltip listing every series at that x
  labels.forEach((lab, i) => {
    const bx = i === 0 ? l : sx(i) - (sx(1) - sx(0)) / 2;
    const bw = i === 0 || i === labels.length - 1 ? (sx(1) - sx(0)) / 2 : sx(1) - sx(0);
    const tt = [lab, ...series.map((s) => `${s.name}: ${fmtVal(s.points[i] ? s.points[i].value : 0, spec.unit)}`)].join('\n');
    out += hit('rect', 'band', `x="${n2(bx)}" y="${top - 8}" width="${n2(Math.max(bw, 24))}" height="${n2(plotH + 16)}"`, tt);
  });
  const yl = spec.yLabel || (spec.unit ? unitName(spec.unit) : '');
  if (yl) out += `<text class="axl" x="4" y="12">${esc(fitText(yl, 220))}</text>`;
  if (spec.xLabel) out += `<text class="axl" x="${n2(l + plotW / 2)}" y="${H - 4}" text-anchor="middle">${esc(fitText(spec.xLabel, plotW))}</text>`;
  out += `</svg>`;
  return legendHtml(series.map((s, i) => ({ name: s.name, slot: slots[i], line: true }))) + out;
}

/* ------------------------------------------------------------------ */
/* DONUT                                                               */
/* ------------------------------------------------------------------ */

function donutChart(spec: ChartSpec): string {
  const s = spec.series[0];
  if (!s || !s.points.length) return emptyChart(spec);
  // fold anything past 7 segments into "Other" (never cycle hues)
  let pts = s.points.slice();
  if (pts.length > 7) {
    const rest = pts.slice(6).reduce((a, p) => a + p.value, 0);
    pts = [...pts.slice(0, 6), { label: 'Other', value: rest }];
  }
  const total = pts.reduce((a, p) => a + Math.max(0, p.value), 0) || 1;
  const slots = assignSlots(pts.map(() => void 0));
  const size = 250;
  const cx = size / 2;
  const cy = size / 2;
  const R = 100;
  const r0 = 62;

  let segs = '';
  let a = -Math.PI / 2;
  pts.forEach((p, i) => {
    const frac = Math.max(0, p.value) / total;
    const a1 = a + Math.min(frac * Math.PI * 2, Math.PI * 2 - 1e-4);
    const large = a1 - a > Math.PI ? 1 : 0;
    const path = `M${n2(cx + R * Math.cos(a))},${n2(cy + R * Math.sin(a))} A${R},${R} 0 ${large} 1 ${n2(cx + R * Math.cos(a1))},${n2(cy + R * Math.sin(a1))} L${n2(cx + r0 * Math.cos(a1))},${n2(cy + r0 * Math.sin(a1))} A${r0},${r0} 0 ${large} 0 ${n2(cx + r0 * Math.cos(a))},${n2(cy + r0 * Math.sin(a))} Z`;
    const fill = p.label === 'Other' ? 'var(--fold)' : slotVar(slots[i]);
    const tt = `${p.label}: ${fmtVal(p.value, spec.unit)} (${trim1(frac * 100)}%)`;
    segs += `<g class="grp">` + hit('path', 'mark', `d="${path}" fill="${fill}" stroke="var(--chart-surface)" stroke-width="2"`, tt) + `</g>`;
    a = a1;
  });

  const legend = pts
    .map((p, i) => {
      const fill = p.label === 'Other' ? 'var(--fold)' : slotVar(slots[i]);
      return `<li><span class="lg-swatch" style="background:${fill}"></span><span class="dl-name">${esc(p.label)}</span><span class="dl-val">${esc(fmtVal(p.value, spec.unit))}</span><span class="dl-pct">${trim1((Math.max(0, p.value) / total) * 100)}%</span></li>`;
    })
    .join('');

  let out = `<div class="donut-wrap">`;
  out += svgOpen(spec.id, size, size, spec.title);
  out += segs;
  out += `<text class="ctr-v" x="${cx}" y="${cy}" text-anchor="middle">${esc(fmtVal(total, spec.unit))}</text>`;
  out += `<text class="ctr-l" x="${cx}" y="${cy + 18}" text-anchor="middle">TOTAL</text>`;
  out += `</svg>`;
  out += `<ul class="dlegend">${legend}</ul></div>`;
  return out;
}

/* ------------------------------------------------------------------ */
/* RADAR (0-10 axes)                                                   */
/* ------------------------------------------------------------------ */

function radarChart(spec: ChartSpec): string {
  const series = spec.series.slice(0, 8);
  if (!series.length || series[0].points.length < 3) return emptyChart(spec);
  const axes = series[0].points.map((p) => p.label);
  const slots = assignSlots(series.map((s) => s.color));
  const W = 720;
  const H = 320;
  const cx = W / 2;
  const cy = H / 2 + 4;
  const R = 112;
  const k = axes.length;
  const ang = (i: number) => -Math.PI / 2 + (i * Math.PI * 2) / k;
  const px = (i: number, v: number) => cx + ((R * v) / 10) * Math.cos(ang(i));
  const py = (i: number, v: number) => cy + ((R * v) / 10) * Math.sin(ang(i));

  let out = svgOpen(spec.id, W, H, spec.title);
  // rings + spokes
  for (const rv of [2, 4, 6, 8, 10]) {
    const ring = axes.map((_, i) => `${n2(px(i, rv))},${n2(py(i, rv))}`).join(' ');
    out += `<polygon class="grid" points="${ring}" fill="none"/>`;
  }
  axes.forEach((lab, i) => {
    out += `<line class="grid" x1="${cx}" y1="${cy}" x2="${n2(px(i, 10))}" y2="${n2(py(i, 10))}"/>`;
    const lx = cx + (R + 20) * Math.cos(ang(i));
    const ly = cy + (R + 20) * Math.sin(ang(i));
    const ca = Math.cos(ang(i));
    const anchor = ca > 0.35 ? 'start' : ca < -0.35 ? 'end' : 'middle';
    const dy = Math.sin(ang(i)) > 0.6 ? 10 : Math.sin(ang(i)) < -0.6 ? 0 : 4;
    // The frame is the budget: a spoke label may spend exactly the pixels
    // between its anchor and the nearer edge, halved when centre-anchored.
    const room = anchor === 'start' ? W - lx - 8 : anchor === 'end' ? lx - 8 : Math.min(lx, W - lx) * 2 - 16;
    out += `<text class="cat" x="${n2(lx)}" y="${n2(ly + dy)}" text-anchor="${anchor}">${esc(fitText(lab, room))}</text>`;
  });
  out += `<text class="ax" x="${n2(cx + 6)}" y="${n2(cy - (R * 5) / 10 - 3)}">5</text>`;
  out += `<text class="ax" x="${n2(cx + 6)}" y="${n2(cy - R - 3)}">10</text>`;
  // series polygons
  series.forEach((s, si) => {
    const poly = s.points.map((p, i) => `${n2(px(i, clamp10(p.value)))},${n2(py(i, clamp10(p.value)))}`).join(' ');
    out += `<g class="grp"><polygon class="lmark" points="${poly}" fill="${slotVar(slots[si])}" fill-opacity="0.1" stroke="${slotVar(slots[si])}" stroke-width="2" stroke-linejoin="round"/>`;
    s.points.forEach((p, i) => {
      const v = clamp10(p.value);
      out += hit('circle', '', `cx="${n2(px(i, v))}" cy="${n2(py(i, v))}" r="12" fill="transparent"`, `${axes[i]}\n${s.name}: ${trim1(v)}/10`);
      out += `<circle cx="${n2(px(i, v))}" cy="${n2(py(i, v))}" r="3.5" fill="${slotVar(slots[si])}" stroke="var(--chart-surface)" stroke-width="2"/>`;
    });
    out += `</g>`;
  });
  out += `<text class="axl" x="4" y="12">SCALE 0-10</text>`;
  out += `</svg>`;
  return legendHtml(series.map((s, i) => ({ name: s.name, slot: slots[i], line: true }))) + out;
}

function clamp10(v: number): number {
  return Math.max(0, Math.min(10, v));
}

/* ------------------------------------------------------------------ */
/* MATRIX - labeled 2D grid scatter (value = x 0-10, value2 = y 0-10)  */
/* ------------------------------------------------------------------ */

type Sev = 'crit' | 'serious' | 'warn' | 'good';

function severity(x: number, y: number): Sev {
  const score = x * y;
  return score >= 49 ? 'crit' : score >= 30 ? 'serious' : score >= 16 ? 'warn' : 'good';
}

const SEV_META: Record<Sev, { label: string; varName: string; ink: string }> = {
  crit: { label: 'Severe', varName: 'var(--st-crit)', ink: '#ffffff' },
  serious: { label: 'High', varName: 'var(--st-serious)', ink: '#10161f' },
  warn: { label: 'Moderate', varName: 'var(--st-warn)', ink: '#10161f' },
  good: { label: 'Low', varName: 'var(--st-good)', ink: '#ffffff' },
};

function matrixChart(spec: ChartSpec): string {
  const pts = spec.series.flatMap((s) => s.points).filter((p) => Number.isFinite(p.value) && Number.isFinite(p.value2 ?? NaN));
  if (!pts.length) return emptyChart(spec);
  const W = 720;
  const H = 420;
  const l = 64;
  const r = 20;
  const top = 26;
  const bottom = 54;
  const plotW = W - l - r;
  const plotH = H - top - bottom;
  const sx = (v: number) => l + (plotW * clamp10(v)) / 10;
  const sy = (v: number) => top + plotH - (plotH * clamp10(v)) / 10;
  const xl = spec.xLabel || 'Likelihood';
  const yl = spec.yLabel || 'Impact';

  let out = svgOpen(spec.id, W, H, spec.title);
  for (const g of [0, 2.5, 5, 7.5, 10]) {
    const cls = g === 5 ? 'axis' : 'grid';
    out += `<line class="${cls}" x1="${n2(sx(g))}" y1="${top}" x2="${n2(sx(g))}" y2="${n2(top + plotH)}"/>`;
    out += `<line class="${cls}" x1="${l}" y1="${n2(sy(g))}" x2="${n2(l + plotW)}" y2="${n2(sy(g))}"/>`;
  }
  for (const t of [0, 5, 10]) {
    out += `<text class="ax" x="${n2(sx(t))}" y="${n2(top + plotH + 18)}" text-anchor="middle">${t}</text>`;
    out += `<text class="ax" x="${l - 10}" y="${n2(sy(t) + 4)}" text-anchor="end">${t}</text>`;
  }
  // quadrant captions
  out += `<text class="quad" x="${n2(l + 10)}" y="${n2(top + 16)}">CONTINGENCY</text>`;
  out += `<text class="quad" x="${n2(l + plotW - 10)}" y="${n2(top + 16)}" text-anchor="end">ACT NOW</text>`;
  out += `<text class="quad" x="${n2(l + 10)}" y="${n2(top + plotH - 8)}">MONITOR</text>`;
  out += `<text class="quad" x="${n2(l + plotW - 10)}" y="${n2(top + plotH - 8)}" text-anchor="end">CONTAIN</text>`;
  // deterministic nudge for exact-duplicate coordinates
  const seen = new Map<string, number>();
  pts.forEach((p, i) => {
    const key = `${p.value}|${p.value2}`;
    const dup = seen.get(key) || 0;
    seen.set(key, dup + 1);
    const off = dup ? { x: 14 * dup * Math.cos(dup * 2.4), y: 14 * dup * Math.sin(dup * 2.4) } : { x: 0, y: 0 };
    const cxp = sx(p.value) + off.x;
    const cyp = sy(p.value2 ?? 0) + off.y;
    const sev = severity(clamp10(p.value), clamp10(p.value2 ?? 0));
    const meta = SEV_META[sev];
    const tt = `${i + 1}. ${p.label}\n${xl}: ${trim1(p.value)}/10\n${yl}: ${trim1(p.value2 ?? 0)}/10\nSeverity: ${meta.label}`;
    out += `<g class="grp"><circle class="mark" cx="${n2(cxp)}" cy="${n2(cyp)}" r="10" fill="${meta.varName}" stroke="var(--chart-surface)" stroke-width="2"/>`;
    out += `<text class="mx-num" x="${n2(cxp)}" y="${n2(cyp + 3.5)}" text-anchor="middle" fill="${meta.ink}">${i + 1}</text>`;
    out += hit('circle', '', `cx="${n2(cxp)}" cy="${n2(cyp)}" r="16" fill="transparent"`, tt);
    out += `</g>`;
  });
  /**
   * The scale suffix is appended here, so a writer who already wrote it into
   * the axis label produced "Impact (0-10) (0-10)", which then ran past the
   * frame. Say it once, and only if the label does not already say it.
   */
  const scaled = (t: string) => (/\(0\s*-\s*10\)/.test(t) ? t : `${t} (0-10)`);
  out += `<text class="axl" x="${n2(l + plotW / 2)}" y="${H - 8}" text-anchor="middle">${esc(fitText(scaled(xl), plotW))}</text>`;
  out += `<text class="axl" transform="translate(14,${n2(top + plotH / 2)}) rotate(-90)" text-anchor="middle">${esc(fitText(scaled(yl), plotH))}</text>`;
  out += `</svg>`;

  const sevLegend = (Object.keys(SEV_META) as Sev[])
    .map((k) => `<span class="lg-item"><span class="lg-dot" style="background:${SEV_META[k].varName}"></span>${SEV_META[k].label}</span>`)
    .join('');
  const list = pts
    .map((p, i) => {
      const meta = SEV_META[severity(clamp10(p.value), clamp10(p.value2 ?? 0))];
      return `<li><span class="mx-badge" style="background:${meta.varName};color:${meta.ink}">${i + 1}</span><span class="mx-t">${esc(p.label)}</span><span class="mx-c">${esc(xl.slice(0, 1))} ${trim1(p.value)} · ${esc(yl.slice(0, 1))} ${trim1(p.value2 ?? 0)}</span></li>`;
    })
    .join('');
  return `<div class="chart-legend">${sevLegend}</div>` + out + `<ol class="mx-list">${list}</ol>`;
}

/* ------------------------------------------------------------------ */
/* Dispatcher + data-table twin                                        */
/* ------------------------------------------------------------------ */

function emptyChart(spec: ChartSpec): string {
  return svgOpen(spec.id, 720, 80, spec.title) + `<text class="ax" x="360" y="44" text-anchor="middle">No data provided for this chart</text></svg>`;
}

/** Render one ChartSpec to an HTML fragment (legend + inline SVG + aux list). */
export function renderChart(spec: ChartSpec): string {
  switch (spec.kind) {
    case 'bar':
      return barChart(spec);
    case 'line':
      return lineChart(spec);
    case 'donut':
      return donutChart(spec);
    case 'radar':
      return radarChart(spec);
    case 'matrix':
      return matrixChart(spec);
    default:
      return emptyChart(spec);
  }
}

/**
 * The chart's table-view twin: collapsible on screen, forced visible in
 * print. This is the relief channel required for tooltip-only values and
 * for palette slots that sit under 3:1 on the white print surface.
 */
export function chartDataTable(spec: ChartSpec): string {
  let head: string[] = [];
  let rows: string[][] = [];
  if (spec.kind === 'donut') {
    const s = spec.series[0];
    const pts = s ? s.points : [];
    const total = pts.reduce((a, p) => a + Math.max(0, p.value), 0) || 1;
    head = ['Segment', 'Value', 'Share'];
    rows = pts.map((p) => [p.label, fmtVal(p.value, spec.unit), `${trim1((Math.max(0, p.value) / total) * 100)}%`]);
  } else if (spec.kind === 'matrix') {
    const pts = spec.series.flatMap((s) => s.points);
    head = ['#', 'Item', spec.xLabel || 'X', spec.yLabel || 'Y'];
    rows = pts.map((p, i) => [String(i + 1), p.label, trim1(p.value), trim1(p.value2 ?? 0)]);
  } else {
    const series = spec.series.slice(0, 8);
    if (!series.length) return '';
    head = [spec.xLabel || 'Category', ...series.map((s) => s.name)];
    const labels = series[0].points.map((p) => p.label);
    rows = labels.map((lab, i) => [lab, ...series.map((s) => (s.points[i] ? fmtVal(s.points[i].value, spec.unit) : ''))]);
  }
  const thead = head.map((h) => `<th>${esc(h)}</th>`).join('');
  const tbody = rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? 'num' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('');
  return (
    `<div class="cdata" data-collapsible>` +
    `<button type="button" class="ctog" aria-expanded="false">DATA TABLE</button>` +
    `<div class="cbody"><table class="dtable"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>` +
    `</div>`
  );
}
