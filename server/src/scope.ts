import {
  DEPTH_ROUNDS, SCOPE_LIMITS,
  type BudgetProfile, type ComplexityRead, type Depth,
  type ScopeEstimate, type SessionScope,
} from '../../shared/types.ts';
import { modelFor, type Provider, type Seat } from '../../shared/models.ts';
import { BUDGET_PROFILES, TURN_COST } from '../../shared/budget.ts';

/**
 * How big a session should be, and what it will cost.
 *
 * This module exists because the model was doing arithmetic it is bad at. The
 * intake analyst is asked only for a judgement it can actually make (how many
 * separate decisions are in this ask, how many disciplines does arguing them
 * honestly require, how hard must each be pushed). Everything numeric after
 * that is computed here, so the founder is shown a figure someone can check
 * rather than a figure someone felt.
 *
 * The depth read SIZES the session and the profile SHAPES it: at most the
 * profile's panel and agenda, at least its rounds. The profile is a process
 * depth, not a spend limit, and nothing here caps spend: the estimate is
 * information. Every number belongs to shared/budget.ts.
 */

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

/**
 * Turn a read of the ask into a sized session, inside the profile's envelope.
 *
 * One motion per genuine decision, because a motion IS a decision; the old
 * "5-8 motions" range invented decisions to fill a quota. One expert per
 * discipline plus a small margin for the disagreement to be real: three people
 * who agree are not a panel, and a discipline with nobody to argue against is
 * a monologue.
 */
export function sizeSession(read: ComplexityRead, profile?: BudgetProfile | null): Omit<SessionScope, 'estimate'> {
  const spec = profile ? BUDGET_PROFILES[profile] : null;
  const motions = clamp(Math.min(read.decisions, spec?.maxMotions ?? Infinity), SCOPE_LIMITS.motions.min, SCOPE_LIMITS.motions.max);
  // Margin scales with the panel, not a flat +2: a three-discipline question
  // needs one more voice to be a debate, a ten-discipline one needs several.
  const experts = clamp(Math.min(read.disciplines * 1.25, spec?.maxExperts ?? Infinity), SCOPE_LIMITS.experts.min, SCOPE_LIMITS.experts.max);
  // The profile's own length caps the target too: a quick room asked for an exhaustive push still argues like a quick room (P2).
  const roundsPerMotion = clamp(
    Math.min(Math.max(DEPTH_ROUNDS[read.depth] ?? DEPTH_ROUNDS.standard, spec?.minRounds ?? 0), spec?.length.targetRounds ?? Infinity),
    SCOPE_LIMITS.rounds.min,
    SCOPE_LIMITS.rounds.max
  );
  const capped = spec && (read.decisions > spec.maxMotions || read.disciplines * 1.25 > spec.maxExperts + 0.5);
  return {
    experts, motions, roundsPerMotion, depth: read.depth,
    rationale: capped
      ? `${read.rationale} The ${spec!.label.toLowerCase()} room seats ${motions} motion${motions === 1 ? '' : 's'} and ${experts} experts; choose deep for the full shape.`.trim()
      : read.rationale,
  };
}

/**
 * Every agent turn a session of this shape is expected to spend, by role, on
 * today's round engine (each round is a slate of floor turns, a referee call
 * and a chair steer). Rewritten again for the floor director's turn mix in
 * 2b-7. A projection, not a limit.
 */
