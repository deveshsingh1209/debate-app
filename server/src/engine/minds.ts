/**
 * Glue between the engine and the pure realism modules (server/src/realism/):
 * the small translations the runner needs and nothing else. Pure, so it is
 * tested without a model (minds.selftest.ts).
 *
 *   trailer STANCE line  -> the ledger's StanceReport
 *   ledger flags         -> one line each for the chair
 *   diversity report     -> plain problems for the founder at panel approval
 */
import type { Decision, DiversityFlag, Dossier, Stance } from '../../../shared/types.ts';
import type { ReportDissent, ReportMindChange, ReportStakeLine } from '../../../shared/report-types.ts';
import { mindChanges, parseStanceLine, renderMindChanges, STANCE_LABEL, type LedgerFlag, type LedgerState, type StanceReport } from '../realism/ledger.ts';
import { minorityReport, stakesBlock, type DissentProblem, type MarkedStakes } from '../realism/stakes.ts';
import type { DiversityReport } from '../realism/dossier.ts';
import type { Trailer } from './trailer.ts';

/**
 * The ledger's reading of a turn's STANCE line. The trailer parser is the
 * tolerant one for the stance itself ("neutral 0", "against 2"); the ledger's
 * parser adds what moved them, what it cost and the kind of move.
 */
export function stanceReport(trailer: Trailer): StanceReport | null {
  if (!trailer.stance) return null;
  const rest = (trailer.stanceRaw ?? '').split('|').slice(1).join('|');
  const extra = parseStanceLine(`0${rest ? ` | ${rest}` : ''}`);
  return {
    ...(extra ?? {}),
    stance: trailer.stance.stance,
    confidence: trailer.stance.confidence,
    ...(trailer.stance.crux ? { crux: trailer.stance.crux } : {}),
  } as StanceReport;
}

/**
 * A ledger chair trigger as one line for the chair's prompt. Describes what
 * happened, never the words to say about it (prompt de-seeding).
 */
export function triggerLine(f: LedgerFlag, nameOf: (id: string) => string): string | null {
  switch (f.kind) {
    case 'unexplained_move':
      return `${nameOf(f.expert)} moved on the motion and gave no reason, and ${nameOf(f.expert)} is someone who should need one. Ask what moved them.`;
    case 'weak_cause':
      return `${nameOf(f.expert)} moved for a reason (${f.cause}) that should not move someone that firm. Test it.`;
    case 'herd':
      return `${f.experts.map(nameOf).join(', ')} all moved ${f.direction > 0 ? 'toward the motion' : 'against it'} with no new evidence in between. The room is herding: attack the new consensus.`;
    case 'drift_to_middle':
      return `The room has drifted to the middle (average conviction ${f.from.toFixed(1)} down to ${f.to.toFixed(1)}) without anything settling it. Make someone take a side.`;
    default:
      return null;
  }
}

const stanceWord = (s: number) => STANCE_LABEL[Math.max(-2, Math.min(2, Math.round(s))) as Stance];
export { stanceWord };

/** The diversity check, as the founder reads it at panel approval. */
export function diversityFlag(report: DiversityReport | null, regenerated: string[], missing: string[], nameOf: (id: string) => string): DiversityFlag {
  const problems: string[] = [];
  if (missing.length) problems.push(`No dossier could be written for ${missing.map(nameOf).join(', ')}; they argue from their profile alone.`);
  for (const f of report?.failures ?? []) {
    const who = f.who.map(nameOf).join(' and ');
    switch (f.rule) {
      case 'registers': problems.push(`Too many of the panel talk the same way (${who}).`); break;
      case 'length_spread': problems.push('Nobody on the panel is much terser or wordier than the rest.'); break;
      case 'vocabulary_overlap': problems.push(`${who} share too much of the same vocabulary.`); break;
      case 'stubbornness_low': problems.push('Nobody on the panel is easy to persuade.'); break;
      case 'stubbornness_high': problems.push('Nobody on the panel is hard to persuade.'); break;
      case 'opposed_incentives': problems.push('Too few experts have personal stakes pulling opposite ways on the goal.'); break;
      case 'bias_overlap': problems.push(`${who} have near-identical biases.`); break;
      case 'incentive_overlap': problems.push(`${who} stand to gain or lose the same things.`); break;
      case 'pressure_overlap': problems.push(`${who} react to pressure the same way.`); break;
      case 'shared_tic': problems.push(`${who} share a verbal habit.`); break;
    }
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)], regenerated };
}

// ---------- the report's server-written sections (2b-6) ----------

