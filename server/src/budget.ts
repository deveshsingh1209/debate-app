/**
 * The spend meter, the profile pick and the optional ceiling. Pure functions,
 * tested without a model (budget.selftest.ts).
 *
 * Owner decision (Oct 2026): quality over cost. Nothing here stops, shortens
 * or thins a debate. The meter is information (estimate vs actual); the
 * profile is a process shape chosen by how hard the call is; the only dollar
 * line is a ceiling the founder sets themselves, and reaching it asks them to
 * extend rather than cutting the argument. Every number lives in
 * shared/budget.ts.
 */
import { AUTO_DEEP, BUDGET_PROFILES, CEILING, DEFAULT_PROFILE, QUOTA, isProfile } from '../../shared/budget.ts';
import type { BudgetProfile, BudgetSnapshot, ComplexityRead, DebateConfig, MeetingClock } from '../../shared/types.ts';
import type { Provider } from '../../shared/models.ts';

/** What has been spent so far. */
export interface BudgetLedger {
  usd: number;
  output: number;
  flagshipCalls: number;
  calls: number;
  /** Spoken expert turns (floor and interjection; closings excluded). */
  turns: number;
}

/** How a debate's dollars should be read. */
export function billingOf(provider: Provider): NonNullable<BudgetSnapshot['billing']> {
  // Both API keys are real pay-per-use money; the two logins spend a plan.
  return provider === 'openai' || provider === 'anthropic' ? 'payg' : provider === 'codex' ? 'none' : 'plan';
}

/**
 * The meter's reading. Information only.
 * `expectedTurns` is the session's projected spoken turns (from the scope),
 * used to carry the rate so far to a projected final spend; before anyone has
 * spoken, the middle of the pre-debate estimate stands in.
 */
export function budgetSnapshot(
  profile: BudgetProfile,
  provider: Provider,
  led: BudgetLedger,
  opts: { expectedTurns?: number; estimate?: { lowUsd: number; highUsd: number }; ceilingUsd?: number | null; clock?: MeetingClock } = {},
): BudgetSnapshot {
  const round2 = (x: number) => Math.round(x * 100) / 100;
  const billing = billingOf(provider);
  const est = opts.estimate;
  const mid = est ? (est.lowUsd + est.highUsd) / 2 : 0;
  const expected = Math.max(led.turns, opts.expectedTurns ?? led.turns);
  const projected = billing === 'none' ? 0 : led.turns > 0 ? (led.usd / led.turns) * expected : Math.max(led.usd, mid);
  const ceiling = billing === 'none' ? null : opts.ceilingUsd ?? null;
  return {
    profile,
    spentUsd: round2(led.usd),
    outputTokens: led.output,
    flagshipCalls: led.flagshipCalls,
    calls: led.calls,
    turns: led.turns,
    projectedUsd: round2(projected),
    ...(est ? { estimateLowUsd: est.lowUsd, estimateHighUsd: est.highUsd } : {}),
    billing,
    ceilingUsd: ceiling,
    state: ceiling !== null && led.usd >= ceiling ? 'ceiling' : 'ok',
    ...(opts.clock ? { clock: opts.clock } : {}),
  };
}

// ---------- the profile ----------

/**
 * The profile a debate runs as, or null for a debate created before profiles
 * existed (those run exactly as they always did). The founder's or the
 * intake's pick, persisted in meta, wins over the setup choice; 'auto' runs
 * as the default until the intake has read the ask.
 */
export function profileOf(config: Pick<DebateConfig, 'profile'>, pick?: { profile: BudgetProfile } | null): BudgetProfile | null {
  if (pick && isProfile(pick.profile)) return pick.profile;
  if (config.profile === 'auto') return DEFAULT_PROFILE;
  return isProfile(config.profile) ? config.profile : null;
}

/**
 * 'auto': hard or high-stakes calls get the full debate. Deterministic rules
 * over the intake's own read (its depth is the model's difficulty signal) and
 * the founder's brief. Never picks quick.
 */
export function pickProfile(read: ComplexityRead, topic: string): { profile: BudgetProfile; reason: string } {
  const std = BUDGET_PROFILES.standard;
  if ((AUTO_DEEP.depths as readonly string[]).includes(read.depth)) {
    return { profile: 'deep', reason: 'The intake judged this a call that has to be pushed as hard as possible, so it gets the deep room.' };
  }
  if (read.decisions > AUTO_DEEP.decisionsAbove) {
    return { profile: 'deep', reason: `${read.decisions} separate decisions are more than the standard room's ${std.maxMotions} motions, so it gets the deep room rather than dropping any.` };
  }
  if (read.disciplines > AUTO_DEEP.disciplinesAbove) {
    return { profile: 'deep', reason: `${read.disciplines} disciplines need more voices than the standard room's ${std.maxExperts}, so it gets the deep room rather than a thinner panel.` };
  }
  const stakes = read.depth !== 'quick' ? topic.match(AUTO_DEEP.stakes) : null;
  if (stakes) {
    return { profile: 'deep', reason: `The brief reads as high-stakes ("${stakes[0].trim()}"), so it gets the deep room.` };
  }
  return { profile: DEFAULT_PROFILE, reason: 'A contained call: the standard room argues it fully.' };
}

// ---------- quota pauses ----------

/**
 * When a session parked on a spent allowance tries again: just after the reset
 * the provider stated, else on a doubling backoff with a cap, so a window that
 * reset early is noticed within the hour.
 */
export function nextLimitTry(lp: { resetAt: number | null; attempts: number }, now = Date.now()): number {
  if (lp.resetAt) return Math.max(now + QUOTA.minWaitMs, lp.resetAt + QUOTA.afterResetMs);
  const backoff = Math.min(QUOTA.maxBackoffMs, QUOTA.firstBackoffMs * 2 ** Math.max(0, lp.attempts - 1));
  return now + Math.max(QUOTA.minWaitMs, backoff);
}

// ---------- the optional ceiling ----------

/** The ceiling in force: an extension wins, then the debate's own, then BUDGET_CEILING_USD. Null: no limit. */
export function ceilingOf(provider: Provider, extended: number | null | undefined, own: number | null | undefined, env: number | null): number | null {
  if (provider === 'codex') return null;   // no per-token dollars to hold it against
  const v = extended ?? own ?? env;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** One click raises the ceiling by half (at least $5) above whatever is already spent. */
export function extendCeiling(ceiling: number, spent: number): number {
  const step = Math.max(CEILING.extendMinUsd, ceiling * CEILING.extendShare);
  return Math.round((Math.max(ceiling, spent) + step) * 100) / 100;
}

export const CEILING_EXTEND = 'Extend and carry on';
export const CEILING_STOP = 'Stop arguing and write it up';

/** What the room asks the founder at their ceiling. */
export function ceilingQuestion(spent: number, ceiling: number, billing: NonNullable<BudgetSnapshot['billing']>) {
  const next = extendCeiling(ceiling, spent);
  const money = billing === 'payg' ? 'on your OpenAI key' : 'in API-equivalent usage of your plan';
  return {
    question: `This session has reached the $${ceiling.toFixed(2)} ceiling you set ($${spent.toFixed(2)} spent ${money}). Carry on?`,
    context: 'Nothing has been cut. The room is paused between rounds and argues at full depth whichever you choose; stopping still gets every open motion ruled, closing statements and the full report.',
    options: [
      { label: CEILING_EXTEND, description: `Raise the ceiling to $${next.toFixed(2)} and keep arguing.` },
      { label: CEILING_STOP, description: 'Rule what is open, then closing statements and the report.' },
    ],
    next,
  };
}
