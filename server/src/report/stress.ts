import type { ChartSpec, ReportData } from '../../../shared/report-types.ts';

/**
 * Reports designed to break the template.
 *
 * The gate in qa.ts can only find faults in the data it is given, and a real
 * session's data is whatever that session happened to produce. Checking real
 * reports therefore proves the template survived the past, not that it will
 * survive the next founder's numbers. This corpus is the other half: content
 * chosen for the properties that break print layouts rather than for meaning.
 *
 * Every fixture encodes a way a document has actually failed somewhere:
 * a label longer than its column, a value with more digits than its box, a
 * single-point series, an all-zero axis, forty rows where four were expected,
 * one unbroken 200-character token, right-to-left text, and the empty case.
 * Run them all through the same probe the live path uses (npm run qa) and any
 * regression shows up as geometry, before a friend sees it.
 */

const LONG =
  'Subscription pricing at the productivity-category median, adjusted for involuntary churn and merchant-of-record fees';
const HUGE = 'Antidisestablishmentarianismandsupercalifragilisticexpialidociousrevenueattributionmodelwithoutanyspacesatall';

const chart = (id: string, kind: ChartSpec['kind'], over: Partial<ChartSpec> = {}): ChartSpec => ({
  id,
  title: over.title ?? `Stress: ${kind}`,
  insight: over.insight ?? 'Generated to break the layout, not to mean anything.',
  kind,
  series: over.series ?? [{ name: 'Series', points: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }] }],
  ...over,
});

const base = (): ReportData => ({
  title: 'Stress Fixture',
  subtitle: 'A report built from the shapes that break page layouts',
  generatedAtIso: new Date('2026-08-03T12:00:00Z').toISOString(),
  topic: 'Stress topic',
  goal: 'Stress goal',
  model: 'Claude · chair Opus 5.5',
  mode: 'directed',
  autonomy: 'autonomous',
  panel: [
    { id: 'marcus', name: 'Marcus Hale', role: 'Moderator', color: '#c8a24a' },
    { id: 'a', name: 'Dr. Aleksandra Vasilievna Konstantinopolskaya-Whitmore', role: LONG, color: '#4fa88a' },
    { id: 'b', name: 'B', role: '', color: '#3ee0ff' },
  ],
  stats: { messages: 999999, interjections: 0, researchTasks: 0, planRevisions: 0, userDecisions: 0, assumptions: 0, durationMin: 100000 },
  keyRecommendation: LONG.repeat(3),
  executiveSummary: [HUGE, LONG.repeat(2), 'ا لعربية نص طويل جدا لاختبار الاتجاه من اليمين إلى اليسار في التخطيط'],
  decisions: [
    {
      topic: HUGE,
      conclusion: LONG,
      proposedBy: 'Dr. Aleksandra Vasilievna Konstantinopolskaya-Whitmore',
      supportedBy: [{ expert: 'B', argument: LONG }],
      challengedBy: [{ expert: 'B', objection: HUGE }],
      resolution: LONG.repeat(2),
      dependsOn: [HUGE, LONG],
      userInput: LONG,
    },
  ],
  dissents: [{ expert: 'Dr. Aleksandra Vasilievna Konstantinopolskaya-Whitmore', position: HUGE, reasoning: LONG.repeat(2) }],
  risks: Array.from({ length: 14 }, (_, i) => ({
    title: i % 2 ? HUGE : `${LONG} ${i}`,
    likelihood: (['low', 'medium', 'high'] as const)[i % 3],
    impact: (['low', 'medium', 'high'] as const)[(i + 1) % 3],
    mitigation: LONG,
    owner: 'Dr. Aleksandra Vasilievna Konstantinopolskaya-Whitmore',
  })),
  charts: [],
  tables: [
    {
      id: 't1',
      title: LONG,
      columns: ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'],
      rows: Array.from({ length: 24 }, (_, r) => Array.from({ length: 8 }, (_, c) => (c === 0 ? HUGE : `${r}-${c} ${LONG.slice(0, 40)}`))),
      note: LONG,
    },
  ],
  roadmap: [
    // Deliberately malformed: the writer omitted `actions` entirely. This
    // used to throw inside renderReport and cost the whole document.
    { phase: LONG, timeframe: 'Weeks 1-2', owner: 'Dr. Aleksandra Vasilievna Konstantinopolskaya-Whitmore' } as never,
    { phase: 'Well-formed phase', timeframe: 'Weeks 3-6', actions: [HUGE, LONG], owner: 'B' },
  ],
  openQuestions: [HUGE, LONG.repeat(2)],
  moderatorNote: LONG.repeat(4),
});