const PROBLEM_WORDS: Record<DissentProblem, string> = {
  no_tripwire: 'no tripwire: nothing named that would prove the dissenter right',
  vague_signal: 'the tripwire is too vague to watch for',
  no_deadline: 'no date or occasion by which it would show',
  no_cost: 'no cost of ignoring it',
};

/** The stakes as report lines, assumed ones marked. */
export function stakesLines(m: MarkedStakes | null | undefined): ReportStakeLine[] | undefined {
  if (!m) return undefined;
  const s = m.stakes;
  const f = m.fields;
  const risk = (['money', 'people', 'time', 'reputation'] as const).filter((k) => s.atRisk[k]).map((k) => `${k}: ${s.atRisk[k]}`).join('; ');
  return [
    { label: 'Decision owner', value: `${s.decisionOwner.name}, ${s.decisionOwner.role}`, assumed: f.decisionOwner === 'assumed' },
    { label: 'Decide by', value: s.decideBy, assumed: f.decideBy === 'assumed' },
    { label: 'At risk', value: risk || 'not stated', assumed: f.atRisk === 'assumed' },
    { label: 'If a wrong yes', value: s.ifWrong.yes, assumed: f.ifWrong === 'assumed' },
    { label: 'If a wrong no', value: s.ifWrong.no, assumed: f.ifWrong === 'assumed' },
    { label: 'Can it be undone', value: s.reversibility === 'one-way' ? 'No: a one-way door' : 'Yes: a two-way door', assumed: f.reversibility === 'assumed' },
  ];
}

/** Every dissent on every ruling, with its tripwire, or marked incomplete. Undefined when nothing was ruled. */
export function dissentRecord(decisions: readonly Decision[]): ReportDissent[] | undefined {
  if (!decisions.length) return undefined;
  return minorityReport(decisions).map((e) => ({
    motionTitle: e.motionTitle,
    expert: e.expert,
    position: e.position,
    reasoning: e.reasoning,
    ...(e.tripwire ? { tripwire: e.tripwire } : {}),
    ...(e.costOfIgnoring ? { costOfIgnoring: e.costOfIgnoring } : {}),
    incomplete: e.problems.map((p) => PROBLEM_WORDS[p]),
  }));
}

/** "How minds changed", per ruled motion, from the ledger. Undefined for a debate without one. */
export function mindChangeSections(ledger: LedgerState | null | undefined, motions: { id: string; title: string }[], order: string[], nameOf: (id: string) => string): ReportMindChange[] | undefined {
  if (!ledger) return undefined;
  const out: ReportMindChange[] = [];
  for (const m of motions) {
    if (!ledger.motions[m.id]) continue;
    const sum = mindChanges(ledger, m.id, order);
    out.push({
      motionTitle: m.title,
      lines: renderMindChanges(sum, nameOf).split('\n').filter(Boolean),
      concessions: sum.concessions,
      causedShare: sum.causedShare,
      changedMinds: sum.changedMinds.map(nameOf),
      heldFirm: sum.heldFirm.map(nameOf),
    });
  }
  return out.length ? out : undefined;
}

/** The three sections as text for the report writer's material, so the prose can lean on them. */
export function realismMaterial(stakes: MarkedStakes | null | undefined, minds: ReportMindChange[] | undefined, dissents: ReportDissent[] | undefined): string {
  const parts: string[] = [];
  if (stakes) parts.push(`WHAT WAS AT STAKE (the report prints this itself; assumed means the founder did not state it):\n${stakesBlock(stakes)}`);
  if (minds?.length) parts.push(`HOW MINDS CHANGED (from the speakers' own stance records; the report prints this itself, so refer to it rather than restating it):\n${minds.map((m) => `${m.motionTitle}:\n${m.lines.join('\n')}`).join('\n\n')}`);
  if (dissents?.length) {
    parts.push(`THE DISSENT RECORD (printed by the report itself, with each tripwire):\n${dissents.map((d) => `- ${d.motionTitle}: ${d.expert}: ${d.position}${d.tripwire ? ` Proves them right: ${d.tripwire.signal} (by ${d.tripwire.by}).` : ''}${d.costOfIgnoring ? ` Cost of ignoring: ${d.costOfIgnoring}` : ''}`).join('\n')}`);
  }
  return parts.join('\n\n====\n\n');
}

/** A dossier's public line, by persona id, for the shared roster and the panel event. */
export function reputations(dossiers: Record<string, Dossier> | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, d] of Object.entries(dossiers ?? {})) if (d.publicReputation) out[id] = d.publicReputation;
  return out;
}
