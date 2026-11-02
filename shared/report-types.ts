/**
 * DEBATE — final report data contract.
 * The report analyst agent emits exactly this JSON; the renderer
 * (server/src/report/render.ts) turns it into a standalone interactive HTML.
 */
import type { Citation } from './research.ts';

export interface ReportPanelist {
  id: string;
  name: string;
  role: string;
  color: string;   // hex accent
}

export interface ReportStats {
  messages: number;
  interjections: number;
  researchTasks: number;
  planRevisions: number;
  userDecisions: number;
  assumptions: number;   // autonomous-mode decisions taken without the user
  durationMin: number;
}

export interface DecisionTrail {
  topic: string;                 // short label, e.g. 'Pricing model'
  conclusion: string;            // one-sentence conclusion
  proposedBy: string;            // expert name
  supportedBy: { expert: string; argument: string }[];
  challengedBy: { expert: string; objection: string }[];
  resolution: string;            // what argument/data/realization settled it
  dependsOn: string[];           // assumptions that must hold
  userInput?: string;            // what the user said when consulted
}

export interface Dissent {
  expert: string;
  position: string;              // what they still believe
  reasoning: string;
}

export interface Risk {
  title: string;
  likelihood: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  mitigation: string;
  owner?: string;
}

export interface ChartSpec {
  id: string;
  title: string;
  insight: string;               // the one-line takeaway printed under the chart
  kind: 'bar' | 'line' | 'donut' | 'radar' | 'matrix';
  // bar/line: one or more series over points (label,value).
  // donut: single series, points are segments.
  // radar: series over the same axis labels (0-10 values).
  // matrix: scatter on a 2D grid; value = x (0-10), value2 = y (0-10) — e.g. risk likelihood/impact.
  series: {
    name: string;
    color?: string;
    points: { label: string; value: number; value2?: number }[];
  }[];
  xLabel?: string;
  yLabel?: string;
  unit?: string;                 // '₹', '%', 'mo', ...
}

export interface TableSpec {
  id: string;
  title: string;
  columns: string[];
  rows: string[][];
  note?: string;
}

export interface RoadmapPhase {
  phase: string;                 // 'Phase 1 — Validate'
  timeframe: string;             // 'Weeks 0-6'
  actions: string[];
  owner?: string;
  dependencies?: string;
}

export interface ReportData {
  /**
   * Whose report this is — the name on the cover. FOUNDER_NAME when set;
   * never hardcoded.
   */
  preparedFor?: string;
  title: string;
  subtitle: string;
  generatedAtIso: string;        // ISO datetime string
  topic: string;                 // user's original paragraph
  goal: string;                  // approved goal statement
  model: string;
  mode: string;
  autonomy: string;
  panel: ReportPanelist[];
  stats: ReportStats;
  keyRecommendation: string;     // the single headline call
  executiveSummary: string[];    // 5-8 tight paragraphs
  decisions: DecisionTrail[];    // every major conclusion with its reasoning trail
  dissents: Dissent[];
  risks: Risk[];                 // ranked
  charts: ChartSpec[];
  tables: TableSpec[];
  roadmap: RoadmapPhase[];
  openQuestions: string[];       // what only the user can resolve, with panel's lean
  moderatorNote: string;         // Marcus's honest unfiltered worries, first person
  /**
   * Every figure the panel committed to, recomputed from the founder's source
   * files after the room closed. Written by the server, never by the report
   * writer: the whole point is that it is not subject to the same judgement
   * that produced the figures.
   */
  numbersAudit?: {
    checked: number;
    summary: string;
    findings: {
      figure: string;
      verdict: 'holds' | 'wrong' | 'uncheckable';
      recomputed: string;
      impact: string;
      /** Server-set: the figure came from a panelist's illustrative backstory, so it is an assumption. */
      origin?: 'persona';
    }[];
    /**
     * True when the audit itself failed after a retry. The distinction this
     * carries: a report whose figures were CHECKED and a report whose checker
     * CRASHED used to render identically, section silently absent — which is
     * how a transposed bridge shipped to a board. A failed audit now prints
     * "not verified" on the document's face instead of printing nothing.
     */
    failed?: boolean;
  };
  /**
   * Every source the research desk cited, written by the server from what the
   * tools returned (2b-4), never by the report writer. Absent on reports
   * written before research carried citations.
   */
  sources?: Citation[];
  /**
   * What was at stake, from the session's stakes (2b-6), server-written. Every
   * line the founder did not state is marked assumed and printed as assumed.
   */
  stakes?: ReportStakeLine[];
  /**
   * The dissent record (2b-6), server-written from the rulings: every standing
   * dissent with what would prove the dissenter right, by when, and what
   * ignoring them costs. A dissent recorded without those is printed, marked
   * incomplete. When present it replaces the writer's own `dissents` list.
   */
  minority?: ReportDissent[];
  /**
   * How minds changed (2b-6), one entry per motion, server-written from the
   * belief ledger: who moved, what moved them, what it cost, who held firm.
   */
  mindChanges?: ReportMindChange[];
  /**
   * What panelists told from their own invented careers (P1, evidence
   * honesty), server-written from the claims graded persona. Printed as
   * illustration, never as evidence about the founder's business; anything
   * the decision trails or the numbers audit built on one is labelled an
   * assumption.
   */
  personaClaims?: { expert: string; claim: string; figures: string[] }[];
}

export interface ReportStakeLine {
  label: string;
  value: string;
  /** Not stated by the founder: the room worked from a stated, conservative assumption. */
  assumed: boolean;
}

export interface ReportDissent {
  motionTitle: string;
  expert: string;
  position: string;
  reasoning: string;
  tripwire?: { signal: string; by: string };
  costOfIgnoring?: string;
  /** What this dissent lacks before it has teeth, in plain words. Empty when complete. */
  incomplete: string[];
}

export interface ReportMindChange {
  motionTitle: string;
  /** One sentence per expert who moved, then who held firm, the evidence that moved the room, herds. */
  lines: string[];
  concessions: number;
  /** Share of moves with a recorded cause (0..1). */
  causedShare: number;
  changedMinds: string[];
  heldFirm: string[];
}
