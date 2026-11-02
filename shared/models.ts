/**
 * Every model id the app runs, in one place. Changing a model is a one-line
 * edit to MODEL_IDS below; nothing else in the codebase names a model.
 *
 * Seat casting belongs to the product, not to the user or the chair. The user
 * picks only a provider door; each seat then runs on that door's tier for the
 * job (SEAT_TIER). One debate runs on one provider family from start to end.
 *
 * Verification (2026-10-26):
 *  - Claude ids: `claude -p x --model <id> --output-format json` reported
 *    canonicalModel claude-opus-5-5 (1M context), claude-sonnet-5-5 and
 *    claude-haiku-4-5. A made-up id is rejected by the same probe, so the
 *    check discriminates.
 *  - OpenAI ids and prices: supplied by the project owner as verified
 *    (gpt-6-astra $10/$50, gpt-6.1-sol $2/$10, gpt-6-luna $0.10/$0.50 per
 *    million tokens, standard tier). The same three slugs are listed in the
 *    model catalogue of the Codex CLI that @openai/codex-sdk 0.164.0 ships,
 *    with a 272K context window on that door.
 */

/**
 * The four doors, in the order the app offers them:
 *   claude     your Claude Code login (the `claude` CLI, signed in)
 *   anthropic  a Claude API key (ANTHROPIC_API_KEY), on the same Claude engine
 *   codex      your Codex CLI login (ChatGPT sign-in)
 *   openai     an OpenAI API key (OPENAI_API_KEY)
 * `claude` and `anthropic` are one engine (the Agent SDK spawning the Claude
 * CLI) with two ways to pay for it; see claudeEngine().
 */
export type Provider = 'claude' | 'anthropic' | 'codex' | 'openai';

export const PROVIDERS: Provider[] = ['claude', 'anthropic', 'codex', 'openai'];

export const isProvider = (v: unknown): v is Provider => typeof v === 'string' && (PROVIDERS as string[]).includes(v);

/** True for the doors that run on the Claude engine (web research, file tools, the quant desk). */
export const claudeEngine = (p: Provider): boolean => p === 'claude' || p === 'anthropic';

export type Tier = 'flagship' | 'balanced' | 'fast';

export const MODEL_IDS = {
  claude: { flagship: 'claude-opus-5-5', balanced: 'claude-sonnet-5-5', fast: 'claude-haiku-4-5' },
  /** The Claude API key door runs the same Claude models, billed to the key. */
  anthropic: { flagship: 'claude-opus-5-5', balanced: 'claude-sonnet-5-5', fast: 'claude-haiku-4-5' },
  openai: { flagship: 'gpt-6-astra', balanced: 'gpt-6.1-sol', fast: 'gpt-6-luna' },
  /** The Codex door reaches the same OpenAI models through a ChatGPT login. */
  codex: { flagship: 'gpt-6-astra', balanced: 'gpt-6.1-sol', fast: 'gpt-6-luna' },
} as const satisfies Record<Provider, Record<Tier, string>>;

/** Marcus, the chair. Always Opus 5.5 on Claude; not user-selectable. */
export const CHAIR_MODEL = MODEL_IDS.claude.flagship;

/**
 * Every job the engine runs an agent for.
 *   chair    Marcus's own turns: intake, panel design, planning, steering, closing
 *   floor    an expert speaking (plus position cards and the adversary desk)
 *   ruling   writing a motion's decision
 *   referee  judging each round for depth and fresh argument
 *   report   the final deliverable and its revisions
 *   quant    the quant desk and the numbers audit
 *   summon   designing an expert seated mid-session
 *   research the web research desk
 *   dossier  reading the uploaded files
 *   repair   copy-fitting a report the print check flagged
 *   persona  each expert's dossier (history, incentives, voice) and the
 *            relationships pass, once per session (2b-5)
 *   react    the listeners' reaction call (wired with the floor director, 2b-7)
 *   lint     rewriting the form of a turn the realism linter flagged
 *   clerk    classifications: research findings against cruxes, the OpenAI
 *            research desk's findings step
 *
 * `bid` (the "do I want the floor" call of the deleted bidding loop) was
 * replaced by `react` in 2b-3. Casting sheets stored by older debates still
 * name it, and still render.
 */
