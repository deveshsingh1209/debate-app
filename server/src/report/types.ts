/**
 * DEBATE report — the renderer's own extended data contract.
 *
 * `shared/report-types.ts` is owned by the lead and is NOT edited here.
 * This file layers the deeper-engine fields on top of `ReportData` so the
 * renderer can build a firm-grade deliverable from an exhaustive session
 * (5-10 formal motions, 300-600 messages) while still rendering a v1
 * payload that carries none of them.
 *
 * GRACEFUL DEGRADATION IS A HARD RULE HERE.
 * Every field added below is optional. `normalize()` fills the gaps by
 * deriving what it can from v1 data and marking the rest absent, and
 * `sectionPlan()` drops sections that would otherwise render empty. A
 * plain `ReportData` is a valid `FullReport`.
 *
 * NAMING NOTE FOR THE LEAD — `ReportData.decisions` is already taken by
 * `DecisionTrail[]` (the narrative reasoning trail: proposedBy /
 * supportedBy / challengedBy / resolution). The engine's formal
 * `Decision[]` from shared/types.ts is a different shape, so it lands on
 * `decisionRegister` rather than colliding. Populate BOTH: the register
 * carries the ruling, owner, evidence grade, dissents and undecidable;
 * the trail carries the argument. `buildDossiers()` marries them into one
 * numbered dossier per motion.
 */

import type { Decision, EvidenceGrade } from '../../../shared/types.ts';
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

export type { Decision, EvidenceGrade };

/* ------------------------------------------------------------------ */
/* New payload shapes                                                  */
/* ------------------------------------------------------------------ */

/** One graded behavioural claim. The evidence register is built from these. */
export interface EvidenceEntry {
  /** The claim exactly as the panel relied on it. */
  claim: string;
  /** How well it is grounded. Drives the colour-coded badge. */
  grade: EvidenceGrade;
  /** Where it came from: a named expert, a research task, a document. */
  source: string;
  /** Motion this claim was load-bearing for. Links the row to a dossier. */
  motionId?: string;
}

/** A question the room could not settle, and what would settle it. */
export interface Undecidable {
  question: string;
  evidenceNeeded: string;
  owner: string;
  /** Motion it surfaced under, when it belongs to one. */
  motionId?: string;
}

/** A verbatim line lifted from the transcript, attributed. */
export interface KeyExchange {
  speaker: string;
  quote: string;
}

/** Per-motion proceedings for the appendix. */
export interface AppendixMotion {
  motionId: string;
  title: string;
  motion: string;
  rounds: number;
  keyExchanges: KeyExchange[];
}

/**
 * Numeric gates per roadmap phase. `RoadmapPhase` (shared, not editable)
 * has no place for these, so they ride alongside and are matched on
 * `phase`, falling back to positional order.
 */
export interface PhaseGate {
  phase: string;
  successConditions: string[];
  killCriteria: string[];
}

/**
 * The full payload. Everything beyond `ReportData` is optional so a v1
 * report still type-checks and still renders.
 */
export interface FullReport extends ReportData {
  /** Formal per-motion rulings from the exhaustive engine. */
  decisionRegister?: Decision[];
  /** Every behavioural claim the case rests on, graded. */
  evidenceRegister?: EvidenceEntry[];
  /** What the room could not settle, and who is getting the evidence. */
  undecidables?: Undecidable[];
  /** Per-motion argument summaries with verbatim exchanges. */
  appendix?: AppendixMotion[];
  /** Numeric success conditions and kill criteria per roadmap phase. */
  roadmapGates?: PhaseGate[];
  /** Who the work was done for. Falls back to the goal's subject. */
  client?: string;
  /** Engagement reference printed on the cover, e.g. 'DBT-2026-014'. */
  engagementRef?: string;
}

/* ------------------------------------------------------------------ */
/* Evidence grades                                                     */
/* ------------------------------------------------------------------ */

export const GRADES: EvidenceGrade[] = ['measured', 'observed', 'mixed', 'assumed', 'persona'];