export function projectTurns(scope: Omit<SessionScope, 'estimate'>, hasDossier: boolean, profile?: BudgetProfile | null): Record<string, number> {
  const spec = profile ? BUDGET_PROFILES[profile] : null;
  const { experts, motions, roundsPerMotion: rounds } = scope;
  const seats = spec?.adversarySeats ?? 3;
  const reportSeats = spec?.reportAdversarySeats ?? 3;

  /**
   * The live floor (2b-7). A "round" is a checkpoint of about seven written
   * turns (set pieces and replies, flagship). Short reactions are free: they
   * come out of the reaction call, one fast call per set piece or contested
   * reply (about two in three turns). The chair checks in at each checkpoint
   * after the first and speaks on a trigger about once a checkpoint at most.
   */
  const perCheckpoint = 7;
  const checkpoints = motions * rounds;
  const floor = checkpoints * perCheckpoint;
  const interjection = Math.round(floor * 0.5);              // reaction turns spoken (no call of their own)
  const react = Math.round(floor * 0.65);
  const referee = checkpoints;
  const steer = motions * Math.max(0, rounds - 1) + Math.round(checkpoints * 0.5);   // check-ins, and chair lines on a trigger
  // When the adversary desk lands a defeater, the motion gets one more checkpoint
  // and a re-ruling. Assumed to happen on half the motions.
  const challenged = seats > 0 ? Math.round(motions * 0.5) : 0;
  const challengeTurns = Math.max(4, experts);

  return {
    // Setup. Fixed cost, paid once, and small.
    intake: 2,
    architect: 1,
    planning: 1,
    dossier: hasDossier ? 1 : 0,
    research: Math.min(3, spec?.researchCap ?? 3),
    cards: experts + 1,                          // one position card each, plus the consensus check
    persona: experts + 1,                        // one dossier each, plus the relationships pass
    // The meeting. This is the bill.
    floor: floor + challenged * challengeTurns + motions,   // plus about one wind-down turn a motion
    interjection: 0,                             // short reactions ride in the reaction call
    reactionTurns: interjection,
    react: react + motions,                      // plus one clerk call a motion (starting stances)
    lint: Math.round(floor * 0.25),
    referee,
    steer: steer + challenged,
    ruling: motions + challenged,
    adversary: motions * seats,
    // Closing out.
    closing: experts,
    audit: hasDossier ? 1 : 0,
    report: 1 + (reportSeats > 0 ? 1 : 0),       // the report, and its revision when attacked
    reportAdversary: reportSeats,
  };
}

/** Turns whose context is small and bounded, so they sit at the low end whatever the panel. */
const LIGHT_ROLES = new Set(['referee', 'research', 'summon', 'cards']);

/** Which seat each projected turn runs on. */
const ROLE_SEAT: Record<string, Seat> = {
  intake: 'chair',
  architect: 'chair',
  planning: 'chair',
  steer: 'chair',
  dossier: 'dossier',
  research: 'research',
  cards: 'floor',
  persona: 'persona',
  floor: 'floor',
  interjection: 'floor',
  react: 'react',
  lint: 'lint',
  closing: 'floor',
  referee: 'referee',
  ruling: 'ruling',
  adversary: 'floor',
  reportAdversary: 'floor',
  audit: 'quant',
  report: 'report',
};

/**
 * An uncalibrated cost projection for a session of this shape.
 * INFORMATION ONLY: no limit is applied, and a hard call that needs more
 * argument gets it. The founder's own ceiling, when set, is stated beside it.
 */
