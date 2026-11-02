/**
 * DEBATE report renderer.
 * renderReport(data) -> one self-contained HTML document string.
 *
 * Zero runtime deps: all CSS + JS inline, charts are inline SVG from
 * charts.ts. Fonts (Rajdhani + JetBrains Mono) are self-hosted and inlined
 * by fonts.ts with system fallbacks: the report makes no external request.
 *
 * Screen: the app's boardroom look (graphite, brass accent; the --cyan variable now holds brass).
 * Print: clean light professional theme via @media print, with page-break
 * rules and every collapsible forced open.
 */

import type {
  ChartSpec,
  DecisionTrail,
  Dissent,
  ReportData,
  ReportPanelist,
  Risk,
  RoadmapPhase,
  TableSpec,
} from '../../../shared/report-types.ts';
import { chartDataTable, esc, renderChart } from './charts.ts';
import { inlineFontCss } from './fonts.ts';
import { REPORT_CSP } from './csp.ts';

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

function fmtDuration(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return '0m';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function paras(text: string, cls = ''): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p${cls ? ` class="${cls}"` : ''}>${esc(p)}</p>`)
    .join('');
}

/** Section ids, nav labels and full headings, in render order. */
const SECTIONS = [
  { id: 'recommendation', nav: 'Recommendation', h: 'Key Recommendation' },
  { id: 'summary', nav: 'Summary', h: 'Executive Summary' },
  { id: 'stakes', nav: 'Stakes', h: 'What Was at Stake' },
  { id: 'stats', nav: 'Stats', h: 'Mission Stats' },
  { id: 'panel', nav: 'Panel', h: 'The Panel' },
  { id: 'decisions', nav: 'Decisions', h: 'Decision Trails' },
  { id: 'minds', nav: 'Minds', h: 'How Minds Changed' },
  { id: 'audit', nav: 'Audit', h: 'Numbers Audit' },
  { id: 'persona', nav: 'Anecdotes', h: 'Panel Anecdotes, Not Evidence' },
  { id: 'analysis', nav: 'Analysis', h: 'Analysis' },
  { id: 'dissents', nav: 'Dissents', h: 'Dissenting Opinions' },
  { id: 'risks', nav: 'Risks', h: 'Risk Register' },
  { id: 'roadmap', nav: 'Roadmap', h: 'Roadmap' },
  { id: 'open-questions', nav: 'Open Qs', h: 'Open Questions' },
  { id: 'moderator', nav: 'Moderator', h: "Moderator's Note" },
  { id: 'sources', nav: 'Sources', h: 'Sources' },
] as const;

/**
 * Which sections this particular report actually has, in order. Set once per
 * render. Section numbers are derived from it rather than hardcoded, because a
 * report without an uploaded dossier has no audit section and a document that
 * jumps from 05 to 07 looks like a printing error.
 */
let ACTIVE: readonly string[] = SECTIONS.map((s) => s.id);

/**
 * Every array in ReportData comes from a model, and a model that omits one
 * field must not cost the founder the whole document. The stress corpus proved
 * this the hard way: one roadmap phase without `actions` threw inside
 * renderReport, which meant no HTML, no PDF, and a finished session with
 * nothing to hand over. Missing becomes empty here, and the section simply
 * renders with less in it.
 */
const arr = <T,>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);

function secHead(id: string, heading: string): string {
  const i = ACTIVE.indexOf(id);
  const num = String((i < 0 ? ACTIVE.length : i) + 1).padStart(2, '0');
  return `<div class="sec-head"><span class="sec-num">${num}</span><h2>${heading}</h2><span class="sec-rule"></span></div>`;
}

/* ------------------------------------------------------------------ */
/* Section builders                                                    */
/* ------------------------------------------------------------------ */

function heroSection(data: ReportData): string {
  return `<section class="sec" id="recommendation" data-sec>
  ${secHead('recommendation', 'Key Recommendation')}
  <div class="hero">
    <div class="hero-tag">THE CALL</div>
    <p class="hero-text">${esc(data.keyRecommendation)}</p>
  </div>
  <div class="brief">
    <div class="brief-goal"><span class="brief-label">MISSION GOAL</span><p>${esc(data.goal)}</p></div>
    <blockquote class="brief-topic"><span class="brief-label">ORIGINAL BRIEF</span>${paras(data.topic)}</blockquote>
  </div>
</section>`;
}

function summarySection(data: ReportData): string {
  return `<section class="sec" id="summary" data-sec>
  ${secHead('summary', 'Executive Summary')}
  <div class="prose">${arr(data.executiveSummary).map((p) => `<p>${esc(p)}</p>`).join('')}</div>
</section>`;
}

function statsSection(data: ReportData): string {
  const s = data.stats;
  const tiles: [string, string][] = [
    ['Messages', s.messages.toLocaleString('en-IN')],
    ['Interjections', s.interjections.toLocaleString('en-IN')],
    ['Research tasks', s.researchTasks.toLocaleString('en-IN')],
    ['Plan revisions', s.planRevisions.toLocaleString('en-IN')],
    ['User decisions', s.userDecisions.toLocaleString('en-IN')],
    ['Assumptions', s.assumptions.toLocaleString('en-IN')],
    ['Duration', fmtDuration(s.durationMin)],
  ];
  const cells = tiles
    .map(([label, value]) => `<div class="stat"><div class="stat-v">${esc(value)}</div><div class="stat-l">${esc(label)}</div></div>`)
    .join('');
  return `<section class="sec" id="stats" data-sec>
  ${secHead('stats', 'Mission Stats')}
  <div class="stat-grid">${cells}</div>
</section>`;
}

function panelSection(data: ReportData): string {
  const cards = data.panel
    .map(
      (p: ReportPanelist) => `<div class="panel-card" style="--accent:${esc(p.color)}">
      <div class="pc-glow"></div>
      <div class="pc-name">${esc(p.name)}</div>
      <div class="pc-role">${esc(p.role)}</div>
      <div class="pc-id">ID / ${esc(p.id)}</div>
    </div>`,
    )
    .join('');
  return `<section class="sec" id="panel" data-sec>
  ${secHead('panel', 'The Panel')}
  <div class="panel-grid">${cards}</div>
</section>`;
}

function argList(title: string, cls: string, items: { who: string; text: string }[]): string {
  const lis = items.length
    ? items.map((a) => `<li><span class="arg-who">${esc(a.who)}</span><span class="arg-text">${esc(a.text)}</span></li>`).join('')
    : '<li class="arg-none">No entries recorded</li>';
  return `<div class="args ${cls}"><div class="args-h">${title}</div><ul>${lis}</ul></div>`;
}

function decisionDossier(d: DecisionTrail, i: number, open: boolean): string {
  // A dependency the server traced to a panelist's backstory (P1) is marked as the assumption it is.
  const chips = arr(d.dependsOn).map((c) => `<span class="dep-chip${/^Assumption, not evidence/.test(c) ? ' dep-assumed' : ''}">${esc(c)}</span>`).join('');
  const user = d.userInput
    ? `<div class="founder-box"><div class="fb-label">FOUNDER INPUT</div><p>${esc(d.userInput)}</p></div>`
    : '';
  return `<article class="dossier${open ? ' open' : ''}" data-collapsible>
  <button type="button" class="ctog dossier-head" aria-expanded="${open ? 'true' : 'false'}">
    <span class="d-idx">${String(i + 1).padStart(2, '0')}</span>
    <span class="d-topic">${esc(d.topic)}</span>
    <span class="d-conc">${esc(d.conclusion)}</span>
    <span class="chev" aria-hidden="true"></span>
  </button>
  <div class="cbody dossier-body">
    <div class="d-meta">PROPOSED BY <strong>${esc(d.proposedBy)}</strong></div>
    <div class="args-grid">
      ${argList('SUPPORTED', 'sup', arr(d.supportedBy).map((s) => ({ who: s.expert, text: s.argument })))}
      ${argList('CHALLENGED', 'chal', arr(d.challengedBy).map((c) => ({ who: c.expert, text: c.objection })))}
    </div>
    <div class="resolution"><div class="res-label">RESOLUTION</div><p>${esc(d.resolution)}</p></div>
    ${d.dependsOn.length ? `<div class="deps"><span class="deps-label">DEPENDS ON</span>${chips}</div>` : ''}
    ${user}
  </div>
</article>`;
}

function decisionsSection(data: ReportData): string {
  const items = arr(data.decisions).map((d, i) => decisionDossier(d, i, i === 0)).join('');
  return `<section class="sec" id="decisions" data-sec>
  ${secHead('decisions', 'Decision Trails')}
  <div class="dossiers">${items}</div>
</section>`;
}

function chartFigure(c: ChartSpec): string {
  return `<figure class="viz" id="fig-${esc(c.id)}">
  <figcaption class="viz-head"><h3>${esc(c.title)}</h3></figcaption>
  <div class="viz-body">${renderChart(c)}</div>
  <p class="insight"><span class="ins-mark">&#9656;</span>${esc(c.insight)}</p>
  ${chartDataTable(c)}
</figure>`;
}

function tableCard(t: TableSpec): string {
  const thead = arr(t.columns).map((c) => `<th>${esc(c)}</th>`).join('');
  const tbody = arr(t.rows).map((r) => `<tr>${arr(r).map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
  return `<div class="tcard" id="tbl-${esc(t.id)}">
  <div class="viz-head"><h3>${esc(t.title)}</h3></div>
  <div class="tscroll" tabindex="0" role="region" aria-label="${esc(t.title)}"><table class="dtable big"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>
  ${t.note ? `<p class="tnote">${esc(t.note)}</p>` : ''}
</div>`;
}

function analysisSection(data: ReportData): string {
  const charts = data.charts.filter((c) => c.id !== 'risk-matrix');
  const tables = data.tables;
  const items: string[] = [];
  const per = tables.length ? Math.max(1, Math.ceil(charts.length / (tables.length + 1))) : charts.length + 1;
  let t = 0;
  charts.forEach((c, i) => {
    items.push(chartFigure(c));
    if ((i + 1) % per === 0 && t < tables.length) items.push(tableCard(tables[t++]));
  });
  while (t < tables.length) items.push(tableCard(tables[t++]));
  return `<section class="sec" id="analysis" data-sec>
  ${secHead('analysis', 'Analysis')}
  <div class="viz-grid">${items.join('')}</div>
</section>`;
}

/**
 * The audit. Printed near the front, before the analysis, because a reader who
 * finds out on page nine that a headline figure was wrong has already built an
 * argument on it. A clean audit is stated just as plainly as a dirty one: the
 * value of this page is that the founder knows which it was.
 */
/**
 * The cover. A document someone forwards to a colleague has to say what it is
 * before it says anything else: the question, who decided it, when, and the
 * one call. Screen-only readers skip straight past it; in print it is page one
 * and the report stops looking like a web page that was printed.
 */
function coverPage(data: ReportData): string {
  const when = new Date(data.generatedAtIso).toLocaleString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  const experts = data.panel.filter((p) => p.id !== 'marcus');
  return `<section class="cover" data-print-only>
  <div class="cv-top">
    <div class="cv-brand">THE DEBATE APP</div>
    <div class="cv-kind">Expert panel engagement</div>
  </div>
  <div class="cv-mid">
    <h1 class="cv-title">${esc(data.title)}</h1>
    <p class="cv-sub">${esc(data.subtitle)}</p>
    <div class="cv-call">
      <div class="cv-call-label">The call</div>
      <p>${esc(data.keyRecommendation)}</p>
    </div>
  </div>
  <div class="cv-foot">
    <div class="cv-meta">
      <span class="cv-k">Prepared for</span><span class="cv-v">${esc(data.preparedFor || 'the founder')}</span>
      <span class="cv-k">Date</span><span class="cv-v">${esc(when)}</span>
      <span class="cv-k">Panel</span><span class="cv-v">${experts.length} experts, chaired by Marcus Hale</span>
      <span class="cv-k">Session</span><span class="cv-v">${data.stats.messages} contributions over ${data.stats.durationMin} minutes</span>
    </div>
    <p class="cv-note">
      Every conclusion in this document carries the argument that produced it: who proposed it, who fought it, and what
      settled it. Dissents are recorded rather than resolved away.
    </p>
  </div>
</section>`;
}

/** Contents. Numbered to match the section headings, print-only. */
function tocPage(sections: readonly { id: string; nav: string; h: string }[]): string {
  const rows = sections
    .map((sec, i) => `<li><span class="toc-n">${String(i + 1).padStart(2, '0')}</span><span class="toc-t">${esc(sec.h)}</span></li>`)
    .join('');
  return `<section class="toc" data-print-only>
  <h2 class="toc-h">Contents</h2>
  <ol class="toc-list">${rows}</ol>
</section>`;
}

function auditSection(data: ReportData): string {
  const a = data.numbersAudit!;
  /**
   * The checker crashed. This renders as a warning the reader cannot miss,
   * never as an absent section: a report whose figures were verified and one
   * whose verifier died must not look alike on paper.
   */
  if (a.failed) {
    return `<section class="sec" id="audit" data-sec>
  ${secHead('audit', 'Numbers Audit')}
  <div class="audit-lead flagged">
    <div class="al-stat"><span class="al-n">0</span><span class="al-l">figures independently verified</span></div>
    <p class="al-sum"><strong>The numbers audit failed and could not be completed.</strong> ${esc(a.summary)}</p>
  </div>
  <p class="au-note">Every figure in this document is the panel's own claim, printed unchecked. Before acting on any number here, recompute it from the source files.</p>
</section>`;
  }
  const wrong = a.findings.filter((f) => f.verdict === 'wrong');
  const rows = a.findings
    .map(
      (f) => `<tr class="au-${f.verdict}">
      <td class="au-v">${esc(f.verdict)}</td>
      <td class="au-fig">${esc(f.figure)}</td>
      <td class="au-re">${esc(f.recomputed)}</td>
      <td class="au-im">${f.origin === 'persona' ? '<span class="assumed-tag">assumption</span> ' : ''}${esc(f.impact)}</td>
    </tr>`,
    )
    .join('');
  return `<section class="sec" id="audit" data-sec>
  ${secHead('audit', 'Numbers Audit')}
  <div class="audit-lead ${wrong.length ? 'flagged' : 'clean'}">
    <div class="al-stat"><span class="al-n">${a.checked}</span><span class="al-l">figures and steps checked</span></div>
    <div class="al-stat"><span class="al-n">${wrong.length}</span><span class="al-l">found wrong</span></div>
    <p class="al-sum">${esc(a.summary)}</p>
  </div>
  <p class="au-note">Every figure the panel committed to was recomputed directly from the source files after the session closed, and every claim the panel derived from one was re-derived: a figure can be arithmetically consistent and still reach the wrong conclusion through a wrong step. Where the recomputed value differs, it is the recomputed value that is correct.</p>
  ${rows ? `<table class="audit-table"><colgroup><col class="c-v"><col class="c-f"><col class="c-r"><col class="c-i"></colgroup><thead><tr><th>Verdict</th><th>As the panel stated it</th><th>Recomputed</th><th>What it changes</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
</section>`;
}

/**
 * What panelists told from their own invented careers (P1, server-written from
 * the claims graded persona). Printed so the reader can see what coloured the
 * argument, and labelled so nobody mistakes it for a finding.
 */
function personaSection(data: ReportData): string {
  const rows = arr(data.personaClaims).map((c) => `<tr>
      <th scope="row">${esc(c.expert)}</th>
      <td>${esc(c.claim)}${arr(c.figures).length ? ' <span class="assumed-tag">figures are assumptions</span>' : ''}</td>
    </tr>`).join('');
  return `<section class="sec" id="persona" data-sec>
  ${secHead('persona', 'Panel Anecdotes, Not Evidence')}
  <p class="sec-sub">The panelists are illustrative characters. These are things they said about their own shops, staff or careers. They show how a thing might go; they are not evidence about your business, and any figure in them is an assumption. Where a decision trail or the numbers audit leans on one, it says so.</p>
  <table class="dtable persona-table"><tbody>${rows}</tbody></table>
</section>`;
}

/** What was at stake (server-written). Every line the founder did not state says so. */
function stakesSection(data: ReportData): string {
  const rows = arr(data.stakes).map((l) => `<tr${l.assumed ? ' class="assumed"' : ''}>
      <th scope="row">${esc(l.label)}</th>
      <td>${esc(l.value)}${l.assumed ? ' <span class="assumed-tag">assumed</span>' : ''}</td>
    </tr>`).join('');
  const anyAssumed = arr(data.stakes).some((l) => l.assumed);
  return `<section class="sec" id="stakes" data-sec>
  ${secHead('stakes', 'What Was at Stake')}
  ${anyAssumed ? '<p class="sec-sub">Lines marked assumed were not stated by the decision owner; the panel argued from a stated, cautious assumption, never an invented figure.</p>' : ''}
  <table class="dtable stakes-table"><tbody>${rows}</tbody></table>
</section>`;
}

/** How minds changed (server-written from each expert's own stance record). */
function mindsSection(data: ReportData): string {
  const blocks = arr(data.mindChanges).map((m) => {
    const caused = m.concessions ? `${Math.round(m.causedShare * 100)}% of ${m.concessions} move${m.concessions === 1 ? '' : 's'} had a recorded cause` : 'Nobody moved';
    return `<article class="minds">
      <div class="minds-head"><span class="minds-motion">${esc(m.motionTitle)}</span><span class="minds-caused">${esc(caused)}</span></div>
      <ul class="minds-lines">${arr(m.lines).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    </article>`;
  }).join('');
  return `<section class="sec" id="minds" data-sec>
  ${secHead('minds', 'How Minds Changed')}
  <p class="sec-sub">From each expert&#39;s own private stance record, kept turn by turn. A move with no recorded cause is shown as one.</p>
  <div class="minds-list">${blocks}</div>
</section>`;
}

function dissentsSection(data: ReportData): string {
  // The server's dissent record, with tripwires, replaces the writer's list when it exists.
  if (data.minority) {
    const cards = arr(data.minority).length
      ? arr(data.minority).map((d) => `<article class="dissent">
      <div class="dis-label">DISSENT ON RECORD · ${esc(d.motionTitle)}</div>
      <div class="dis-who">${esc(d.expert)}</div>
      <p class="dis-pos">${esc(d.position)}</p>
      <p class="dis-why">${esc(d.reasoning)}</p>
      ${d.tripwire ? `<p class="dis-trip"><span class="dis-k">PROVES THEM RIGHT</span> ${esc(d.tripwire.signal)}${d.tripwire.by && !d.tripwire.signal.toLowerCase().includes(`by ${d.tripwire.by.trim().toLowerCase()}`) ? ` <span class="dis-by">by ${esc(d.tripwire.by)}</span>` : ''}</p>` : ''}
      ${d.costOfIgnoring ? `<p class="dis-cost"><span class="dis-k">COST OF IGNORING</span> ${esc(d.costOfIgnoring)}</p>` : ''}
      ${arr(d.incomplete).length ? `<p class="dis-incomplete">Incomplete: ${esc(arr(d.incomplete).join('; '))}.</p>` : ''}
    </article>`).join('')
      : '<p class="muted">No dissents were recorded. Marcus notes that unanimous panels deserve suspicion.</p>';
    return `<section class="sec" id="dissents" data-sec>
  ${secHead('dissents', 'Dissenting Opinions')}
  <p class="sec-sub">Every standing dissent, with what would prove the dissenter right and by when. Watch for these.</p>
  <div class="dissent-list">${cards}</div>
</section>`;
  }
  const cards = arr(data.dissents).length
    ? data.dissents
        .map(
          (d: Dissent) => `<article class="dissent">
      <div class="dis-label">DISSENT ON RECORD</div>
      <div class="dis-who">${esc(d.expert)}</div>
      <p class="dis-pos">${esc(d.position)}</p>
      <p class="dis-why">${esc(d.reasoning)}</p>
    </article>`,
        )
        .join('')
    : '<p class="muted">No dissents were recorded. Marcus notes that unanimous panels deserve suspicion.</p>';
  return `<section class="sec" id="dissents" data-sec>
  ${secHead('dissents', 'Dissenting Opinions')}
  <div class="dissent-list">${cards}</div>
</section>`;
}

function levelChip(level: Risk['likelihood']): string {
  const cls = level === 'high' ? 'lv-high' : level === 'medium' ? 'lv-med' : 'lv-low';
  return `<span class="lv ${cls}"><span class="lv-dot"></span>${esc(level.toUpperCase())}</span>`;
}

function risksSection(data: ReportData): string {
  const rows = data.risks
    .map(
      (r: Risk, i: number) => `<tr>
      <td class="num rk-i">${i + 1}</td>
      <td class="rk-t">${esc(r.title)}</td>
      <td>${levelChip(r.likelihood)}</td>
      <td>${levelChip(r.impact)}</td>
      <td class="rk-m">${esc(r.mitigation)}</td>
      <td class="rk-o">${esc(r.owner || 'Unassigned')}</td>
    </tr>`,
    )
    .join('');
  const matrix = data.charts.find((c) => c.id === 'risk-matrix');
  return `<section class="sec" id="risks" data-sec>
  ${secHead('risks', 'Risk Register')}
  <div class="tscroll" tabindex="0" role="region" aria-label="Risk register"><table class="dtable big risk-table">
    <thead><tr><th>#</th><th>Risk</th><th>Likelihood</th><th>Impact</th><th>Mitigation</th><th>Owner</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  ${matrix ? `<div class="viz-grid one">${chartFigure(matrix)}</div>` : ''}
</section>`;
}

function roadmapSection(data: ReportData): string {
  const phases = data.roadmap
    .map(
      (p: RoadmapPhase) => `<div class="phase">
      <div class="ph-node" aria-hidden="true"></div>
      <div class="ph-card">
        <div class="ph-top"><span class="ph-name">${esc(p.phase)}</span><span class="ph-time">${esc(p.timeframe)}</span></div>
        <ul class="ph-actions">${arr(p.actions).map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
        <div class="ph-meta">
          ${p.owner ? `<span><span class="ph-k">OWNER</span> ${esc(p.owner)}</span>` : ''}
          ${p.dependencies ? `<span><span class="ph-k">DEPENDS</span> ${esc(p.dependencies)}</span>` : ''}
        </div>
      </div>
    </div>`,
    )
    .join('');
  return `<section class="sec" id="roadmap" data-sec>
  ${secHead('roadmap', 'Roadmap')}
  <div class="timeline">${phases}</div>
</section>`;
}

function openQuestionsSection(data: ReportData): string {
  const items = arr(data.openQuestions).length
    ? arr(data.openQuestions).map((q, i) => `<li><span class="oq-n">${String(i + 1).padStart(2, '0')}</span><p>${esc(q)}</p></li>`).join('')
    : '<li><p class="muted">Nothing left on the owner&#39;s desk.</p></li>';
  return `<section class="sec" id="open-questions" data-sec>
  ${secHead('open-questions', 'Open Questions')}
  <p class="sec-sub">Only the owner can resolve these. The panel&#39;s lean is noted where it had one.</p>
  <ol class="oq-list">${items}</ol>
</section>`;
}

/** How each source was attested, in the reader's words. */
const PROVENANCE: Record<string, string> = {
  fetched: 'page read by the research tool',
  search_result: 'returned by the web search tool',
  model_reported: 'reported by the model, not attested by the tool',
};

/** Only http(s) links are rendered as links; anything else is shown as text. */
function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The research desk's sources, as the tools returned them (server-written,
 * never by the report writer). Every one carries its provenance: a source the
 * model reported without a tool attesting it says so on the page.
 */
function sourcesSection(data: ReportData): string {
  const items = arr(data.sources).map((c) => {
    const href = safeHref(c.url);
    const title = esc(c.title || c.url);
    const meta = [c.publisher, c.publishedAt].filter(Boolean).map((x) => esc(String(x))).join(' · ');
    return `<li class="src${c.provenance === 'model_reported' ? ' unattested' : ''}">
      <span class="src-id">${esc(c.id)}</span>
      <div class="src-body">
        <p class="src-title">${href ? `<a href="${esc(href)}" rel="noopener noreferrer" target="_blank">${title}</a>` : title}</p>
        ${meta ? `<p class="src-meta">${meta}</p>` : ''}
        ${c.quote ? `<blockquote class="src-quote">${esc(c.quote)}</blockquote>` : ''}
        <p class="src-prov">${esc(PROVENANCE[c.provenance] ?? c.provenance)}</p>
        <p class="src-url">${esc(c.url)}</p>
      </div>
    </li>`;
  }).join('');
  return `<section class="sec" id="sources" data-sec>
  ${secHead('sources', 'Sources')}
  <p class="sec-sub">What the research desk cited, with how each source was attested. Ids like [c_ab12cd34] in the text point here.</p>
  <ol class="src-list">${items}</ol>
</section>`;
}

function moderatorSection(data: ReportData): string {
  return `<section class="sec" id="moderator" data-sec>
  ${secHead('moderator', "Moderator's Note")}
  <div class="memo">
    <div class="memo-head"><span>FROM THE MODERATOR</span><span class="memo-date">${esc(fmtDate(data.generatedAtIso))}</span></div>
    <div class="memo-body">${paras(data.moderatorNote)}</div>
    <div class="memo-sign"><div class="sig">Marcus</div><div class="sig-role">Moderator, devil&#39;s advocate</div></div>
  </div>
</section>`;
}

/* ------------------------------------------------------------------ */
/* CSS                                                                 */
/* ------------------------------------------------------------------ */


/**
 * The print stylesheet, emitted as its OWN style tag with media="print"
 * rather than an inline @media block. Chrome applies it identically when
 * printing; the difference is that the QA probe can flip that media attribute
 * to "all" at runtime and measure the PRINT layout in a live DOM: real boxes,
 * real overlaps, real overflow, before any PDF exists. An inline @media block
 * cannot be switched on from script, which made the print layout the one
 * thing nobody could inspect programmatically.
 */
function printCss(): string {
  return `@page {
  size: A4;
  margin: 16mm 14mm 18mm;
}

.cover, .toc { display: flex; }

  .cover {
    flex-direction: column; justify-content: space-between;
    min-height: 243mm; padding: 0;
  }
  .cv-top { display: flex; justify-content: space-between; align-items: baseline;
    border-bottom: 2px solid #101418; padding-bottom: 8px; }
  .cv-brand { font-family: var(--mono); font-size: 10px; letter-spacing: .3em; color: #101418; }
  .cv-kind { font-family: var(--mono); font-size: 9.5px; letter-spacing: .18em; color: #5b6672; text-transform: uppercase; }

  .cv-mid { margin-top: 38mm; }
  .cv-title { font-family: var(--disp); font-weight: 700; font-size: 40px; line-height: 1.08;
    letter-spacing: .01em; color: #101418; margin: 0; }
  .cv-sub { font-size: 14px; line-height: 1.6; color: #333c46; margin: 12px 0 0; max-width: 130mm; }
  .cv-call { margin-top: 16mm; border-left: 3px solid #7a5810; padding: 2px 0 2px 14px; }
  .cv-call-label { font-family: var(--mono); font-size: 9px; letter-spacing: .24em;
    text-transform: uppercase; color: #7a5810; margin-bottom: 6px; }
  .cv-call p { font-family: var(--disp); font-weight: 600; font-size: 17px; line-height: 1.45;
    color: #101418; margin: 0; }

  .cv-foot { border-top: 1px solid #c9d2da; padding-top: 10px; }
  .cv-meta { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; font-size: 11.5px; }
  .cv-k { font-family: var(--mono); font-size: 9px; letter-spacing: .16em; text-transform: uppercase; color: #5b6672; }
  .cv-v { color: #101418; }
  .cv-note { font-size: 10.5px; line-height: 1.6; color: #5b6672; margin: 10px 0 0; max-width: 150mm; }

  .toc { flex-direction: column; }
  .toc-h { font-family: var(--disp); font-weight: 700; font-size: 26px; color: #101418;
    border-bottom: 2px solid #101418; padding-bottom: 8px; margin: 0 0 14px; }
  .toc-list { list-style: none; margin: 0; padding: 0; }
  .toc-list li { display: flex; align-items: baseline; gap: 14px;
    padding: 9px 0; border-bottom: 1px solid #e4e7eb; }
  .toc-n { font-family: var(--mono); font-size: 11px; color: #7a5810; letter-spacing: .1em; }
  .toc-t { font-family: var(--disp); font-weight: 600; font-size: 14.5px; color: #101418; }

:root {
    --bg0: #ffffff; --bg1: #ffffff; --chart-surface: #ffffff;
    --ink-1: #101418; --ink-2: #333c46; --ink-mut: #5b6672;
    --grid: #e4e7eb; --axisc: #c3cad2;
    --hair: #c9d2da; --hair2: #dde2e8;
    --cyan: #7a5810; --cyan-soft: #faf4e4;
    --amber: #8a6510; --amber-soft: #faf4e4;
    --hover-wash: transparent; --fold: #8a97a5;
    --c1: #2a78d6; --c2: #eb6834; --c3: #1baf7a; --c4: #eda100;
    --c5: #e87ba4; --c6: #008300; --c7: #4a3aa7; --c8: #e34948;
  }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { background: #ffffff; color: var(--ink-2); font-size: 12px; }
  body::before { display: none; }
  /* The cover is the title page in print, so the screen header would be a
     second one printed over the top of it. It also stole enough vertical space
     to push the cover's footer onto a near-blank second sheet. */
  header.hud, .hud-row2, .controls, .nav { display: none; }
  .badge { color: #333c46; border-color: #c3cad2; }
  .badge.amber { color: #8a6510; }
  /* The sheet is the constraint now, not 1100px, and nothing may exceed it. */
  main { padding: 0; max-width: 100%; width: 100%; }
  html, body { width: 100%; margin: 0; padding: 0; }

  /* Explicit tracks: auto-fit sized itself against the old screen width. */
  .stat-grid { grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .panel-grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .viz-grid, .viz-grid.one { grid-template-columns: 1fr; }
  .brief, .args-grid { grid-template-columns: 1fr 1fr; }
  table { width: 100%; table-layout: fixed; }
  td, th { overflow-wrap: anywhere; }

  /* Every numbered section opens a fresh page, the way a real report reads. */
  .sec { margin-bottom: 0; break-before: page; padding-top: 2mm; }
  .sec:first-of-type { break-before: auto; }
  .cover, .toc { break-after: page; }
  h1, h2, h3 { break-after: avoid; }
  p, li { orphans: 3; widows: 3; }
  .sec { margin-bottom: 34px; }
  .sec-head h2 { font-size: 19px; color: #101418; }
  .hero, .brief-goal, .brief-topic, .stat, .panel-card, .dossier, .viz, .tcard, .dissent, .ph-card, .memo { background: #ffffff; break-inside: avoid; }
  .sec-head, .viz-head { break-after: avoid; }
  .hero::before, .hero::after { border-color: #101418; }
  .hero-text { color: #101418; font-size: 19px; }
  .pc-glow { display: none; }
  [data-collapsible] > .cbody { display: block !important; }
  .chev { display: none; }
  .cdata .ctog::before { content: ''; }
  .cdata .ctog { color: #5b6672; pointer-events: none; }
  .dossier-head { cursor: default; }
  .resolution { background: #faf4e4; }
  .founder-box { background: #faf4e4; }
  .dissent { background: #fdf3ee; border-color: #e6b8a4; }
  .minds { background: #ffffff; }
  .lv-high { color: #a02c2c; } .lv-med { color: #7a5a10; } .lv-low { color: #14631d; }
  .insight { color: #6b5310; }
  .tt { display: none !important; }
  a { color: inherit; text-decoration: none; }
  /* Two charts per row on A4 leaves each about 85mm wide, at which point the
     axis labels are unreadable and the chart is decoration. The QA probe
     measured it as clean because nothing overflowed: geometry cannot tell you
     something is too small to read. One chart per row, full width. */
  .timeline::before { background: #c3cad2; }
  .ph-node { border-color: #101418; background: #ffffff; }
  .ph-node::after { background: #101418; }
  footer { border-top: 1px solid #c3cad2; }
/* The donut sits beside its legend in a full-width figure; at 220px it is
   smaller than its own labels need. Flagged by the QA legibility check.
   NOTE: print rules belong HERE, not in an @media print block inside css():
   the probe switches this sheet on, so a rule it cannot see is a rule that
   ships unmeasured. */
.donut-wrap .chart { width: 320px; }
`;
}

function css(): string {
  return `
:root {
  --bg0: #0c0d0f;
  --bg1: #121316;
  --chart-surface: #16181b;
  --ink-1: #ecebe7;
  --ink-2: #c4c5c8;
  --ink-mut: #9a9da3;
  --grid: #24272c;
  --axisc: #484d56;
  --hair: rgba(212,169,79,0.22);
  --hair2: rgba(236,235,231,0.12);
  --cyan: #d4a94f;
  --cyan-soft: rgba(212,169,79,0.08);
  --amber: #f0c674;
  --amber-soft: rgba(245,184,61,0.1);
  --hover-wash: rgba(212,169,79,0.06);
  --fold: #8f9298;
  --c1: #3987e5; --c2: #d95926; --c3: #199e70; --c4: #c98500;
  --c5: #d55181; --c6: #008300; --c7: #9085e9; --c8: #e66767;
  --st-good: #0ca30c; --st-warn: #fab219; --st-serious: #ec835a; --st-crit: #d03b3b;
  --disp: 'Rajdhani', 'Avenir Next Condensed', 'Arial Narrow', system-ui, sans-serif;
  --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --body: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --serif: Georgia, 'Iowan Old Style', 'Times New Roman', serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  background: var(--bg0);
  color: var(--ink-2);
  font-family: var(--body);
  font-size: 15px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
body::before {
  content: '';
  position: fixed; inset: 0; z-index: 0; pointer-events: none;
  background:
    radial-gradient(900px 400px at 70% -10%, rgba(212,169,79,0.05), transparent 60%),
    repeating-linear-gradient(0deg, transparent 0 47px, rgba(148,163,184,0.025) 47px 48px),
    repeating-linear-gradient(90deg, transparent 0 47px, rgba(148,163,184,0.025) 47px 48px);
}
/* --hud-h is the fixed header's real height (set by the script; it grows when the nav wraps). */
main { position: relative; z-index: 1; max-width: 1100px; margin: 0 auto; padding: calc(var(--hud-h, 140px) + 28px) 28px 80px; }

/* ---------- header ---------- */
header.hud {
  position: fixed; top: 0; left: 0; right: 0; z-index: 50;
  background: rgba(12,13,15,0.92);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--hair);
}
.hud-in { max-width: 1100px; margin: 0 auto; padding: 12px 28px 0; }
.hud-row1 { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
.hud-brand { font-family: var(--mono); font-size: 10px; letter-spacing: 0.34em; color: var(--cyan); }
.hud-title { font-family: var(--disp); font-weight: 700; font-size: 21px; letter-spacing: 0.04em; color: var(--ink-1); text-transform: uppercase; }
.hud-sub { font-size: 12px; color: var(--ink-mut); flex: 1 1 auto; min-width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.badges { display: flex; gap: 6px; align-items: center; }
.badge { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--cyan); border: 1px solid var(--hair); padding: 2px 8px; border-radius: 3px; white-space: nowrap; }
.badge.amber { color: var(--amber); border-color: rgba(245,184,61,0.3); }
.badge.dt { color: var(--ink-mut); border-color: var(--hair2); }
.hud-row2 { display: flex; align-items: flex-start; gap: 4px; margin-top: 8px; }
.hud-row2 .controls { padding-top: 4px; }
/* Wraps rather than scrolls on wide screens: a hidden scrollbar hid the last sections. */
.nav { display: flex; flex-wrap: wrap; gap: 2px; flex: 1; min-width: 0; }
.nav::-webkit-scrollbar { display: none; }
.nav a {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--ink-mut); text-decoration: none; padding: 8px 10px 10px; white-space: nowrap;
  border-bottom: 2px solid transparent;
}
.nav a:hover { color: var(--ink-1); }
.nav a.act { color: var(--cyan); border-bottom-color: var(--cyan); }
.controls { display: flex; gap: 6px; padding-bottom: 6px; }
.controls button {
  font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.1em; cursor: pointer;
  color: var(--ink-2); background: transparent; border: 1px solid var(--hair2); border-radius: 3px; padding: 4px 9px;
}
.controls button:hover { color: var(--cyan); border-color: var(--hair); }

/* ---------- sections ---------- */
.sec { margin-bottom: 72px; scroll-margin-top: calc(var(--hud-h, 116px) + 12px); }
.sec-head { display: flex; align-items: center; gap: 14px; margin-bottom: 26px; }
.sec-num { font-family: var(--mono); font-size: 12px; color: var(--cyan); letter-spacing: 0.2em; }
.sec-head h2 { font-family: var(--disp); font-weight: 700; font-size: 26px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-1); }
.sec-rule { flex: 1; height: 1px; background: linear-gradient(90deg, var(--hair), transparent); }
.sec-sub { color: var(--ink-mut); font-size: 13.5px; margin: -14px 0 20px; }
.muted { color: var(--ink-mut); }

/* ---------- hero ---------- */
.hero { position: relative; border: 1px solid var(--hair); background: linear-gradient(180deg, rgba(212,169,79,0.05), rgba(212,169,79,0.015)); padding: 34px 38px; }
.hero::before, .hero::after {
  content: ''; position: absolute; width: 22px; height: 22px; border: 2px solid var(--cyan);
}
.hero::before { top: -2px; left: -2px; border-right: 0; border-bottom: 0; }
.hero::after { bottom: -2px; right: -2px; border-left: 0; border-top: 0; }
.hero-tag { font-family: var(--mono); font-size: 10px; letter-spacing: 0.3em; color: var(--amber); margin-bottom: 14px; }
.hero-text { font-family: var(--disp); font-weight: 600; font-size: 27px; line-height: 1.4; color: var(--ink-1); border-left: 3px solid var(--amber); padding-left: 22px; }
.brief { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 18px; }
.brief-label { display: block; font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.24em; color: var(--cyan); margin-bottom: 8px; }
.brief-goal, .brief-topic { border: 1px solid var(--hair2); background: var(--bg1); padding: 18px 20px; font-size: 13.5px; }
.brief-topic { font-style: italic; color: var(--ink-mut); }
.brief-topic p + p { margin-top: 8px; }

/* ---------- prose ---------- */
.prose { max-width: 780px; }
.prose p { margin-bottom: 16px; font-size: 15.5px; line-height: 1.75; }
.prose p:first-child::first-letter { font-family: var(--disp); font-size: 44px; line-height: 0.9; color: var(--cyan); float: left; padding: 4px 10px 0 0; }

/* ---------- stats ---------- */
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(136px, 1fr)); gap: 12px; }
.stat { border: 1px solid var(--hair2); background: var(--bg1); padding: 18px 16px 14px; position: relative; overflow: hidden; }
.stat::before { content: ''; position: absolute; top: 0; left: 0; width: 26px; height: 2px; background: var(--cyan); }
.stat-v { font-family: var(--disp); font-weight: 700; font-size: 32px; color: var(--ink-1); line-height: 1.1; }
.stat-l { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--ink-mut); margin-top: 6px; }

/* ---------- panel ---------- */
.panel-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(236px, 1fr)); gap: 14px; }
.panel-card { position: relative; border: 1px solid var(--hair2); border-left: 3px solid var(--accent, var(--cyan)); background: var(--bg1); padding: 18px 18px 14px; overflow: hidden; }
.pc-glow { position: absolute; inset: 0; background: radial-gradient(240px 90px at 0% 0%, color-mix(in srgb, var(--accent, #d4a94f) 14%, transparent), transparent 70%); pointer-events: none; }
.pc-name { font-family: var(--disp); font-weight: 700; font-size: 18px; color: var(--ink-1); letter-spacing: 0.02em; position: relative; }
.pc-role { font-size: 12.5px; color: var(--ink-2); margin-top: 3px; position: relative; }
.pc-id { font-family: var(--mono); font-size: 9px; letter-spacing: 0.18em; color: var(--ink-mut); margin-top: 12px; position: relative; }

/* ---------- dossiers ---------- */
.dossiers { display: flex; flex-direction: column; gap: 12px; }
.dossier { border: 1px solid var(--hair2); background: var(--bg1); }
.dossier.open { border-color: var(--hair); }
.dossier-head {
  display: grid; grid-template-columns: auto auto 1fr auto; align-items: center; gap: 14px;
  width: 100%; text-align: left; cursor: pointer; background: transparent; border: 0; padding: 15px 18px;
  color: inherit; font: inherit;
}
.dossier-head:hover { background: var(--cyan-soft); }
.d-idx { font-family: var(--mono); font-size: 11px; color: var(--cyan); letter-spacing: 0.14em; }
/* nowrap beat overflow-wrap and ran the pill off the page on a long topic.
   A pill that cannot fit should wrap, not escape. */
.d-topic { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--amber); border: 1px solid rgba(245,184,61,0.32); padding: 3px 8px; border-radius: 3px; max-width: 100%; }
.d-conc { font-family: var(--disp); font-weight: 600; font-size: 17.5px; color: var(--ink-1); line-height: 1.35; }
.chev { width: 9px; height: 9px; border-right: 2px solid var(--ink-mut); border-bottom: 2px solid var(--ink-mut); transform: rotate(45deg); transition: transform 0.18s; margin-right: 4px; }
.open > .dossier-head .chev { transform: rotate(225deg); }
[data-collapsible] > .cbody { display: none; }
[data-collapsible].open > .cbody { display: block; }
.dossier-body { padding: 4px 20px 22px; border-top: 1px solid var(--hair2); }
.d-meta { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.12em; color: var(--ink-mut); margin: 16px 0; }
.d-meta strong { color: var(--ink-1); font-weight: 600; }
.args-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.args { border: 1px solid var(--hair2); padding: 14px 16px; }
.args-h { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.22em; margin-bottom: 12px; }
.args.sup .args-h { color: var(--cyan); }
.args.chal .args-h { color: var(--amber); }
.args ul { list-style: none; }
.args li { margin-bottom: 12px; font-size: 13.5px; }
.args li:last-child { margin-bottom: 0; }
.arg-who { display: block; font-family: var(--mono); font-size: 10.5px; color: var(--ink-1); letter-spacing: 0.06em; margin-bottom: 2px; }
.arg-none { color: var(--ink-mut); font-style: italic; }
.resolution { margin-top: 16px; background: var(--cyan-soft); border-left: 3px solid var(--cyan); padding: 14px 18px; }
.res-label { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.22em; color: var(--cyan); margin-bottom: 6px; }
.resolution p { color: var(--ink-1); font-size: 14px; }
.deps { margin-top: 16px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.deps-label { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.2em; color: var(--ink-mut); margin-right: 4px; }
.dep-chip { font-family: var(--mono); font-size: 10.5px; color: var(--ink-2); border: 1px solid var(--hair2); border-radius: 999px; padding: 3px 11px; }
.founder-box { margin-top: 16px; background: var(--amber-soft); border-left: 3px solid var(--amber); padding: 14px 18px; }
.fb-label { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.22em; color: var(--amber); margin-bottom: 6px; }
.founder-box p { color: var(--ink-1); font-size: 14px; }

/* ---------- analysis / charts ---------- */
.viz-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(430px, 1fr)); gap: 18px; }
.viz-grid.one { grid-template-columns: 1fr; margin-top: 20px; }
.viz, .tcard { border: 1px solid var(--hair2); background: var(--bg1); padding: 18px 20px 14px; min-width: 0; }
.tcard { grid-column: 1 / -1; }
.viz-head h3 { font-family: var(--disp); font-weight: 600; font-size: 16.5px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-1); margin-bottom: 12px; }
.viz-body { background: var(--chart-surface); border: 1px solid var(--grid); border-radius: 4px; padding: 12px 10px 8px; }
.chart { display: block; width: 100%; height: auto; }
.chart text { font-family: var(--mono); }
.chart .ax { font-size: 11px; fill: var(--ink-mut); font-variant-numeric: tabular-nums; }
.chart .axl { font-size: 9.5px; fill: var(--ink-mut); letter-spacing: 0.14em; text-transform: uppercase; }
.chart .cat { font-size: 12px; fill: var(--ink-2); }
.chart .vl { font-size: 11px; font-weight: 600; fill: var(--ink-1); font-variant-numeric: tabular-nums; }
.chart .quad { font-size: 9px; fill: var(--ink-mut); letter-spacing: 0.2em; opacity: 0.75; }
.chart .grid { stroke: var(--grid); stroke-width: 1; fill: none; }
.chart .axis { stroke: var(--axisc); stroke-width: 1; }
.chart .ctr-v { font-family: var(--disp); font-size: 25px; font-weight: 700; fill: var(--ink-1); }
.chart .ctr-l { font-size: 9px; letter-spacing: 0.3em; fill: var(--ink-mut); }
.chart .mx-num { font-size: 10px; font-weight: 700; }
.chart .endl .cat { font-size: 11.5px; }
.chart .hit { outline: none; fill-opacity: 1; }
.chart rect.hit { fill: transparent; }
.chart rect.hit.band:hover, .chart rect.hit.band:focus { fill: var(--hover-wash); }
.chart .grp:hover .mark, .chart .grp:hover .lmark { filter: brightness(1.16); }
.chart .hit:focus-visible { stroke: var(--cyan); stroke-width: 1.5; stroke-dasharray: 3 3; }
.chart-legend { display: flex; flex-wrap: wrap; gap: 8px 18px; padding: 2px 6px 10px; }
.lg-item { display: inline-flex; align-items: center; gap: 7px; font-family: var(--mono); font-size: 11px; color: var(--ink-2); }
.lg-swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.lg-line { width: 14px; height: 3px; border-radius: 2px; display: inline-block; }
.lg-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.donut-wrap { display: flex; align-items: center; gap: 22px; flex-wrap: wrap; }
.donut-wrap .chart { width: 220px; flex: 0 0 auto; margin: 0 auto; }
.dlegend { list-style: none; flex: 1 1 240px; min-width: 230px; }
.dlegend li { display: grid; grid-template-columns: 14px 1fr auto auto; gap: 10px; align-items: center; padding: 6px 4px; border-bottom: 1px solid var(--grid); font-size: 12.5px; }
.dlegend li:last-child { border-bottom: 0; }
.dl-name { color: var(--ink-2); }
.dl-val { font-family: var(--mono); font-size: 11.5px; color: var(--ink-1); font-variant-numeric: tabular-nums; }
.dl-pct { font-family: var(--mono); font-size: 11px; color: var(--ink-mut); font-variant-numeric: tabular-nums; }
.insight { margin: 12px 2px 4px; font-size: 13px; color: var(--amber); line-height: 1.5; }
.ins-mark { color: var(--cyan); margin-right: 8px; }
.mx-list { list-style: none; columns: 2; gap: 24px; margin-top: 12px; padding: 0 4px; }
.mx-list li { display: flex; align-items: flex-start; gap: 9px; font-size: 12.5px; padding: 4px 0; break-inside: avoid; }
/* A model can emit an unbroken 100-character token (a slug, a URL, a fused
   phrase) and SVG-free prose will happily run it off the page. The QA corpus
   caught seven such overflows across the decision, dissent and argument
   blocks. Nothing in a printed report benefits from refusing to break. */
.d-topic, .d-conc, .arg-text, .arg-who, .args-h, .dep-chip, .dis-pos, .dis-why,
.oq-list p, .mx-t, .insight, .prose p, .tcard td, .tcard th, .ph-actions li,
.risk-t, .risk-m, .memo-body p, .cv-call p, .r-text, .au-fig, .au-re, .au-im {
  overflow-wrap: anywhere;
  word-break: break-word;
}

/* transform: translateY(3px) pushed each badge into the row beneath it, which
   the overlap check saw as five badges printed over their neighbours. Aligning
   the row instead keeps them in their own line. */
.mx-badge { flex: 0 0 auto; width: 18px; height: 18px; border-radius: 50%; font-family: var(--mono); font-size: 10px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.mx-t { color: var(--ink-2); }
.mx-c { font-family: var(--mono); font-size: 10px; color: var(--ink-mut); white-space: nowrap; }
.cdata { margin-top: 10px; border-top: 1px solid var(--grid); }
.cdata .ctog { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.2em; color: var(--ink-mut); background: transparent; border: 0; cursor: pointer; padding: 8px 2px 4px; }
.cdata .ctog:hover { color: var(--cyan); }
.cdata .ctog::before { content: '+ '; }
.cdata.open .ctog::before { content: '- '; }
.cdata .cbody { padding: 4px 0 8px; }

/* ---------- tables ---------- */
.tscroll { overflow-x: auto; }
/* Focusable so a wide table scrolls sideways from the keyboard too. */
.tscroll:focus-visible { outline: 2px solid var(--cyan); outline-offset: -2px; }
.dtable { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.dtable th { font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-mut); text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--axisc); }
.dtable td { padding: 8px 10px; border-bottom: 1px solid var(--grid); color: var(--ink-2); vertical-align: top; }
.dtable td.num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.dtable.big { font-size: 13.5px; }
.dtable.big td { padding: 11px 12px; }
.dtable tbody tr:hover { background: var(--hover-wash); }
.tnote { margin-top: 10px; font-size: 12px; color: var(--ink-mut); font-style: italic; }
.rk-t { color: var(--ink-1); font-weight: 600; }
.rk-m { max-width: 340px; }
.rk-o { font-family: var(--mono); font-size: 11.5px; white-space: nowrap; }
.lv { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; border: 1px solid var(--hair2); border-radius: 999px; padding: 3px 10px; white-space: nowrap; }
.lv-dot { width: 7px; height: 7px; border-radius: 50%; }
.lv-high .lv-dot { background: var(--st-crit); } .lv-high { color: #ff9d9d; border-color: rgba(208,59,59,0.5); }
.lv-med .lv-dot { background: var(--st-warn); } .lv-med { color: #ffd47e; border-color: rgba(250,178,25,0.4); }
.lv-low .lv-dot { background: var(--st-good); } .lv-low { color: #7fd67f; border-color: rgba(12,163,12,0.45); }

/* ---------- numbers audit ----------
   Set as an instrument readout, not prose: two large counters, then a table.
   The founder should be able to tell in one second whether his spine survived
   recomputation, and only then read why. */
.audit-lead { display: flex; align-items: flex-start; gap: 26px; flex-wrap: wrap; padding: 20px 24px; border: 1px solid var(--hair2); border-left: 4px solid var(--st-good); background: linear-gradient(180deg, rgba(12,163,12,0.06), transparent 70%); }
.audit-lead.flagged { border-left-color: var(--st-crit); background: linear-gradient(180deg, rgba(208,59,59,0.08), transparent 70%); }
.al-stat { display: flex; flex-direction: column; gap: 2px; min-width: 92px; }
.al-n { font-family: var(--disp); font-weight: 700; font-size: 42px; line-height: 1; color: var(--ink-1); font-variant-numeric: tabular-nums; }
.audit-lead.flagged .al-stat:nth-child(2) .al-n { color: var(--st-crit); }
.al-l { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--ink-mut); }
.al-sum { flex: 1 1 320px; margin: 0; font-size: 14.5px; line-height: 1.6; }
.au-note { font-size: 13px; color: var(--ink-mut); margin: 14px 0 10px; }
/* Fixed layout: without it the recomputed column, which carries the actual
   arithmetic and is always the longest cell, gets squeezed into a ribbon while
   the verdict chip hogs width it does not need. */
.audit-table { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }
.audit-table col.c-v { width: 82px; }
.audit-table col.c-f { width: 23%; }
.audit-table col.c-r { width: 42%; }
.audit-table col.c-i { width: auto; }
/* Fixed layout means a nowrap header simply overprints its neighbour. */
.audit-table th { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-mut); text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--hair); line-height: 1.5; }
.audit-table td { padding: 10px; border-bottom: 1px solid var(--hair2); vertical-align: top; line-height: 1.5; }
.audit-table .au-v { font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; white-space: nowrap; }
.au-holds .au-v { color: var(--st-good); }
.au-wrong .au-v { color: var(--st-crit); }
.au-uncheckable .au-v { color: var(--ink-mut); }
.au-wrong .au-re { color: var(--st-crit); }
.au-wrong { background: rgba(208,59,59,0.05); }
.au-im { color: var(--ink-mut); }

/* ---------- dissents ---------- */
.dissent-list { display: flex; flex-direction: column; gap: 14px; }
.dissent { border: 1px solid rgba(236,131,90,0.35); border-left: 4px solid var(--st-serious); background: linear-gradient(180deg, rgba(236,131,90,0.07), transparent 70%); padding: 20px 24px; }
.dis-label { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.26em; color: var(--st-serious); margin-bottom: 10px; }
.dis-who { font-family: var(--disp); font-weight: 700; font-size: 18px; color: var(--ink-1); }
.dis-pos { font-family: var(--disp); font-weight: 600; font-size: 16.5px; color: var(--ink-1); margin: 6px 0 8px; line-height: 1.4; }
.dis-why { font-size: 14px; }
.dis-trip, .dis-cost { font-size: 13.5px; margin-top: 8px; color: var(--ink-2); overflow-wrap: anywhere; word-break: break-word; }
.dis-k { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.2em; color: var(--st-serious); margin-right: 6px; }
.dis-by { color: var(--ink-mut); }
.dis-incomplete { font-size: 12.5px; margin-top: 8px; color: var(--ink-mut); font-style: italic; overflow-wrap: anywhere; }

/* ---------- stakes ---------- */
.stakes-table th { width: 30%; white-space: normal; }
.stakes-table td { overflow-wrap: anywhere; word-break: break-word; }
.persona-table th { width: 24%; white-space: normal; }
.persona-table td { overflow-wrap: anywhere; word-break: break-word; }
.dep-chip.dep-assumed { color: var(--amber, #c9a227); border-color: currentColor; overflow-wrap: anywhere; }
.assumed-tag { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--amber, #c9a227); border: 1px solid currentColor; padding: 0 5px; margin-left: 6px; white-space: nowrap; }

/* ---------- how minds changed ---------- */
.minds-list { display: flex; flex-direction: column; gap: 14px; }
.minds { border: 1px solid var(--grid); border-left: 4px solid var(--cyan); padding: 16px 20px; break-inside: avoid; }
.minds-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 16px; margin-bottom: 8px; }
.minds-motion { font-family: var(--disp); font-weight: 700; font-size: 16px; color: var(--ink-1); overflow-wrap: anywhere; }
.minds-caused { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.1em; color: var(--ink-mut); }
.minds-lines { margin: 0; padding-left: 18px; }
.minds-lines li { font-size: 13.5px; color: var(--ink-2); margin: 4px 0; overflow-wrap: anywhere; word-break: break-word; }

/* ---------- roadmap ---------- */
.timeline { position: relative; padding-left: 26px; }
.timeline::before { content: ''; position: absolute; left: 7px; top: 6px; bottom: 6px; width: 1px; background: linear-gradient(180deg, var(--cyan), var(--hair2)); }
.phase { position: relative; margin-bottom: 18px; }
.ph-node { position: absolute; left: -26px; top: 22px; width: 15px; height: 15px; border-radius: 50%; border: 2px solid var(--cyan); background: var(--bg0); }
.ph-node::after { content: ''; position: absolute; inset: 3px; border-radius: 50%; background: var(--cyan); }
.ph-card { border: 1px solid var(--hair2); background: var(--bg1); padding: 18px 22px; }
.ph-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.ph-name { font-family: var(--disp); font-weight: 700; font-size: 18px; color: var(--ink-1); letter-spacing: 0.03em; }
.ph-time { font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em; color: var(--amber); border: 1px solid rgba(245,184,61,0.32); padding: 3px 9px; border-radius: 3px; }
.ph-actions { list-style: none; }
.ph-actions li { position: relative; padding-left: 18px; margin-bottom: 6px; font-size: 13.5px; }
.ph-actions li::before { content: ''; position: absolute; left: 2px; top: 8px; width: 6px; height: 6px; border: 1px solid var(--cyan); transform: rotate(45deg); }
.ph-meta { display: flex; gap: 22px; flex-wrap: wrap; margin-top: 12px; font-size: 12px; color: var(--ink-2); }
.ph-k { font-family: var(--mono); font-size: 9px; letter-spacing: 0.18em; color: var(--ink-mut); margin-right: 5px; }

/* ---------- open questions ---------- */
.src-list { list-style: none; max-width: 820px; }
.src-list li { display: flex; gap: 16px; padding: 12px 4px; border-bottom: 1px solid var(--hair2); }
.src-id { font-family: var(--mono); font-size: 11px; color: var(--cyan); flex: 0 0 auto; padding-top: 2px; }
.src-body { min-width: 0; }
.src-title { font-size: 14px; color: var(--ink-2); overflow-wrap: anywhere; }
.src-title a { color: inherit; overflow-wrap: anywhere; word-break: break-word; }
.src-meta, .src-quote { overflow-wrap: anywhere; }
.src-meta, .src-prov { font-size: 12px; color: var(--ink-mut); margin-top: 2px; }
.src-url { font-family: var(--mono); font-size: 10.5px; color: var(--ink-mut); overflow-wrap: anywhere; margin-top: 2px; }
.src-quote { font-size: 12.5px; color: var(--ink-2); border-left: 2px solid var(--hair); padding-left: 10px; margin: 6px 0; }
.src.unattested .src-prov { color: var(--amber, #c9a227); }
.oq-list { list-style: none; max-width: 820px; }
.oq-list li { display: flex; gap: 16px; padding: 14px 4px; border-bottom: 1px solid var(--hair2); }
.oq-n { font-family: var(--mono); font-size: 12px; color: var(--cyan); letter-spacing: 0.1em; flex: 0 0 auto; padding-top: 2px; }
.oq-list p { font-size: 14.5px; color: var(--ink-2); }

/* ---------- moderator memo ---------- */
.memo { border: 1px solid var(--hair2); background: var(--bg1); max-width: 820px; padding: 0; }
.memo-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 16px 30px; border-bottom: 1px solid var(--hair2); font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.26em; color: var(--cyan); }
.memo-date { color: var(--ink-mut); letter-spacing: 0.12em; }
.memo-body { padding: 26px 30px 6px; font-family: var(--serif); font-size: 15.5px; line-height: 1.8; color: var(--ink-2); }
.memo-body p { margin-bottom: 16px; }
.memo-sign { padding: 6px 30px 26px; }
.sig { font-family: var(--disp); font-weight: 700; font-size: 26px; color: var(--ink-1); letter-spacing: 0.06em; }
.sig-role { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.2em; color: var(--ink-mut); margin-top: 2px; }

/* ---------- footer + tooltip ---------- */
footer { position: relative; z-index: 1; border-top: 1px solid var(--hair2); padding: 18px 28px 30px; text-align: center; font-family: var(--mono); font-size: 10px; letter-spacing: 0.18em; color: var(--ink-mut); }
.tt {
  display: none; position: fixed; z-index: 100; pointer-events: none;
  background: #0c1522; border: 1px solid var(--hair); border-radius: 4px;
  color: var(--ink-1); font-family: var(--mono); font-size: 11px; line-height: 1.55;
  padding: 8px 11px; max-width: 300px; white-space: pre-line;
  box-shadow: 0 6px 24px rgba(0,0,0,0.5);
}

/* ---------- responsive ---------- */
@media (max-width: 860px) {
  main { padding-top: calc(var(--hud-h, 162px) + 28px); }
  /* On a phone the nav is a full-width row you swipe along, with the buttons under it. */
  .badges { flex-wrap: wrap; }
  .hud-row2 { flex-wrap: wrap; }
  .nav { flex: 1 1 100%; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
  .brief, .args-grid { grid-template-columns: 1fr; }
  .viz-grid { grid-template-columns: 1fr; }
  .mx-list { columns: 1; }
  .d-conc { font-size: 15px; }
  .hero-text { font-size: 21px; }
  .dossier-head { grid-template-columns: auto 1fr auto; }
  .d-topic { display: none; }
}

/* ---------- cover + contents ----------
   Hidden on screen: the web report already opens with the recommendation and
   has a sticky nav, so a cover there would just be a page to scroll past. In
   print they are the first two sheets. */
.cover, .toc { display: none; }



/* ---------- print: clean light professional ---------- */
/**
 * PAGE SETUP. There was none, which is what clipped the report.
 *
 * On screen the main column is capped at 1100px; print set max-width none, so
 * auto-fit grids laid themselves out against a width wider than the paper and
 * Chrome sliced the right-hand column off mid-card. The stats strip lost its
 * fifth tile and the panel roster lost a name per row. Declaring the sheet and
 * holding the content inside it is the fix; explicit column counts below stop
 * auto-fit from guessing.
 */


`;
}

/* ------------------------------------------------------------------ */
/* Inline JS                                                           */
/* Written so the emitted text never contains the raw tokens           */
/* "und"+"efined" or "nu"+"ll" (the render-sample assertions ban them  */
/* anywhere in the document), and never the "<\/script" sequence.      */
/* ------------------------------------------------------------------ */

function js(): string {
  return `
(function () {
  'use strict';
  var doc = document;
  function all(sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); }

  /* keep the page clear of the fixed header, however many rows its nav takes */
  var hud = doc.querySelector('header.hud');
  function fitHud() { if (hud) doc.documentElement.style.setProperty('--hud-h', hud.offsetHeight + 'px'); }
  fitHud();
  window.addEventListener('resize', fitHud);

  /* collapsibles: dossiers + chart data tables */
  all('[data-collapsible]').forEach(function (box) {
    var btn = box.querySelector('.ctog');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var open = box.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });
  function setAll(open) {
    all('[data-collapsible]').forEach(function (box) {
      box.classList.toggle('open', open);
      var btn = box.querySelector('.ctog');
      if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  var ea = doc.getElementById('expand-all');
  var ca = doc.getElementById('collapse-all');
  if (ea) ea.addEventListener('click', function () { setAll(true); });
  if (ca) ca.addEventListener('click', function () { setAll(false); });

  /* scrollspy */
  var secs = all('[data-sec]');
  var navLinks = all('.nav a');
  var ticking = false;
  function spy() {
    ticking = false;
    var cur = '';
    secs.forEach(function (s) {
      if (s.getBoundingClientRect().top <= 140) cur = s.id;
    });
    navLinks.forEach(function (a) {
      var on = (a.getAttribute('href') || '') === '#' + cur;
      a.classList.toggle('act', on);
    });
  }
  window.addEventListener('scroll', function () {
    if (!ticking) { ticking = true; window.requestAnimationFrame(spy); }
  }, { passive: true });
  spy();

  /* custom tooltip layer for [data-tt] hit targets */
  var tip = doc.createElement('div');
  tip.className = 'tt';
  doc.body.appendChild(tip);
  var showing = false;
  function showTip(text, x, y) {
    tip.textContent = text;
    tip.style.display = 'block';
    var r = tip.getBoundingClientRect();
    var lx = Math.min(Math.max(8, x + 14), window.innerWidth - r.width - 8);
    var ly = y - r.height - 14;
    if (ly < 8) ly = y + 20;
    tip.style.left = lx + 'px';
    tip.style.top = ly + 'px';
    showing = true;
  }
  function hideTip() { tip.style.display = 'none'; showing = false; }
  doc.addEventListener('pointermove', function (e) {
    var t = e.target;
    var host = t && t.closest ? t.closest('[data-tt]') : 0;
    if (host) showTip(host.getAttribute('data-tt') || '', e.clientX, e.clientY);
    else if (showing) hideTip();
  });
  doc.addEventListener('focusin', function (e) {
    var t = e.target;
    var host = t && t.closest ? t.closest('[data-tt]') : 0;
    if (host) {
      var r = host.getBoundingClientRect();
      showTip(host.getAttribute('data-tt') || '', r.left + r.width / 2, r.top);
    }
  });
  doc.addEventListener('focusout', hideTip);
})();
`;
}

/* ------------------------------------------------------------------ */
/* Document assembly                                                   */
/* ------------------------------------------------------------------ */

export function renderReport(data: ReportData): string {
  const sections = SECTIONS.filter((s) =>
    (s.id !== 'audit' || !!data.numbersAudit) &&
    (s.id !== 'persona' || arr(data.personaClaims).length > 0) &&
    (s.id !== 'sources' || arr(data.sources).length > 0) &&
    (s.id !== 'stakes' || arr(data.stakes).length > 0) &&
    (s.id !== 'minds' || arr(data.mindChanges).length > 0));
  ACTIVE = sections.map((s) => s.id);
  const nav = sections.map((s) => `<a href="#${s.id}">${s.nav}</a>`).join('');
  const body = [
    coverPage(data),
    tocPage(sections),
    heroSection(data),
    summarySection(data),
    arr(data.stakes).length ? stakesSection(data) : '',
    statsSection(data),
    panelSection(data),
    decisionsSection(data),
    arr(data.mindChanges).length ? mindsSection(data) : '',
    data.numbersAudit ? auditSection(data) : '',
    arr(data.personaClaims).length ? personaSection(data) : '',
    analysisSection(data),
    dissentsSection(data),
    risksSection(data),
    roadmapSection(data),
    openQuestionsSection(data),
    moderatorSection(data),
    arr(data.sources).length ? sourcesSection(data) : '',
  ].filter(Boolean).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.title)} | DEBATE Report</title>
<style>${inlineFontCss(['Rajdhani', 'JetBrains Mono'])}</style>
<style>${css()}</style>
<style media="print" id="print-css">${printCss()}</style>
</head>
<body>
<header class="hud">
  <div class="hud-in">
    <div class="hud-row1">
      <span class="hud-brand">DEBATE // FINAL REPORT</span>
      <span class="hud-title">${esc(data.title)}</span>
      <span class="hud-sub">${esc(data.subtitle)}</span>
      <span class="badges">
        <span class="badge">${esc(data.model)}</span>
        <span class="badge">${esc(data.mode)}</span>
        <span class="badge amber">${esc(data.autonomy)}</span>
        <span class="badge dt">${esc(fmtDate(data.generatedAtIso))}</span>
      </span>
    </div>
    <div class="hud-row2">
      <nav class="nav" aria-label="Report sections">${nav}</nav>
      <div class="controls">
        <button type="button" id="expand-all">EXPAND ALL</button>
        <button type="button" id="collapse-all">COLLAPSE ALL</button>
      </div>
    </div>
  </div>
</header>
<main>
${body}
</main>
<footer>GENERATED BY DEBATE &middot; ${esc(fmtDate(data.generatedAtIso))} &middot; ${esc(data.model)} / ${esc(data.mode)} / ${esc(data.autonomy)}</footer>
<script>${js()}</script>
</body>
</html>`;
}