export interface GradeMeta {
  key: EvidenceGrade;
  label: string;
  /** Ordinal confidence rank, 0 = strongest. Drives sort order. */
  rank: number;
  /** What the grade asserts, printed in the register key. */
  gloss: string;
}

/**
 * Ordered strongest to weakest. The renderer paints these with the
 * reserved status ramp (good / warning / serious / critical) and always
 * pairs the colour with the word and a CSS-drawn glyph, so evidence
 * strength is never carried by colour alone.
 */
export const GRADE_META: Record<EvidenceGrade, GradeMeta> = {
  measured: { key: 'measured', label: 'Measured', rank: 0, gloss: 'A number someone recorded. Auditable.' },
  observed: { key: 'observed', label: 'Observed', rank: 1, gloss: 'A fact the founder supplied, or a cited research finding.' },
  mixed: { key: 'mixed', label: 'Mixed', rank: 2, gloss: 'Part evidence, part inference from an adjacent case.' },
  assumed: { key: 'assumed', label: 'Assumed', rank: 3, gloss: 'Asserted and untested. The case rests on it anyway.' },
  persona: { key: 'persona', label: 'Persona experience', rank: 4, gloss: "A panelist's illustrative backstory. Not evidence about this business." },
};

export function gradeMeta(g: EvidenceGrade | undefined): GradeMeta | undefined {
  return g ? GRADE_META[g] : undefined;
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

/** Coerce a value the engine may emit as a string or an array of strings. */
export function toList(v: string | string[] | undefined | null): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  const s = String(v).trim();
  return s ? [s] : [];
}

function arr<T>(v: T[] | undefined | null): T[] {
  return Array.isArray(v) ? v.filter((x) => x != null) : [];
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.trim() ? v : fallback;
}

/** Motion reference label: D-01, D-02, ... */
export function dossierRef(i: number): string {
  return `D-${String(i + 1).padStart(2, '0')}`;
}

/**
 * One motion's complete record: the formal ruling married to the
 * narrative argument that produced it. This is the spine of the report.
 */
export interface Dossier {
  ref: string;
  motionId: string;
  /** Short label for the motion. */
  title: string;
  /** The proposition as put to the room. Absent on v1 data. */
  motion?: string;
  /** The ruling. */
  decision: string;
  /** Named human owner. */
  owner?: string;
  evidence?: EvidenceGrade;
  /** What settled it. */
  rationale: string;
  proposedBy?: string;
  supportedBy: { expert: string; argument: string }[];
  challengedBy: { expert: string; objection: string }[];
  dependsOn: string[];
  dissents: { expert: string; position: string; reasoning: string }[];
  undecidables: Undecidable[];
  userInput?: string;
  /** Evidence rows the engine tied to this motion. */
  evidenceRows: EvidenceEntry[];
  /** Appendix proceedings for this motion, when supplied. */
  proceedings?: AppendixMotion;
}