export type Seat =
  | 'chair' | 'floor' | 'ruling' | 'referee' | 'report' | 'quant' | 'summon'
  | 'research' | 'dossier' | 'repair' | 'persona'
  | 'react' | 'lint' | 'clerk';

export const SEAT_TIER: Record<Seat, Tier> = {
  chair: 'flagship',
  floor: 'flagship',
  ruling: 'flagship',
  referee: 'flagship',
  report: 'flagship',
  quant: 'flagship',
  summon: 'flagship',
  research: 'balanced',
  dossier: 'balanced',
  repair: 'balanced',
  persona: 'balanced',
  react: 'fast',
  lint: 'fast',
  clerk: 'fast',
};

export function modelFor(provider: Provider, seat: Seat): string {
  return MODEL_IDS[provider][SEAT_TIER[seat]];
}

/** Which tier a model id belongs to, on any door. Null for an id the app does not cast. */
export function tierOf(model: string): Tier | null {
  for (const ids of Object.values(MODEL_IDS)) {
    for (const [tier, id] of Object.entries(ids)) if (id === model) return tier as Tier;
  }
  return null;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextK: number;
  /** USD per million tokens. Absent where no verified list price is held. */
  inPerMTok?: number;
  cachedInPerMTok?: number;
  outPerMTok?: number;
}

/**
 * Display names and limits. Claude spend is whatever the Claude CLI reports
 * per turn, so no Claude per-token price is kept here. OpenAI API turns are
 * priced from the table below; Codex turns run on a subscription and cost $0.
 * Cached-input rates are 10% of input, the OpenAI convention.
 */
export const MODEL_INFO: Record<string, ModelInfo> = {
  'claude-opus-5-5': { id: 'claude-opus-5-5', name: 'Opus 5.5', contextK: 1000 },
  'claude-sonnet-5-5': { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', contextK: 200 },
  'claude-haiku-4-5': { id: 'claude-haiku-4-5', name: 'Haiku 4.5', contextK: 200 },
  'gpt-6-astra': { id: 'gpt-6-astra', name: 'GPT-6 Astra', contextK: 272, inPerMTok: 10, cachedInPerMTok: 1, outPerMTok: 50 },
  'gpt-6.1-sol': { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', contextK: 272, inPerMTok: 2, cachedInPerMTok: 0.2, outPerMTok: 10 },
  'gpt-6-luna': { id: 'gpt-6-luna', name: 'GPT-6 Luna', contextK: 272, inPerMTok: 0.1, cachedInPerMTok: 0.01, outPerMTok: 0.5 },
};

export const modelName = (id: string): string => MODEL_INFO[id]?.name ?? id;

/**
 * The four setup names, the same on every screen (home, Connect, New Debate,
 * the debate itself), in `npm run doctor` and in the docs.
 */
export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'Claude: sign in',
  anthropic: 'Claude: API key',
  codex: 'ChatGPT: Codex sign-in',
  openai: 'OpenAI: API key',
};

/**
 * The provider a debate runs on. Rows written before providers existed carry
 * only a model id (`claude-opus-5`, `gpt-5.6-sol`, `codex-gpt-5.6-terra`);
 * that id names the family, so old debates keep opening and resuming.
 */
export function providerOfConfig(config: { provider?: string; model?: string } | null | undefined): Provider {
  const p = config?.provider;
  if (isProvider(p)) return p;
  const m = String(config?.model ?? '');
  if (m.startsWith('codex-')) return 'codex';
  if (m.startsWith('gpt-') || /^o[34]/.test(m)) return 'openai';
  return 'claude';
}