export interface Fixture { name: string; data: ReportData }

export function stressFixtures(): Fixture[] {
  const out: Fixture[] = [];

  // 1. Long strings everywhere, no charts: pure text/table pressure.
  out.push({ name: 'text-and-tables', data: base() });

  // 2. Every chart kind with hostile labels.
  const hostile: ReportData = {
    ...base(),
    charts: [
      chart('c-bar', 'bar', {
        series: [{ name: LONG, points: [{ label: LONG, value: 1234567.89 }, { label: HUGE, value: 0.0001 }, { label: 'Short', value: 999999999 }] }],
        unit: '₹',
        xLabel: `${LONG} (0-10)`,
      }),
      chart('c-col', 'bar', {
        series: Array.from({ length: 6 }, (_, i) => ({
          name: `${LONG} ${i}`,
          points: Array.from({ length: 9 }, (_, j) => ({ label: `${LONG.slice(0, 30)} ${j}`, value: (i + 1) * (j + 1) })),
        })),
      }),
      chart('c-line', 'line', {
        series: Array.from({ length: 5 }, (_, i) => ({
          name: `${LONG} series ${i}`,
          points: Array.from({ length: 30 }, (_, j) => ({ label: `Month ${j} of the very long horizon`, value: Math.sin(j / 3) * 100 + i })),
        })),
        unit: '%',
      }),
      chart('c-donut', 'donut', {
        series: [{ name: 'Split', points: Array.from({ length: 12 }, (_, i) => ({ label: `${LONG.slice(0, 25)} ${i}`, value: i + 1 })) }],
      }),
      chart('c-radar', 'radar', {
        series: [{ name: LONG, points: Array.from({ length: 7 }, (_, i) => ({ label: `${LONG.slice(0, 28)} ${i}`, value: (i * 3) % 11 })) }],
      }),
      chart('c-matrix', 'matrix', {
        series: [{ name: 'Risks', points: Array.from({ length: 10 }, (_, i) => ({ label: `${LONG} ${i}`, value: (i * 2) % 11, value2: (i * 3) % 11 })) }],
        xLabel: 'Impact (0-10)',
        yLabel: 'Likelihood',
      }),
    ],
  };
  out.push({ name: 'charts-hostile-labels', data: hostile });

  // 3. Degenerate data: the shapes that produce NaN, divide-by-zero or nothing.
  const degenerate: ReportData = {
    ...base(),
    charts: [
      chart('d-single', 'line', { series: [{ name: 'One point', points: [{ label: 'Only', value: 5 }] }] }),
      chart('d-zero', 'bar', { series: [{ name: 'All zero', points: [{ label: 'A', value: 0 }, { label: 'B', value: 0 }] }] }),
      chart('d-neg', 'bar', { series: [{ name: 'Negative', points: [{ label: 'A', value: -50 }, { label: 'B', value: 120 }] }] }),
      chart('d-empty', 'donut', { series: [{ name: 'Empty', points: [] }] }),
      chart('d-nosery', 'radar', { series: [] }),
      chart('d-tiny', 'radar', { series: [{ name: 'Too few axes', points: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }] }] }),
      chart('d-big', 'bar', { series: [{ name: 'Huge', points: [{ label: 'A', value: 9.87654321e12 }, { label: 'B', value: 1 }] }], unit: '₹' }),
    ],
  };
  out.push({ name: 'charts-degenerate', data: degenerate });

  // 4. The empty report: every optional section absent.
  out.push({
    name: 'minimal',
    data: {
      ...base(),
      keyRecommendation: 'Short.',
      executiveSummary: ['One line.'],
      decisions: [],
      dissents: [],
      risks: [],
      charts: [],
      tables: [],
      roadmap: [],
      openQuestions: [],
      moderatorNote: '',
      panel: [{ id: 'marcus', name: 'Marcus Hale', role: 'Moderator', color: '#c8a24a' }],
    },
  });

  // 5. Audit present with a wrong finding: the widest table in the document.
  out.push({
    name: 'with-audit',
    data: {
      ...base(),
      numbersAudit: {
        checked: 9,
        summary: LONG.repeat(2),
        findings: Array.from({ length: 9 }, (_, i) => ({
          figure: i % 2 ? HUGE : LONG,
          verdict: (['holds', 'wrong', 'uncheckable'] as const)[i % 3],
          recomputed: LONG,
          impact: HUGE,
        })),
      },
    },
  });

  // 6. Research sources: long titles, an unbreakable URL, a quote, every provenance.
  out.push({
    name: 'with-sources',
    data: {
      ...base(),
      sources: Array.from({ length: 6 }, (_, i) => ({
        id: `c_${String(i).repeat(8).slice(0, 8)}`,
        url: `https://www.example.org/${'a-very-long-path-segment-without-breaks'.repeat(4)}/${i}?q=${'x'.repeat(60)}`,
        title: i % 2 ? HUGE : LONG,
        publisher: i % 3 ? 'Example Trade Body' : undefined,
        publishedAt: '2025-11-03',
        retrievedAt: 0,
        quote: i % 2 ? LONG.slice(0, 300) : undefined,
        provenance: (['fetched', 'search_result', 'model_reported'] as const)[i % 3],
        provider: (['claude', 'openai', 'codex'] as const)[i % 3],
      })),
    },
  });

  // 7. The realism sections (2b-6): stakes with assumed lines, how minds changed, dissents with tripwires.
  out.push({
    name: 'with-realism',
    data: {
      ...base(),
      stakes: [
        { label: 'Decision owner', value: LONG, assumed: true },
        { label: 'Decide by', value: 'the board meeting on 12 November', assumed: false },
        { label: 'At risk', value: `money: ${HUGE}`, assumed: false },
        { label: 'If a wrong yes', value: LONG, assumed: true },
        { label: 'If a wrong no', value: 'not stated', assumed: true },
        { label: 'Can it be undone', value: 'No: a one-way door', assumed: true },
      ],
      mindChanges: Array.from({ length: 3 }, (_, i) => ({
        motionTitle: i ? LONG : 'Annual billing',
        lines: [LONG, HUGE, 'Held firm: Ana Ruiz, Bo Chen.', `Evidence [c_${'9'.repeat(8)}] moved ${LONG}.`],
        concessions: i * 3,
        causedShare: i ? 0.67 : 1,
        changedMinds: ['Cy Okafor'],
        heldFirm: ['Ana Ruiz', 'Bo Chen'],
      })),
      minority: Array.from({ length: 4 }, (_, i) => ({
        motionTitle: i % 2 ? LONG : 'Annual billing',
        expert: i % 2 ? HUGE.slice(0, 120) : 'Bo Chen',
        position: LONG,
        reasoning: HUGE,
        ...(i % 2 ? {} : { tripwire: { signal: LONG, by: 'end of Q2' }, costOfIgnoring: HUGE }),
        incomplete: i % 2 ? ['no tripwire: nothing named that would prove the dissenter right', 'no cost of ignoring it'] : [],
      })),
    },
  });

  // 8. Evidence honesty (P1): persona anecdotes listed, an audit row and trail chips labelled as assumptions.
  const withPersona = base();
  out.push({
    name: 'with-persona',
    data: {
      ...withPersona,
      decisions: withPersona.decisions.map((d, i) => ({
        ...d,
        dependsOn: [...(d.dependsOn ?? []), `Assumption, not evidence (a panelist's illustrative experience, not your business): Marisol Ortega, "${i ? HUGE.slice(0, 200) : 'my head baker quit after eight weeks covering Sundays'}"`],
      })),
      numbersAudit: {
        checked: 2,
        summary: LONG,
        findings: [
          { figure: 'my busiest Bristol counter never saw a third of 360 asks', verdict: 'uncheckable', recomputed: LONG, impact: `Assumption, not evidence (a panelist's illustrative experience, not your business). ${LONG}`, origin: 'persona' },
          { figure: LONG, verdict: 'holds', recomputed: LONG, impact: HUGE },
        ],
      },
      personaClaims: [
        { expert: 'Marisol Ortega', claim: 'My head baker quit after eight weeks of covering Sunday bakes', figures: ['8'] },
        { expert: HUGE.slice(0, 120), claim: HUGE, figures: [] },
        { expert: 'Marisol Ortega', claim: 'pre-dawn bakers in shops I\'ve run typically start around 4am and work through to about noon', figures: ['4am'] },
      ],
    },
  });

  return out;
}