export function estimateCost(
  scope: Omit<SessionScope, 'estimate'>,
  provider: Provider,
  hasDossier: boolean,
  profile?: BudgetProfile | null,
  ceilingUsd?: number | null
): ScopeEstimate {
  const turns = projectTurns(scope, hasDossier, profile);
  let total = 0;
  // Reaction turns are spoken but cost no call of their own (they come out of the reaction call).
  for (const [role, count] of Object.entries(turns)) if (role !== 'reactionTurns') total += count;
  const ceiling = provider === 'codex' ? null : ceilingUsd ?? null;
  const tail = ceiling !== null
    ? ` No limit is applied by the app; you set a $${ceiling.toFixed(2)} ceiling, and if the room reaches it you will be asked whether to extend it. Nothing is cut either way.`
    : ' No limit is applied: the room argues until the calls are settled, and the closing statements and report always happen.';
  const shape = profile ? { profile } : {};

  if (provider === 'codex') {
    return {
      turns: total,
      lowUsd: 0,
      highUsd: 0,
      basis: `Typically about ${total} agent turns, run through Codex on your ChatGPT subscription. There is no per-token bill, so there is no dollar figure. What this uses is your plan's rolling usage window; if it runs out part-way the session pauses and resumes by itself when the window resets. Turns run one at a time on this door, so expect it to take noticeably longer than on Claude.${tail}`,
      ...shape,
      ceilingUsd: null,
    };
  }

  let low = 0;
  let high = 0;
  for (const [role, count] of Object.entries(turns)) {
    if (!count || role === 'reactionTurns') continue;
    const model = modelFor(provider, ROLE_SEAT[role] ?? 'chair');
    const band = TURN_COST[model] ?? { low: 0, high: 0 };
    low += count * band.low;
    high += count * (LIGHT_ROLES.has(role) ? band.low : band.high);
  }
  const lowUsd = Math.round(low * 100) / 100;
  const highUsd = Math.round(high * 100) / 100;
  const range = `$${lowUsd.toFixed(2)}-${highUsd.toFixed(2)}`;

  return {
    turns: total,
    lowUsd,
    highUsd,
    basis: (provider === 'claude'
      ? `Uncalibrated estimate: ${range} in plan equivalent (about ${total} agent turns priced at API list rates). Actual usage can be much higher, especially for research. On a Claude subscription login this is usage from your plan rather than a bill; if the 5-hour window runs out the session pauses and resumes by itself when it resets.`
      : provider === 'anthropic'
      ? `Uncalibrated estimate: ${range}, billed to your Claude API key at Anthropic's list rates (about ${total} agent turns). Actual spend can be much higher, especially for research. The live spend is shown in the room.`
      : `Uncalibrated estimate: ${range}, billed to your OpenAI API key at list rates (about ${total} agent turns; reasoning tokens bill as output). Actual spend can be much higher, especially for research. The live spend is shown in the room.`) + tail,
    ...shape,
    ceilingUsd: ceiling,
  };
}

/** Size and price in one step. */
export function scopeFrom(read: ComplexityRead, provider: Provider, hasDossier: boolean, profile?: BudgetProfile | null, ceilingUsd?: number | null): SessionScope {
  const sized = sizeSession(read, profile);
  return { ...sized, estimate: estimateCost(sized, provider, hasDossier, profile, ceilingUsd) };
}

/**
 * Accept a founder's edit without letting it become nonsense. They may dial
 * any dimension inside the profile; they may not ask for a one-expert panel
 * or a forty-motion agenda.
 */
export function reviseScope(
  scope: SessionScope,
  patch: Partial<Pick<SessionScope, 'experts' | 'motions' | 'roundsPerMotion' | 'depth'>>,
  provider: Provider,
  hasDossier: boolean,
  profile?: BudgetProfile | null,
  ceilingUsd?: number | null
): SessionScope {
  const spec = profile ? BUDGET_PROFILES[profile] : null;
  const next = {
    ...scope,
    experts: clamp(Math.min(patch.experts ?? scope.experts, spec?.maxExperts ?? Infinity), SCOPE_LIMITS.experts.min, SCOPE_LIMITS.experts.max),
    motions: clamp(Math.min(patch.motions ?? scope.motions, spec?.maxMotions ?? Infinity), SCOPE_LIMITS.motions.min, SCOPE_LIMITS.motions.max),
    roundsPerMotion: clamp(
      patch.roundsPerMotion ?? (patch.depth ? DEPTH_ROUNDS[patch.depth] : scope.roundsPerMotion),
      SCOPE_LIMITS.rounds.min,
      SCOPE_LIMITS.rounds.max
    ),
    depth: (patch.depth ?? scope.depth) as Depth,
  };
  return { ...next, estimate: estimateCost(next, provider, hasDossier, profile, ceilingUsd) };
}