function keyOf(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Marry `decisionRegister` (formal) to `decisions` (narrative trail).
 *
 * Matching order: explicit motionId, then normalised title equality, then
 * position. Either source alone is enough to produce a dossier, so a v1
 * report yields a full register built from trails, and an engine payload
 * that ships rulings before the analyst has written trails still renders.
 */
export function buildDossiers(data: FullReport): Dossier[] {
  const rulings = arr(data.decisionRegister);
  const trails = arr(data.decisions);
  const evidence = arr(data.evidenceRegister);
  const appendix = arr(data.appendix);
  const loose = arr(data.undecidables);

  const usedTrail = new Set<number>();
  const findTrail = (d: Decision, i: number): DecisionTrail | undefined => {
    const want = keyOf(str(d.motionTitle));
    let idx = trails.findIndex((t, j) => !usedTrail.has(j) && want && keyOf(str(t.topic)) === want);
    if (idx < 0 && !usedTrail.has(i) && trails[i]) idx = i;
    if (idx < 0) return undefined;
    usedTrail.add(idx);
    return trails[idx];
  };

  const out: Dossier[] = [];

  if (rulings.length) {
    rulings.forEach((d, i) => {
      const t = findTrail(d, i);
      const motionId = str(d.motionId, `m${i + 1}`);
      out.push({
        ref: dossierRef(i),
        motionId,
        title: str(d.motionTitle, str(t?.topic, `Motion ${i + 1}`)),
        motion: str(d.motionTitle) && str((d as { motion?: string }).motion) ? String((d as { motion?: string }).motion) : undefined,
        decision: str(d.decision, str(t?.conclusion)),
        owner: str(d.owner) || undefined,
        evidence: d.evidence,
        rationale: str(d.rationale, str(t?.resolution)),
        proposedBy: str(t?.proposedBy) || undefined,
        supportedBy: arr(t?.supportedBy),
        challengedBy: arr(t?.challengedBy),
        dependsOn: toList(d.dependsOn).length ? toList(d.dependsOn) : toList(t?.dependsOn),
        dissents: arr(d.dissents),
        undecidables: [
          ...(d.undecidable && str(d.undecidable.question)
            ? [{ question: d.undecidable.question, evidenceNeeded: str(d.undecidable.evidenceNeeded), owner: str(d.undecidable.who, 'Unassigned'), motionId }]
            : []),
          ...loose.filter((u) => u.motionId && u.motionId === motionId),
        ],
        userInput: str(t?.userInput) || undefined,
        evidenceRows: evidence.filter((e) => e.motionId && e.motionId === motionId),
        proceedings: appendix.find((a) => a.motionId === motionId),
      });
    });
    // Trails the engine never ruled on still deserve a dossier.
    trails.forEach((t, j) => {
      if (usedTrail.has(j)) return;
      out.push(trailDossier(t, out.length, evidence, appendix, loose));
    });
    return out.map((d, i) => ({ ...d, ref: dossierRef(i) }));
  }

  return trails.map((t, i) => trailDossier(t, i, evidence, appendix, loose));
}

function trailDossier(
  t: DecisionTrail,
  i: number,
  evidence: EvidenceEntry[],
  appendix: AppendixMotion[],
  loose: Undecidable[],
): Dossier {
  const motionId = `m${i + 1}`;
  return {
    ref: dossierRef(i),
    motionId,
    title: str(t.topic, `Motion ${i + 1}`),
    decision: str(t.conclusion),
    rationale: str(t.resolution),
    proposedBy: str(t.proposedBy) || undefined,
    supportedBy: arr(t.supportedBy),
    challengedBy: arr(t.challengedBy),
    dependsOn: toList(t.dependsOn),
    dissents: [],
    undecidables: loose.filter((u) => u.motionId === motionId),
    userInput: str(t.userInput) || undefined,
    evidenceRows: evidence.filter((e) => e.motionId === motionId),
    proceedings: appendix.find((a) => a.motionId === motionId),
  };
}

/** Undecidables not claimed by any dossier, so nothing is silently dropped. */
export function looseUndecidables(data: FullReport, dossiers: Dossier[]): Undecidable[] {
  const claimed = new Set(dossiers.flatMap((d) => d.undecidables.map((u) => u.question)));
  return arr(data.undecidables).filter((u) => !claimed.has(u.question));
}

/** Every undecidable in the report, dossier-owned first. */
export function allUndecidables(data: FullReport, dossiers: Dossier[]): Undecidable[] {
  return [...dossiers.flatMap((d) => d.undecidables), ...looseUndecidables(data, dossiers)];
}

/** Grade counts across the evidence register, strongest first. */
export function gradeTally(rows: EvidenceEntry[]): { grade: EvidenceGrade; count: number; pct: number }[] {
  const total = rows.length || 1;
  return GRADES.map((g) => {
    const count = rows.filter((r) => r.grade === g).length;
    return { grade: g, count, pct: (count / total) * 100 };
  });
}

/** Match a phase's numeric gates, by name then by position. */
export function gatesFor(data: FullReport, phase: RoadmapPhase, i: number): PhaseGate | undefined {
  const gates = arr(data.roadmapGates);
  if (!gates.length) return undefined;
  const want = keyOf(str(phase.phase));
  return gates.find((g) => keyOf(str(g.phase)) === want) || gates[i];
}

/* ------------------------------------------------------------------ */
/* Section plan                                                        */
/* ------------------------------------------------------------------ */

export type SectionId =
  | 'summary'
  | 'scope'
  | 'decisions'
  | 'dissents'
  | 'analysis'
  | 'evidence'
  | 'risks'
  | 'roadmap'
  | 'questions'
  | 'moderator'
  | 'appendix';

export interface SectionDef {
  id: SectionId;
  /** '01'..'10', or 'A' for the appendix. */
  num: string;
  /** Heading printed in the document. */
  heading: string;
  /** Short label for the top nav. */
  nav: string;
  /** One line under the heading, for the contents page. */
  blurb: string;
}

const ALL: Omit<SectionDef, 'num'>[] = [
  { id: 'summary', heading: 'Executive Summary', nav: 'Summary', blurb: 'The call, the reasoning, the risks and the ask, readable on its own.' },
  { id: 'scope', heading: 'Scope and Method', nav: 'Scope', blurb: 'The mandate, the panel that argued it, and how the session was run.' },
  { id: 'decisions', heading: 'Decision Register', nav: 'Decisions', blurb: 'One dossier per motion: the ruling, its owner, what settled it, and who still disagrees.' },
  { id: 'dissents', heading: 'Dissenting Opinions', nav: 'Dissents', blurb: 'Minority positions recorded in full, unreconciled.' },
  { id: 'analysis', heading: 'Analysis', nav: 'Analysis', blurb: 'The quantitative case, each exhibit carrying its own finding.' },
  { id: 'evidence', heading: 'Evidence Register', nav: 'Evidence', blurb: 'Every behavioural claim the case rests on, graded measured to assumed.' },
  { id: 'risks', heading: 'Risk Register', nav: 'Risks', blurb: 'Ranked exposures with likelihood, impact, mitigation and owner.' },
  { id: 'roadmap', heading: 'Execution Roadmap', nav: 'Roadmap', blurb: 'Phased plan with numeric success conditions and explicit kill criteria.' },
  { id: 'questions', heading: 'Open Questions and Undecidables', nav: 'Open Qs', blurb: 'What the room could not settle, and the evidence that would settle it.' },
  { id: 'moderator', heading: "Moderator's Note", nav: 'Moderator', blurb: 'Unfiltered closing worries from the chair, signed.' },
  { id: 'appendix', heading: 'Appendix: Motion Proceedings', nav: 'Appendix', blurb: 'Per-motion argument summaries with verbatim exchanges from the floor.' },
];

/**
 * Which sections this payload can actually fill. Sections with no data are
 * dropped from the contents and the body rather than rendering an empty
 * shell, which is what keeps a v1 payload looking deliberate.
 */
export function sectionPlan(data: FullReport, dossiers: Dossier[]): SectionDef[] {
  const has: Record<SectionId, boolean> = {
    summary: true,
    scope: true,
    decisions: dossiers.length > 0,
    dissents: arr(data.dissents).length > 0 || dossiers.some((d) => d.dissents.length > 0),
    analysis: arr(data.charts).length > 0 || arr(data.tables).length > 0,
    evidence: arr(data.evidenceRegister).length > 0,
    risks: arr(data.risks).length > 0,
    roadmap: arr(data.roadmap).length > 0,
    questions: arr(data.openQuestions).length > 0 || allUndecidables(data, dossiers).length > 0,
    moderator: Boolean(str(data.moderatorNote)),
    appendix: arr(data.appendix).length > 0,
  };
  let n = 0;
  return ALL.filter((s) => has[s.id]).map((s) => {
    const num = s.id === 'appendix' ? 'A' : String(++n).padStart(2, '0');
    return { ...s, num };
  });
}

/* ------------------------------------------------------------------ */
/* Re-exports the renderer leans on                                    */
/* ------------------------------------------------------------------ */

export type { ChartSpec, DecisionTrail, Dissent, ReportData, ReportPanelist, Risk, RoadmapPhase, TableSpec };
