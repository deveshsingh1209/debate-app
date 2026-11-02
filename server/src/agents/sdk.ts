import os from 'node:os';
import path from 'node:path';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CFG, debateDir } from '../config.ts';
import { emptyUsage, type UsageTotals } from '../../../shared/types.ts';
import { checkFetchUrl } from '../research/fetchguard.ts';
import { normaliseUrl } from '../research/normalise.ts';
import { wirePages } from '../research/pages.ts';
import type { GateVerdict } from '../research/meter.ts';
import { tierOf, type Provider } from '../../../shared/models.ts';
import { WASTE } from '../../../shared/budget.ts';
import { guardCall } from './waste.ts';
import {
  OpenAIKeys,
  isOpenAIModel,
  openAIConfigured,
  runAgentOpenAI,
  runJsonAgentOpenAI,
  abortOpenAIDebate,
  wireOpenAI,
  CredentialError,
} from './openai.ts';
import {
  CodexCreds,
  bindLocalCodex,
  readLocalCodexAuth,
  runAgentCodex,
  runJsonAgentCodex,
  abortCodexDebate,
  wireCodex,
  redactSecrets,
} from './codex.ts';

/** Re-exported so callers keep importing errors from one place. */
export { CredentialError } from './openai.ts';

/**
 * Per-debate usage ledger. Every agent turn (expert, Marcus, lint, referee,
 * research, dossier, report) reports its token usage here; subscribers (the
 * runner) forward live snapshots to the UI.
 */
const ledgers = new Map<string, UsageTotals>();
const roles = new Map<string, Record<string, { usd: number; turns: number }>>();
const listeners = new Map<string, (u: UsageTotals) => void>();

/**
 * Every in-flight agent turn, by debate. An agent call can run for minutes, so
 * without this a stop request just queues behind it and the room keeps talking
 * after the user has asked it to stop.
 */
const inflight = new Map<string, Set<AbortController>>();

/** Aborts every agent turn running for a debate. Returns how many were killed. */
export function abortDebate(debateId: string): number {
  // OpenAI turns are fetches, not subprocesses; Codex turns are subprocesses
  // but not OURS. Both park in their own registries and a stop request must
  // kill all three kinds, or the room keeps talking after the user said stop.
  let killed = abortOpenAIDebate(debateId) + abortCodexDebate(debateId);
  const set = inflight.get(debateId);
  if (!set?.size) return killed;
  const n = killed + set.size;
  for (const c of set) {
    try { c.abort(); } catch { /* already gone */ }
  }
  set.clear();
  return n;
}

export const Usage = {
  get(debateId: string): UsageTotals {
    return ledgers.get(debateId) ?? emptyUsage();
  },
  /** Restore a persisted ledger after a restart. */
  seed(debateId: string, totals: UsageTotals) {
    if (!ledgers.has(debateId)) ledgers.set(debateId, { ...totals });
  },
  subscribe(debateId: string, fn: (u: UsageTotals) => void) {
    listeners.set(debateId, fn);
  },
  drop(debateId: string) {
    ledgers.delete(debateId);
    listeners.delete(debateId);
    roles.delete(debateId);
  },
  /**
   * Spend per role, live. Without this "where did the money go" is not
   * answerable from the app's own data, and the cost projection shown to the
   * founder can only ever be a constant somebody guessed. The label a turn is
   * already tagged with is the role: `priya:floor`, `marcus:ruling`, `referee`.
   */
  role(debateId: string, label: string | undefined, usd: number) {
    if (!label) return;
    const role = label.includes(':') ? label.split(':').pop()! : label;
    const byRole = roles.get(debateId) ?? {};
    const cur = byRole[role] ?? { usd: 0, turns: 0 };
    byRole[role] = { usd: cur.usd + usd, turns: cur.turns + 1 };
    roles.set(debateId, byRole);
  },
  byRole(debateId: string): Record<string, { usd: number; turns: number }> {
    return roles.get(debateId) ?? {};
  },
  seedRoles(debateId: string, seed: Record<string, { usd: number; turns: number }>) {
    if (!roles.has(debateId)) roles.set(debateId, { ...seed });
  },
  bump(debateId: string, turn: Partial<UsageTotals>) {
    const t = ledgers.get(debateId) ?? emptyUsage();
    t.input += turn.input ?? 0;
    t.output += turn.output ?? 0;
    t.cacheWrite += turn.cacheWrite ?? 0;
    t.cacheRead += turn.cacheRead ?? 0;
    t.webSearches += turn.webSearches ?? 0;
    t.turns += 1;
    t.costUsd += turn.costUsd ?? 0;
    ledgers.set(debateId, t);
    listeners.get(debateId)?.({ ...t });
  },
  /**
   * One finished call on a flagship model. Counted at the dispatch point in
   * this file, the one place every provider's turn passes through, rather than
   * inside each provider's own bump.
   */
  flagship(debateId: string) {
    const t = ledgers.get(debateId) ?? emptyUsage();
    t.flagshipCalls = (t.flagshipCalls ?? 0) + 1;
    ledgers.set(debateId, t);
    listeners.get(debateId)?.({ ...t });
  },
};

/** Book a finished call against the flagship counter when it ran on a flagship model. */
function tally<T>(opts: AgentTurnOpts, result: Promise<T>): Promise<T> {
  return result.then((r) => {
    if (opts.debateId && tierOf(opts.model) === 'flagship') Usage.flagship(opts.debateId);
    return r;
  });
}

/**
 * Thin wrapper over the Claude Agent SDK.
 * Every persona in a debate is a real, separate SDK session (its own context,
 * its own memory) resumed turn after turn via session id. A global semaphore
 * caps concurrent subprocesses so the machine stays responsive.
 */

export interface AgentTurnOpts {
  model: string;
  system: string;
  prompt: string;
  resume?: string;             // SDK session id from a previous turn
  web?: boolean;               // allow WebSearch/WebFetch (research agents only)
  /** Which web tools a `web` turn holds. Default both; the research desk holds WebSearch only and reads pages itself. */
  webTools?: ('WebSearch' | 'WebFetch')[];
  /**
   * `web` turns only: asked before every web tool call (a PreToolUse hook, so
   * it also covers pre-approved tools). Null lets the call run; a reason
   * refuses it and the model reads why; `{ reason, stop }` also ends the loop.
   * The research desk's search allowance, duplicate-query refusal and token
   * tripwires live here (research/meter.ts searchGate).
   */
  toolGate?: (tool: string, input: Record<string, unknown>) => GateVerdict | Promise<GateVerdict>;
  /**
   * Claude CLI path only: the usage of each model request inside the turn, as
   * it completes (from the stream's message_start / message_delta events).
   * The turn's own result only reports the total at the end, which is too late
   * to stop a runaway tool loop.
   */
  onRequestUsage?: (u: RequestUsage) => void;
  /**
   * Claude CLI path only: a model request has started, with its input-side
   * tokens (message_start). The request is already billed by then; this is
   * the earliest point a turn can be stopped before it writes output or makes
   * another request.
   */
  onRequestStart?: (u: RequestUsage) => void;
  /**
   * `web` turns only: a WebSearch returned (a PostToolUse hook, so it runs
   * before the model reads the result). Returning true ends the turn there:
   * the result is captured in toolResults and never enters a model request.
   * The research desk ends its search session this way after one search and
   * reads the results itself (research/claude.ts).
   */
  afterWebResult?: (tool: 'WebSearch', query: string, content: string) => boolean | void;
  tools?: string[];            // extra allowed tools (e.g. Read/Glob/Grep for the dossier analyst)
  cwd?: string;                // working directory for file tools
  maxTurns?: number;           // override the default turn budget
  thinking?: number;           // maxThinkingTokens
  timeoutMs?: number;
  label?: string;              // for logs
  debateId?: string;           // usage ledger to bill this turn to
  /**
   * Which semaphore pool this turn draws from. 'research' runs in the
   * background and is held to its own slots, so it can never starve the
   * turns the room is waiting on. Default: the critical path.
   */
  job?: 'critical' | 'research';
  /**
   * OPTIONAL strict JSON schema for runJsonAgent turns. Used only by the
   * OpenAI path (Responses structured outputs, text.format json_schema with
   * strict:true). The Claude path ignores it — extractJson + retry already
   * covers it there. Strict-mode rules: root object, additionalProperties
   * false, every property required.
   */
  schema?: { name: string; schema: Record<string, unknown> };
  /** Aborts the turn from outside (research timeouts and cancels). A user stop goes through abortDebate. */
  signal?: AbortSignal;
  /**
   * OpenAI door only: Responses API tools and `include` fields for this turn
   * (the research desk's `web_search`). Ignored by the other doors, which get
   * their web tools from `web`.
   */
  openaiTools?: Record<string, unknown>[];
  openaiInclude?: string[];
  /** OpenAI door only: the Responses `max_tool_calls` for a turn that holds openaiTools. */
  openaiMaxToolCalls?: number;
  onDelta?: (text: string) => void;
  /** Real reasoning as it streams. Used to keep the room alive during long silent turns. */
  onThinking?: (textDelta: string) => void;
}

export interface AgentTurnResult {
  text: string;
  sessionId: string | null;
  costUsd: number;
  /** Raw token counts for this turn. The cache split is what proves (or
   *  disproves) that two calls actually shared a prefix. */
  usage: { input: number; output: number; cacheWrite: number; cacheRead: number };
  /**
   * Every tool this turn actually invoked, in order, with the command line for
   * Bash. Not for logging: the audit gate reads it to tell a figure that came
   * out of an interpreter from one the model asserted, which is the whole
   * difference between an audit and a second opinion.
   */
  toolCalls: { name: string; command: string | null }[];
  /**
   * What the web tools actually returned, for the research desk's provenance
   * rules: a URL the model cites is only attested if a tool result shows it.
   * Claude: WebSearch and WebFetch results (input and a bounded copy of the
   * output). Codex: the web_search items (query only; the SDK exposes no URLs).
   */
  toolResults?: ToolResult[];
  /** OpenAI door: the final Responses object, for url_citation annotations and search sources. */
  raw?: unknown;
}

/** One model request's tokens, as the API reported them. */
export interface RequestUsage { input: number; output: number; cacheWrite: number; cacheRead: number }

export interface ToolResult {
  name: string;
  /** The search query, or the URL fetched. */
  input: string;
  ok: boolean;
  /** At most RESULT_CAP characters of what the tool returned. */
  content: string;
}

/** A bounded copy: a search result page is evidence, not something to hold whole. */
const RESULT_CAP = 20_000;

/**
 * Which provider each debate's agent turns run on, resolved from the debate id
 * inside every call so a call site cannot route a turn to the wrong provider
 * by forgetting an argument. No credential is stored here:
 *   claude     the Claude CLI subprocess uses your own Claude Code login
 *   anthropic  the same Claude CLI subprocess, given ANTHROPIC_API_KEY from
 *              config in ITS environment only (claudeChildEnv)
 *   openai     the OPENAI_API_KEY from config, used over HTTPS by openai.ts
 *   codex      your own `codex login`, re-read from $CODEX_HOME before each turn
 */
export const AgentAuth = {
  /**
   * Bind a debate to its provider. Returns false when that provider's
   * credential is not available on this machine; the runner then parks the
   * debate with an explanation instead of failing mid-turn.
   */
  bind(debateId: string, provider: Provider): boolean {
    AgentAuth.unbind(debateId);
    if (provider === 'openai') {
      OpenAIKeys.use(debateId);
      return openAIConfigured();
    }
    if (provider === 'anthropic') {
      AnthropicKeys.use(debateId);
      return anthropicConfigured();
    }
    if (provider === 'codex') return bindLocalCodex(debateId, codexAuthPath());
    return true;
  },
  unbind(debateId: string) {
    OpenAIKeys.drop(debateId);
    CodexCreds.drop(debateId);
    AnthropicKeys.drop(debateId);
  },
};

/**
 * Debates on the Claude API key door. The key stays in CFG; the only place it
 * is ever copied is the environment of a Claude CLI child spawned for one of
 * these debates.
 */
const anthropicDebates = new Set<string>();
export const AnthropicKeys = {
  use(debateId: string) { anthropicDebates.add(debateId); },
  drop(debateId: string) { anthropicDebates.delete(debateId); },
  bound(debateId: string | undefined): boolean { return !!debateId && anthropicDebates.has(debateId); },
};

/** Whether ANTHROPIC_API_KEY is configured. Exposes nothing about the key itself. */
export const anthropicConfigured = () => CFG.anthropicApiKey.trim().length > 0;

export const codexAuthPath = () => path.join(CFG.codexHome, 'auth.json');

/**
 * Which providers can run on this machine, from cheap checks only. The full
 * readiness probe (the Claude login included) is server/src/doors.
 */
export function providerAvailability(): Record<Provider, boolean> {
  return {
    claude: true, // the doors probe asks the CLI; a turn reports a missing login too
    anthropic: anthropicConfigured(),
    codex: readLocalCodexAuth(codexAuthPath()) !== null,
    openai: openAIConfigured(),
  };
}

/**
 * The CAPABILITY family a debate's turns run in. Everything that reads this
 * asks one thing: does this session have the Claude toolchain (web research,
 * the dossier's file tools, the python quant desk)? OpenAI and Codex sessions
 * have none of it, so both answer 'openai' and the same gates cover them.
 */
export function debateProvider(debateId: string): 'claude' | 'openai' {
  return OpenAIKeys.bound(debateId) || CodexCreds.bound(debateId) ? 'openai' : 'claude';
}

/**
 * Environment for the spawned CLI. Two things must be true:
 *  1. No CLAUDE* markers from the parent, or the child believes it is a nested
 *     Claude Code session and aborts.
 *  2. `node` on PATH must be a runtime the bundled CLI survives on. It resolves
 *     `node` from PATH, and node 25.x SIGABRTs inside the CLI, so CFG.nodeBin
 *     is prepended to pin a known-good runtime.
 */
export function claudeChildEnv(debateId?: string): Record<string, string> {
  /**
   * ALLOWLIST, not a copy. The agent subprocess may run python over uploaded
   * files, so it gets what a CLI needs to run and nothing else. HOME is kept
   * because that is where the CLI finds your own Claude Code login. An
   * explicit CLAUDE_CODE_OAUTH_TOKEN in your environment is passed through
   * for headless setups; this app never stores one.
   */
  const KEEP = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'CLAUDE_CODE_OAUTH_TOKEN'];
  const env: Record<string, string> = {};
  for (const k of KEEP) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  /**
   * The Claude API key door: the key goes to this child and nowhere else, and
   * the sign-in token is withheld so the CLI cannot quietly bill a debate
   * meant for the key to the subscription instead. A debate on the login door
   * never receives the key (it is not in KEEP, and config.ts removed it from
   * process.env at start-up).
   */
  if (AnthropicKeys.bound(debateId)) {
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    env.ANTHROPIC_API_KEY = CFG.anthropicApiKey.trim();
  }
  if (CFG.nodeBin) env.PATH = `${CFG.nodeBin}:${env.PATH ?? ''}`;
  /**
   * The CLI caps each response at 32K output tokens BY DEFAULT, and extended
   * thinking counts against that cap. The final report is ~30K tokens of JSON
   * on its own, so at 32K it can never be emitted whole: thinking eats the
   * window, the text truncates mid-JSON, and every retry fails the same way —
   * which is how a finished session lost its deliverable. 64K gives thinking
   * and a full-length report room to coexist.
   */
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? '64000';
  /**
   * Your claude.ai connectors (Gmail, Drive, ...) stay out of every agent:
   * no seat here may hold them, and their tool definitions rode along on
   * some sessions at ~46,000 tokens a request (see strictMcpConfig in runOnce).
   */
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  return env;
}

/**
 * The base toolset an agent may hold — the actual boundary.
 *
 * `allowedTools` is ONLY an auto-approve list; the SDK says so in its own
 * types ("To restrict which tools are available, use the `tools` option
 * instead"). Because this app never set `tools`, every agent silently carried
 * the full claude_code preset, Bash included — and the CLI auto-approves a
 * built-in read-only shell allowlist (`head`, `strings`, `wc`, `ls`…)
 * regardless of permission mode or rules. `head <app dir>/.env`
 * matches that allowlist and the service runs as the file's owner, so a
 * prompt-injected dossier could read the credential out of a persona that was
 * believed to have no tools at all.
 *
 * Rule specifiers ("Read(//dir/**)", "Bash(python3:*)") carry their base tool
 * name in front of the parenthesis; that name is what `tools` wants.
 */
function baseTools(rules: string[] | undefined, extra: string[]): string[] {
  const names = (rules ?? []).map((r) => r.split('(')[0].trim()).filter(Boolean);
  return [...new Set([...extra, ...names])];
}

/**
 * Hand openai.ts its ledger and limits ONCE, at module load. openai.ts holds
 * no runtime imports (so its selftest never triggers config.ts's side
 * effects); this is the one place the real wiring happens.
 */
wireOpenAI({
  usage: Usage,
  defaultTimeoutMs: CFG.turnTimeoutMs,
  maxConcurrent: CFG.maxConcurrentAgents,
  apiKey: CFG.openaiApiKey,
});

/**
 * Same contract for codex.ts, plus the data directory: a Codex turn needs a
 * real CODEX_HOME on disk, and the one place that knows where a debate's files
 * live is config.ts. Handing it in rather than importing it keeps codex.ts
 * free of config side effects so its selftest can point it at a temp dir.
 */
wireCodex({
  usage: Usage,
  defaultTimeoutMs: CFG.turnTimeoutMs,
  maxConcurrent: CFG.maxConcurrentAgents,
  debateDir,
});

// ---- the Claude CLI seam ----

/**
 * The Agent SDK's `query`, swappable so a recorded message stream can drive
 * the Claude path offline (the research contract suite does). Beside
 * wireOpenAI({ fetchImpl }) and wireCodex({ codexFactory }); never wired in
 * the app itself.
 */
let queryImpl: typeof query = query;
export function wireClaude(w: { queryImpl?: typeof query | null }) {
  queryImpl = w.queryImpl ?? query;
}

/**
 * Pages a WebSearch has returned in each debate. The fetch rule below only
 * opens these.
 *
 * Why: every seat with web tools writes its own URLs, and what it writes may
 * descend from an uploaded document (a hostile file asks for
 * "https://x.example/?ctx=<the margin floor>"). Fetching only what a search
 * already returned turns WebFetch from "fetch anything" into "open a search
 * hit", which leaves no URL for an injected instruction to put data into.
 * Filled from WebSearch results through a PostToolUse hook (and from the
 * message stream as a second source). In memory: after a restart a debate's
 * research simply searches again.
 */
const searchSeen = new Map<string, Set<string>>();
const SEARCH_SEEN_CAP = 5_000;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>\\`)\]}]+/gi;

export const SearchSeen = {
  /** Record every URL in a search result (any shape: the tool's object, or its text). */
  record(debateId: string, result: unknown) {
    const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
    let set = searchSeen.get(debateId);
    if (!set) searchSeen.set(debateId, (set = new Set()));
    for (const m of text.matchAll(URL_IN_TEXT)) {
      const key = normaliseUrl(m[0].replace(/[.,;:]+$/, ''));
      if (key && set.size < SEARCH_SEEN_CAP) set.add(key);
    }
  },
  has(debateId: string | undefined, url: string): boolean {
    const key = normaliseUrl(url);
    return !!(debateId && key && searchSeen.get(debateId)?.has(key));
  },
  drop(debateId: string) {
    searchSeen.delete(debateId);
  },
};

const deny = (reason: string) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: `Fetch refused: ${reason}`,
  },
});

/**
 * The fetch rule, enforced where the CLI asks before it runs a tool. A
 * PreToolUse hook rather than `canUseTool`: web turns run under `dontAsk`
 * with WebFetch pre-approved, and a pre-approved tool never reaches
 * `canUseTool`, while a hook runs on every call. Two checks, both must pass:
 *  1. the page appeared in a WebSearch result earlier in this debate;
 *  2. its host resolves only to public addresses (no loopback, link-local,
 *     private, CGNAT, `*.local`), so nothing on this machine or its network.
 * Redirects and DNS rebinding are re-checked after the fetch (webFetchAfter).
 */
export async function webFetchHook(input: unknown, debateId?: string): Promise<Record<string, unknown>> {
  const i = input as { tool_name?: string; tool_input?: { url?: unknown } };
  if (i?.tool_name && i.tool_name !== 'WebFetch') return {};
  const url = String(i?.tool_input?.url ?? '');
  const verdict = await checkFetchUrl(url);
  if (!verdict.ok) return deny(verdict.reason);
  if (!SearchSeen.has(debateId, url)) {
    return deny('only pages that a web search returned in this session can be opened. Search first, then open one of the results exactly as it was returned.');
  }
  return {};
}

/**
 * After a fetch: where did it actually land? A public host that redirected,
 * or re-resolved (DNS rebinding) to a private address between the check above
 * and the CLI's own lookup, is caught here by resolving the final URL again.
 * The page is already in the turn's context by then, so the whole turn is
 * stopped (`continue: false`, plus `onBreach`, which aborts it): nothing it
 * read reaches the room. Cross-host redirects are not followed by the CLI at
 * all; it hands the new URL back, and opening it is a new fetch the rule above
 * judges (and refuses, as no search returned it).
 */
export async function webFetchAfter(input: unknown, onBreach?: (why: string) => void): Promise<Record<string, unknown>> {
  const i = input as { tool_name?: string; tool_input?: { url?: unknown }; tool_response?: any };
  if (i?.tool_name && i.tool_name !== 'WebFetch') return {};
  const landed = [String(i?.tool_input?.url ?? '')];
  const r = i?.tool_response;
  if (r && typeof r === 'object' && typeof r.url === 'string') landed.push(r.url);
  for (const url of landed.filter(Boolean)) {
    const v = await checkFetchUrl(url);
    if (!v.ok) {
      const why = `a fetched page landed on a non-public address (${v.reason})`;
      onBreach?.(why);
      return { continue: false, stopReason: `Research stopped: ${why}.` };
    }
  }
  return {};
}

/**
 * Where the user's credentials and the app's own secrets live. Every seat
 * that holds a file tool or python gets these as deny rules: the dossier
 * analyst's Read is already scoped to the upload folder, and for the python
 * seats these rules are what the OS sandbox enforces on reads (Claude Code
 * derives its sandbox read restrictions from Read deny rules). Python is not
 * otherwise a read boundary: `python3 -c "open(...)"` reaches whatever the
 * app's user can.
 */
export function credentialDenyRules(home = os.homedir()): string[] {
  const abs = (p: string) => `//${path.resolve(p).replace(/\\/g, '/').replace(/^\/+/, '')}`;
  const dirs = [
    '.ssh', '.codex', '.claude', '.aws', '.config', '.gnupg', '.docker', '.kube', '.azure',
    '.password-store', '.local/share/keyrings', 'Library/Keychains', 'Library/Application Support/Claude',
  ].map((d) => path.join(home, d));
  dirs.push(CFG.codexHome, '/Library/Keychains', path.join(CFG.dataDir, 'backups'));
  const files = ['.claude.json', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.bash_history', '.zsh_history'].map((f) => path.join(home, f));
  return [...new Set([
    ...dirs.map((d) => `Read(${abs(d)}/**)`),
    ...files.map((f) => `Read(${abs(f)})`),
    `Read(${abs(path.resolve('.env'))})`,
    'Read(//**/.env)',
    'Read(//**/.env.*)',
    `Read(${abs(CFG.dataDir)}/debate.db*)`,
  ])];
}

/**
 * The toolGate as a PreToolUse hook: a reason from the gate becomes a deny the
 * model reads; a stop also ends the loop (`continue: false`).
 */
export function gateHook(gate: NonNullable<AgentTurnOpts['toolGate']>, onStop?: () => void) {
  return async (input: unknown): Promise<Record<string, unknown>> => {
    const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
    const verdict = await gate(String(i?.tool_name ?? ''), i?.tool_input ?? {});
    if (!verdict) return {};
    const reason = typeof verdict === 'string' ? verdict : verdict.reason;
    const stop = typeof verdict !== 'string';
    if (stop) onStop?.();
    return {
      ...(stop ? { continue: false, stopReason: reason } : {}),
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    };
  };
}

/**
 * A WebSearch tool_response as the model would read it, bounded. The CLI's
 * structured response is `{ query, results: [text | { tool_use_id, content:
 * [{ title, url, ... }] }] }`; every link list is merged into one "Links:"
 * array (what attestFromTools reads) and the search's own notes follow.
 * A string response passes through.
 */
export function searchResponseText(response: unknown): string {
  if (typeof response === 'string') return response.slice(0, RESULT_CAP);
  const r = response as { query?: unknown; results?: unknown } | null;
  if (!r || !Array.isArray(r.results)) return toolResultText(response);
  const links: unknown[] = [];
  const notes: string[] = [];
  for (const item of r.results as any[]) {
    if (typeof item === 'string') notes.push(item);
    else if (Array.isArray(item?.content)) {
      for (const l of item.content) {
        if (l && typeof l.url === 'string') links.push({ title: l.title, url: l.url, ...(l.snippet ? { snippet: l.snippet } : {}), ...(l.page_age ? { page_age: l.page_age } : {}) });
      }
    }
  }
  return `Web search results for query: "${String(r.query ?? '')}"\n\nLinks: ${JSON.stringify(links)}\n\n${notes.join('\n\n')}`.slice(0, RESULT_CAP);
}

/** Flatten a tool_result's content (a string, or text blocks) into bounded text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, RESULT_CAP);
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c === 'string' ? c : typeof c?.text === 'string' ? c.text : '')).join('\n').slice(0, RESULT_CAP);
  }
  return '';
}

// ---- test seam ----

/**
 * Scripted model replies, for the offline engine test. When wired, every
 * agent turn of every provider goes to these instead of a CLI, an API or a
 * subprocess, and nothing leaves the machine. Never wired in the app itself.
 * The fake's reported usage still goes through the ledger, so spend, the
 * per-role ledger and the budget meter behave as they would for real.
 */
export interface FakeAgents {
  run(opts: AgentTurnOpts): Promise<AgentTurnResult>;
  /** Optional: JSON turns. Without it, runJsonAgent parses run()'s text as usual. */
  runJson?(opts: AgentTurnOpts): Promise<{ value: any; sessionId?: string | null; usage?: Partial<AgentTurnResult['usage']>; costUsd?: number }>;
}
let fakeAgents: FakeAgents | null = null;

export function wireAgents(fake: FakeAgents | null) {
  fakeAgents = fake;
}

/**
 * True while scripted agents or a recorded Claude stream are wired: nothing
 * the agents' callers do may reach the network either.
 */
export function agentsAreFake(): boolean {
  return fakeAgents !== null || queryImpl !== query;
}
// The research desk's page reader goes quiet with the agents unless a test hands it pages.
wirePages({ offlineWhen: agentsAreFake });

function billFake(opts: AgentTurnOpts, usage: Partial<AgentTurnResult['usage']> | undefined, costUsd: number | undefined) {
  if (!opts.debateId) return;
  Usage.role(opts.debateId, opts.label, costUsd ?? 0);
  Usage.bump(opts.debateId, { ...usage, costUsd: costUsd ?? 0 });
}

// ---- semaphore, with per-job reservations ----

/**
 * One process-wide limit on agent subprocesses (MAX_AGENTS, default 4), split
 * so background research cannot crowd out the room. Research may hold at most
 * `researchSlots` slots, and critical-path turns may use every slot but the
 * one reserved for research. With the default 4 and 2: research never holds
 * more than two, the floor always has at least two, and a research brief can
 * always start even while the floor is busy.
 */
export const SLOTS = {
  get total() { return CFG.maxConcurrentAgents; },
  /** Never taken by the critical path. */
  reservedForResearch: 1,
  /** Most research turns that may run at once. */
  get researchSlots() { return Math.min(CFG.maxInflightResearch, Math.max(1, this.total - 1)); },
};

const running = { critical: 0, research: 0 };
const waiters: { job: 'critical' | 'research'; go: () => void }[] = [];

function canRun(job: 'critical' | 'research'): boolean {
  const total = running.critical + running.research;
  if (total >= SLOTS.total) return false;
  if (job === 'research') return running.research < SLOTS.researchSlots;
  // The critical path may not dip into the research reservation.
  const reserve = Math.min(SLOTS.reservedForResearch, Math.max(0, SLOTS.total - 1));
  return running.critical < SLOTS.total - reserve;
}

async function acquire(job: 'critical' | 'research' = 'critical'): Promise<void> {
  if (!canRun(job)) await new Promise<void>((go) => waiters.push({ job, go }));
  running[job]++;
}

function release(job: 'critical' | 'research' = 'critical') {
  running[job]--;
  // Wake the first waiter that can run now; a waiting research turn must not
  // block a critical one behind it, or the other way round.
  for (let i = 0; i < waiters.length; i++) {
    if (canRun(waiters[i].job)) {
      const [w] = waiters.splice(i, 1);
      w.go();
      return;
    }
  }
}

/** For tests: how many turns hold slots right now, by pool. */
export function slotUsage() {
  return { ...running, waiting: waiters.length };
}

/** For tests: hold a slot as a given job, exactly as a turn would. */
export const Semaphore = { acquire, release };

// ---- core ----

/**
 * The Claude plan's usage allowance is spent.
 *
 * Distinct from every other failure because it is not a fault and not
 * permanent: the work is fine, the clock is not. Retrying it is worse than
 * useless (it hammers a cooldown), and letting it reach the driver's generic
 * catch marked a perfectly good session `error` and threw away hours of
 * argument. Anthropic states the reset time in the message, so it is parsed
 * here and the session parks until then rather than dying.
 */
export class UsageLimitError extends Error {
  readonly resetAt: number | null;
  readonly kind: 'session' | 'weekly' | 'unknown';
  constructor(raw: string, resetAt: number | null, kind: 'session' | 'weekly' | 'unknown') {
    super(raw.slice(0, 300));
    this.name = 'UsageLimitError';
    this.resetAt = resetAt;
    this.kind = kind;
  }
}

/**
 * Read a limit out of whatever the CLI surfaced. Deliberately generous: the
 * wording varies ("usage limit reached", "hit your weekly limit", a bare 429),
 * and the cost of missing one is a dead session, while the cost of a false
 * positive is a pause the user can end.
 */
export function asUsageLimit(err: unknown): UsageLimitError | null {
  if (err instanceof UsageLimitError) return err;
  const raw = String((err as any)?.message ?? err ?? '');
  /**
   * Measured live, 8 Aug 2026: a real session limit arrived worded "You've hit
   * your session limit · resets 5:20pm (<zone>)", which matched NONE of
   * the old alternatives — "hit your ... limit" was spelled out per-kind and
   * "session" was not one of them. Every seat then burned two retries against
   * a cooldown and the run died as an error instead of parking. Any "hit your
   * <anything> limit" now counts.
   */
  const looksLimited =
    /usage limit|rate limit|session limit|hit your [\w-]+ limit|limit reached|limit exceeded|too many requests|out of (?:usage|credit|credits)|\b429\b/i.test(raw);
  if (!looksLimited) return null;
  const kind: 'session' | 'weekly' | 'unknown' =
    /weekly/i.test(raw) ? 'weekly' : /5-hour|five-hour|session limit/i.test(raw) ? 'session' : 'unknown';
  return new UsageLimitError(raw, parseResetAt(raw) ?? parseRetryAfter(raw), kind);
}

/**
 * A relative wait: an HTTP Retry-After the provider sent ("retry after 20s",
 * written into the error by openai.ts) or "try again in 3 minutes" (OpenAI
 * and Codex wording). Returns the moment to try again, or null.
 */
export function parseRetryAfter(raw: string, now = Date.now()): number | null {
  const m = raw.match(/(?:retry[- ]after:?|try again in)\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)?\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  const ms = unit.startsWith('ms') || unit.startsWith('milli') ? n : unit.startsWith('h') ? n * 3600_000 : unit.startsWith('m') ? n * 60_000 : n * 1000;
  if (!Number.isFinite(ms) || ms <= 0 || ms > 8 * 24 * 3600_000) return null;
  return now + Math.round(ms);
}

/**
 * "resets 5:30am (<zone>)" / "will reset at 3pm" / "resets at 14:00".
 * Returns the next occurrence of that wall-clock time in this machine's zone.
 * The stated zone is ignored: the CLI runs on this same machine and reports
 * its local time, and a premature wake just re-parks with a fresh reset time.
 */
export function parseResetAt(raw: string, now = Date.now()): number | null {
  const m = raw.match(/reset[s]?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const ampm = m[3]?.toLowerCase();
  if (Number.isNaN(hour) || hour > 23 || minute > 59) return null;
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setHours(hour, minute);
  let t = d.getTime();
  if (t <= now) t += 24 * 3600_000;          // already past today: it means tomorrow
  if (t - now > 8 * 24 * 3600_000) return null; // implausible; fall back to backoff
  return t;
}

/**
 * A turn that ran out of time. Distinct from a user stop ON PURPOSE.
 *
 * Both arrive as an AbortError, and treating them alike had two expensive
 * consequences. A timed-out turn was reported to the founder as "session ended
 * by the founder", which is a lie about something he did not do. Worse, the
 * driver's stop handler sends a session with closed motions back to `wrapup`,
 * so a report that timed out went wrapup -> reporting -> timeout -> wrapup
 * forever, re-running the report agent and the numbers audit on every lap with
 * nothing to stop it.
 */
export class TurnTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`agent turn "${label}" exceeded its ${Math.round(ms / 1000)}s budget`);
    this.name = 'TurnTimeoutError';
  }
}

/**
 * Strike credentials out of anything the Claude CLI said before it is logged
 * or shown: the configured API key itself, anything shaped like an Anthropic
 * key or sign-in token, and the bearer/JWT shapes redactSecrets already knows.
 */
export function redactClaudeSecrets(text: string): string {
  let out = redactSecrets(text);
  const key = CFG.anthropicApiKey.trim();
  if (key.length >= 8) out = out.split(key).join('[redacted-key]');
  const oauth = (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim();
  if (oauth.length >= 8) out = out.split(oauth).join('[redacted-token]');
  return out.replace(/sk-ant-[A-Za-z0-9_-]{6,}/g, '[redacted-key]');
}

/**
 * A refused credential on the Claude engine, as a CredentialError so the
 * runner parks the debate with the fix instead of retrying a dead key. Null
 * for anything else. The wordings are the CLI's and the API's own.
 */
export function claudeCredentialRefusal(said: string, onKey: boolean): CredentialError | null {
  if (onKey && /invalid x-api-key|invalid api key|authentication_error|credit balance is too low|permission_error/i.test(said)) {
    return new CredentialError(
      /credit balance/i.test(said)
        ? 'Your Claude API key has no credit left. Add credit in the Anthropic Console (Plans & Billing), then reopen this debate.'
        : 'Anthropic refused the Claude API key in .env (ANTHROPIC_API_KEY). Check it in the Anthropic Console, put the right one in .env, press Re-check on the Connect screen, then reopen this debate.'
    );
  }
  if (!onKey && /not logged in|please run \/login|invalid api key · please run|oauth session expired|could not be refreshed/i.test(said)) {
    return new CredentialError('Claude Code is not signed in on this computer. Open a terminal, run `claude`, sign in, then reopen this debate.');
  }
  return null;
}

/** A research turn stopped because a fetch landed somewhere private. Never retried. */
export class FetchBreachError extends Error {
  constructor(why: string) {
    super(`research turn stopped: ${why}`);
    this.name = 'FetchBreachError';
  }
}

/**
 * A gated web loop (toolGate set) that ended without writing an answer: the
 * gate stopped it, or it used every turn on refused calls. Not retried: a
 * retry runs the same loop again from the start and pays for it twice. It
 * carries what the loop did (`partial`, session id and tool results
 * included), so the caller can ask the same session for the write-up.
 */
export class GatedLoopExhausted extends Error {
  readonly partial: Omit<AgentTurnResult, 'text'>;
  constructor(label: string, partial: Omit<AgentTurnResult, 'text'>) {
    super(`agent turn "${label}" ended on refused tool calls without an answer`);
    this.name = 'GatedLoopExhausted';
    this.partial = partial;
  }
}

async function runOnce(opts: AgentTurnOpts): Promise<AgentTurnResult> {
  if (AnthropicKeys.bound(opts.debateId) && !anthropicConfigured()) {
    throw new CredentialError('This debate runs on a Claude API key and no ANTHROPIC_API_KEY is configured. Add it to .env, press Re-check on the Connect screen, then reopen this debate.');
  }
  const abort = new AbortController();
  const budgetMs = opts.timeoutMs ?? CFG.turnTimeoutMs;
  let timedOut = false;
  /** Set when the post-fetch check stops the turn; the turn then fails with this, not as a user stop. */
  let breach: string | null = null;
  const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, budgetMs);
  let stderrBuf = '';
  /** The toolGate ended the loop (gateHook). */
  let gateStopped = false;
  /** Tail of the child's own stdout messages; see the write site for why. */
  let stdoutTail = '';

  if (opts.debateId) {
    let set = inflight.get(opts.debateId);
    if (!set) inflight.set(opts.debateId, (set = new Set()));
    set.add(abort);
  }
  if (opts.signal) {
    if (opts.signal.aborted) abort.abort();
    else opts.signal.addEventListener('abort', () => abort.abort(), { once: true });
  }

  const toolResults: ToolResult[] = [];
  /** tool_use ids whose result a PostToolUse hook already captured. */
  const captured = new Set<string>();

  const options: Options = {
    model: opts.model,
    systemPrompt: opts.system,
    resume: opts.resume,
    maxThinkingTokens: opts.thinking ?? CFG.turnThinking,
    includePartialMessages: true,
    settingSources: [],            // never leak your own CLAUDE.md into personas
    /**
     * No MCP servers but the app's own (it has none). settingSources: [] does
     * not reach MCP: the CLI still loads user-scope servers and, on a Claude
     * sign-in, the account's claude.ai connectors, fetched in the background
     * so they make some sessions and not others. On 1 Nov 2026 (d_ntnoWyeC)
     * 37 of 385 sessions, tool-free personas included, carried a ~46,000-token
     * block of tool definitions ahead of their system prompt (the same cached
     * prefix across sessions with different prompts), which put a research
     * search's first request at ~49,300 tokens before it searched.
     */
    mcpServers: {},
    strictMcpConfig: true,
    abortController: abort,
    env: claudeChildEnv(opts.debateId),
    ...(CFG.cliPath ? { pathToClaudeCodeExecutable: CFG.cliPath } : {}),
    stderr: (data: string) => {
      stderrBuf = (stderrBuf + data).slice(-2000);
    },
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.web
      ? {
          /**
           * dontAsk, NEVER bypassPermissions. Under bypass, allowedTools is a
           * pre-approval list, not a boundary — every other tool (Bash
           * included) is auto-approved too, which handed research personas an
           * unrestricted shell. Under dontAsk the listed tools run silently
           * and everything else is DENIED.
           */
          permissionMode: 'dontAsk' as const,
          tools: baseTools(opts.tools, opts.webTools ?? ['WebSearch', 'WebFetch']),
          allowedTools: [...(opts.webTools ?? ['WebSearch', 'WebFetch']), ...(opts.tools ?? [])],
          ...(opts.tools?.length ? { disallowedTools: credentialDenyRules() } : {}),
          maxTurns: opts.maxTurns ?? 25,
          hooks: {
            PreToolUse: [
              { matcher: 'WebFetch', hooks: [(input: unknown) => webFetchHook(input, opts.debateId)] },
              ...(opts.toolGate ? [{ matcher: 'WebSearch|WebFetch', hooks: [gateHook(opts.toolGate, () => { gateStopped = true; })] }] : []),
            ],
            PostToolUse: [
              {
                matcher: 'WebSearch',
                hooks: [async (input: any) => {
                  if (opts.debateId) SearchSeen.record(opts.debateId, input?.tool_response);
                  if (!opts.afterWebResult) return {};
                  const content = searchResponseText(input?.tool_response);
                  const query = String(input?.tool_input?.query ?? '').slice(0, 2000);
                  if (input?.tool_use_id) captured.add(String(input.tool_use_id));
                  toolResults.push({ name: 'WebSearch', input: query, ok: true, content });
                  if (!opts.afterWebResult('WebSearch', query, content)) return {};
                  gateStopped = true;
                  return { continue: false, stopReason: 'The research desk reads the results itself.' };
                }],
              },
              {
                matcher: 'WebFetch',
                hooks: [(input: unknown) => webFetchAfter(input, (why) => {
                  breach = why;
                  console.error(`[agent] ${opts.label ?? '?'}: ${why}; stopping the turn`);
                  abort.abort();
                })],
              },
            ],
          },
        }
      : opts.tools?.length
        ? {
            permissionMode: 'dontAsk' as const, // only the listed tools are pre-approved
            tools: baseTools(opts.tools, []),
            allowedTools: opts.tools,
            // Deny rules beat allow rules: credentials stay out of reach of
            // file tools AND of the sandboxed shell (see credentialDenyRules).
            disallowedTools: credentialDenyRules(),
            maxTurns: opts.maxTurns ?? 25,
            /**
             * The quant desk and the auditors run python over UPLOADED files,
             * which are the one prompt-injection surface in the app. Their
             * shell runs in the OS sandbox with no network at all, so an
             * injected instruction cannot send anything it reads anywhere.
             * Never falls back to an unsandboxed shell; if the sandbox is
             * unavailable the desk fails and the debate carries on without it.
             */
            ...(opts.tools.some((t) => t.startsWith('Bash'))
              ? { sandbox: { enabled: true, allowUnsandboxedCommands: false, network: { allowedDomains: [] } } }
              : {}),
          }
        : {
            permissionMode: 'dontAsk' as const, // personas only speak
            tools: [],                          // and hold no tools to speak WITH
            allowedTools: [],
            maxTurns: opts.maxTurns ?? 3,
          }),
  };

  let sessionId: string | null = null;
  let streamed = '';
  let finalText = '';
  let resultText: string | null = null;
  let costUsd = 0;
  let turnUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const toolCalls: { name: string; command: string | null }[] = [];
  /** Web tool calls by id, so their results can be matched to what was asked. */
  const webUses = new Map<string, { name: string; input: string }>();
  /** The model request streaming right now, for onRequestUsage. */
  let request: RequestUsage | null = null;
  let maxTurnsHit = false;

  try {
    for await (const msg of queryImpl({ prompt: opts.prompt, options }) as AsyncIterable<SDKMessage>) {
      if ('session_id' in msg && msg.session_id) sessionId = msg.session_id;

      /**
       * A tail of everything the child said, for the error path only.
       *
       * A real session limit on 8 Aug 2026 arrived as exit code 1 with an EMPTY
       * stderr: the CLI states the limit and its reset time on stdout, so the
       * thrown error read "process exited with code 1" and asUsageLimit had
       * nothing to match. The session died instead of parking. Whatever the
       * child says now travels with the failure.
       */
      if (msg.type === 'system' || msg.type === 'result') {
        const m: any = msg;
        const detail = msg.type === 'result'
          ? JSON.stringify({ subtype: m.subtype, is_error: m.is_error, result: m.result, errors: m.errors, api_error_status: m.api_error_status })
          : JSON.stringify(msg);
        stdoutTail = (stdoutTail + ' ' + detail.slice(0, 1200)).slice(-2000);
      }
      if (msg.type === 'stream_event') {
        const ev: any = (msg as any).event;
        if (ev?.type === 'message_start') {
          const u = ev.message?.usage ?? {};
          request = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 };
          opts.onRequestStart?.({ ...request });
        } else if (ev?.type === 'message_delta' && request) {
          // Output is cumulative per message; input counts may be restated.
          const u = ev.usage ?? {};
          if (u.output_tokens != null) request.output = u.output_tokens;
          if (u.input_tokens != null) request.input = u.input_tokens;
          if (u.cache_creation_input_tokens != null) request.cacheWrite = u.cache_creation_input_tokens;
          if (u.cache_read_input_tokens != null) request.cacheRead = u.cache_read_input_tokens;
        } else if (ev?.type === 'message_stop' && request) {
          opts.onRequestUsage?.(request);
          request = null;
        }
        if (ev?.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            streamed += ev.delta.text;
            opts.onDelta?.(ev.delta.text);
          } else if (ev.delta?.type === 'thinking_delta') {
            opts.onThinking?.(String(ev.delta.thinking ?? ''));
          }
        }
      } else if (msg.type === 'assistant') {
        const blocks: any[] = (msg as any).message?.content ?? [];
        const text = blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
        if (text) finalText = text; // keep the latest assistant text
        for (const b of blocks) {
          if (b?.type === 'tool_use') {
            const cmd = b.input?.command;
            toolCalls.push({ name: String(b.name ?? ''), command: typeof cmd === 'string' ? cmd.slice(0, 2000) : null });
            if ((b.name === 'WebSearch' || b.name === 'WebFetch') && b.id) {
              webUses.set(String(b.id), { name: b.name, input: String(b.input?.query ?? b.input?.url ?? '').slice(0, 2000) });
            }
          }
        }
      } else if (msg.type === 'user') {
        /**
         * The tool results the model saw, read for provenance only. Until
         * 2b-4 these were ignored, so nothing could tell a URL the search
         * actually returned from one the model wrote down from memory.
         */
        const blocks: any[] = Array.isArray((msg as any).message?.content) ? (msg as any).message.content : [];
        for (const b of blocks) {
          if (b?.type !== 'tool_result') continue;
          const use = webUses.get(String(b.tool_use_id ?? ''));
          if (!use || captured.has(String(b.tool_use_id))) continue;
          const content = toolResultText(b.content);
          toolResults.push({ name: use.name, input: use.input, ok: b.is_error !== true, content });
          if (use.name === 'WebSearch' && b.is_error !== true && opts.debateId) SearchSeen.record(opts.debateId, content);
        }
      } else if (msg.type === 'result') {
        const r: any = msg;
        costUsd = r.total_cost_usd ?? 0;
        if (r.subtype === 'success' && typeof r.result === 'string') resultText = r.result;
        if (r.subtype === 'error_max_turns') maxTurnsHit = true;
        if (opts.debateId) Usage.role(opts.debateId, opts.label, costUsd);
        if (r.usage) {
          turnUsage = {
            input: r.usage.input_tokens ?? 0,
            output: r.usage.output_tokens ?? 0,
            cacheWrite: r.usage.cache_creation_input_tokens ?? 0,
            cacheRead: r.usage.cache_read_input_tokens ?? 0,
          };
        }
        if (opts.debateId && r.usage) {
          Usage.bump(opts.debateId, {
            input: r.usage.input_tokens ?? 0,
            output: r.usage.output_tokens ?? 0,
            cacheWrite: r.usage.cache_creation_input_tokens ?? 0,
            cacheRead: r.usage.cache_read_input_tokens ?? 0,
            webSearches: r.usage.server_tool_use?.web_search_requests ?? 0,
            costUsd,
          });
        }
        if (r.is_error && r.subtype !== 'error_max_turns') throw new Error('Claude Code returned an error');
      }
    }
  } catch (err) {
    // Our own timer fired: this is a timeout, not a stop, whatever the SDK calls it.
    if (timedOut) throw new TurnTimeoutError(opts.label ?? 'unlabeled', budgetMs);
    if (breach) throw new FetchBreachError(breach);
    const context = [
      stderrBuf ? `--- child stderr ---\n${stderrBuf}` : '',
      stdoutTail ? `--- child stdout tail ---\n${stdoutTail}` : '',
    ].filter(Boolean).join('\n');
    // Re-classified with the child's own words attached, so a limit stated on
    // stdout parks the session instead of reading as a bare crash. Redacted
    // first: this text reaches the console and the room's error event.
    const said = redactClaudeSecrets(context ? `${err}\n${context}` : String(err));
    const refused = claudeCredentialRefusal(said, AnthropicKeys.bound(opts.debateId));
    if (refused) throw refused;
    if (context) {
      const enriched = new Error(said);
      const limited = asUsageLimit(enriched);
      throw limited ?? enriched;
    }
    if (said !== String(err)) throw new Error(said);
    throw err;
  } finally {
    clearTimeout(timeout);
    if (opts.debateId) inflight.get(opts.debateId)?.delete(abort);
  }

  // A stopped turn may still have ended "normally"; what it read must not be used either way.
  if (breach) throw new FetchBreachError(breach);
  const text = (resultText ?? finalText ?? streamed).trim();
  if (!text && opts.toolGate && (maxTurnsHit || gateStopped)) {
    throw new GatedLoopExhausted(opts.label ?? 'unlabeled', { sessionId, costUsd, usage: turnUsage, toolCalls, ...(toolResults.length ? { toolResults } : {}) });
  }
  if (!text) throw new Error(`agent turn produced no text (${opts.label ?? 'unlabeled'})`);
  return { text, sessionId, costUsd, usage: turnUsage, toolCalls, ...(toolResults.length ? { toolResults } : {}) };
}

/**
 * The Codex branch, shared by runAgent and runJsonAgent so the boundary is
 * stated once.
 *
 * A debate bound to a Codex credential never spawns the Claude CLI and never
 * calls the OpenAI API. Checked BEFORE the OpenAI branch, because a Codex
 * session's model string is an ordinary `gpt-*` id that isOpenAIModel() would
 * happily claim.
 */
function codexBound(opts: AgentTurnOpts): boolean {
  return !!(opts.debateId && CodexCreds.bound(opts.debateId));
}

/**
 * A spent allowance, latched per debate.
 *
 * Many seats treat a failed call as a quality loss and carry on (a referee
 * with no verdict, a silent seat, a ruling from the fallback). That is right
 * for a fault and wrong for a spent allowance: carrying on would argue the
 * rest of the session on a dead line and ship a thinner debate. So the first
 * limit latches the debate: every later call fails fast with the same error
 * (no hammering a cooldown), and throwIfLimited() lets the engine stop at the
 * next safe point and PAUSE, whatever a catch block in between swallowed. The
 * runner clears the latch when it resumes.
 */
const limitLatch = new Map<string, UsageLimitError>();
export const LimitLatch = {
  get: (debateId: string) => limitLatch.get(debateId) ?? null,
  clear: (debateId: string) => { limitLatch.delete(debateId); },
};
export function throwIfLimited(debateId: string | undefined) {
  const l = debateId ? limitLatch.get(debateId) : undefined;
  if (l) throw l;
}
function latching<T>(opts: AgentTurnOpts, call: () => Promise<T>): Promise<T> {
  if (!opts.debateId) return call();
  const held = limitLatch.get(opts.debateId);
  if (held) return Promise.reject(held);
  return call().catch((err) => {
    const l = asUsageLimit(err);
    if (!l) throw err;
    if (!limitLatch.has(opts.debateId!)) limitLatch.set(opts.debateId!, l);
    throw l;
  });
}

/** One agent turn. Duplicates and runaway repeats are stopped by the waste guard (waste.ts). */
export function runAgent(opts: AgentTurnOpts): Promise<AgentTurnResult> {
  return latching(opts, () => guardCall(opts, () => runAgentOnce(opts)));
}

async function runAgentOnce(opts: AgentTurnOpts): Promise<AgentTurnResult> {
  if (fakeAgents) {
    const res = await fakeAgents.run(opts);
    // Streamed in small pieces, as a real turn is, so stream filters are exercised.
    for (let i = 0; i < res.text.length; i += 7) opts.onDelta?.(res.text.slice(i, i + 7));
    billFake(opts, res.usage, res.costUsd);
    return tally(opts, Promise.resolve(res));
  }

  // ---- Codex / ChatGPT-subscription dispatch ----
  if (codexBound(opts)) return tally(opts, runAgentCodex(opts));

  /**
   * ---- OpenAI dispatch. ----
   * A debate bound to the OpenAI API never spawns the Claude CLI, whatever
   * model id the caller asked for, so one debate stays on one provider.
   * Conversely, an OpenAI model id on a debate not bound to OpenAI cannot run
   * anywhere and fails as a credential problem, not a mystery.
   */
  if ((opts.debateId && OpenAIKeys.bound(opts.debateId)) || isOpenAIModel(opts.model)) {
    if (!opts.debateId || !OpenAIKeys.bound(opts.debateId)) {
      throw new CredentialError(`Model ${opts.model} runs on the OpenAI API, and this session is not an OpenAI session.`);
    }
    return tally(opts, runAgentOpenAI(opts));
  }

  await acquire(opts.job);
  const started = Date.now();
  try {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 1 + WASTE.agentRetries; attempt++) {
      try {
        const res = await runOnce(opts);
        const u = res.usage;
        console.log(
          `[agent] ${opts.label ?? '?'} ok in ${Math.round((Date.now() - started) / 1000)}s` +
            (res.costUsd ? ` ($${res.costUsd.toFixed(3)})` : '') +
            ` [in=${u.input} out=${u.output} cw=${u.cacheWrite} cr=${u.cacheRead}]`
        );
        return tally(opts, Promise.resolve(res));
      } catch (err) {
        lastErr = err;
        if (abortedByUser(err)) {
          console.log(`[agent] ${opts.label ?? '?'} aborted by stop request`);
          throw err;   // do not retry something the user cancelled
        }
        if (err instanceof CredentialError) throw err; // a refused key or login fails the same way twice
        if (err instanceof FetchBreachError) throw err;   // the same pages would be fetched again
        if (err instanceof GatedLoopExhausted) throw err;
        const limited = asUsageLimit(err);
        if (limited) {
          // Retrying a spent allowance cannot succeed and only pushes on a
          // cooldown. Surface it immediately so the driver can park.
          console.log(`[agent] ${opts.label ?? '?'} hit a ${limited.kind} usage limit; not retrying`);
          throw limited;
        }
        console.error(`[agent] ${opts.label ?? '?'} attempt ${attempt} failed:`, err);
      }
    }
    throw lastErr;
  } finally {
    release(opts.job);
  }
}

/** What a JSON turn hands back. `usage` is summed across its repair turns. */
export interface JsonTurn<T> {
  value: T;
  sessionId: string | null;
  toolCalls: { name: string; command: string | null }[];
  toolResults?: ToolResult[];
  costUsd?: number;
  usage?: RequestUsage;
}

const ZERO_USAGE: RequestUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
const addUsage =(a: RequestUsage, b: Partial<RequestUsage> | undefined): RequestUsage => ({
  input: a.input + (b?.input ?? 0),
  output: a.output + (b?.output ?? 0),
  cacheWrite: a.cacheWrite + (b?.cacheWrite ?? 0),
  cacheRead: a.cacheRead + (b?.cacheRead ?? 0),
});

/**
 * Runs an agent turn that must return strict JSON. Retries by resuming the same
 * session with the parse error so the model can correct itself.
 */
export function runJsonAgent<T>(opts: AgentTurnOpts, validate?: (v: any) => T): Promise<JsonTurn<T>> {
  return latching(opts, () => guardCall(opts, () => runJsonAgentOnce(opts, validate)));
}

async function runJsonAgentOnce<T>(opts: AgentTurnOpts, validate?: (v: any) => T): Promise<JsonTurn<T>> {
  if (fakeAgents?.runJson) {
    const res = await fakeAgents.runJson(opts);
    billFake(opts, res.usage, res.costUsd);
    return tally(opts, Promise.resolve({ value: validate ? validate(res.value) : (res.value as T), sessionId: res.sessionId ?? null, toolCalls: [], costUsd: res.costUsd ?? 0, usage: addUsage(ZERO_USAGE, res.usage) }));
  }

  // ---- Codex dispatch (same boundary as runAgent's; JSON turns get Codex's
  // `--output-schema` strict mode instead of bare prose). ----
  if (!fakeAgents && codexBound(opts)) return tally(opts, runJsonAgentCodex(opts, validate));

  // ---- OpenAI dispatch (same boundary as runAgent's; JSON turns get the
  // Responses API's structured-output formatting instead of bare prose). ----
  if (!fakeAgents && ((opts.debateId && OpenAIKeys.bound(opts.debateId)) || isOpenAIModel(opts.model))) {
    if (!opts.debateId || !OpenAIKeys.bound(opts.debateId)) {
      throw new CredentialError(`Model ${opts.model} runs on the OpenAI API, and this session is not an OpenAI session.`);
    }
    return tally(opts, runJsonAgentOpenAI(opts, validate));
  }

  // The unguarded turn: this whole JSON call is already guarded as one.
  let turn = await runAgentOnce(opts);
  /**
   * Accumulated across the repair turns, not taken from the last one. A repair
   * turn only reformats JSON and touches no tools, so reading the final turn
   * alone would report that an agent which spent ten minutes in python ran
   * nothing at all.
   */
  const toolCalls = [...turn.toolCalls];
  const toolResults = [...(turn.toolResults ?? [])];
  let costUsd = turn.costUsd ?? 0;
  let usage = addUsage(ZERO_USAGE, turn.usage);
  for (let attempt = 0; attempt <= WASTE.jsonRepairs; attempt++) {
    try {
      const value = extractJson(turn.text);
      return { value: validate ? validate(value) : (value as T), sessionId: turn.sessionId, toolCalls, ...(toolResults.length ? { toolResults } : {}), costUsd, usage };
    } catch (err) {
      if (attempt === WASTE.jsonRepairs) throw new Error(`JSON agent failed after retries (${opts.label}): ${err}`);
      turn = await runAgentOnce({
        ...opts,
        resume: turn.sessionId ?? opts.resume,
        prompt: `Your previous output could not be used: ${String(err).slice(0, 300)}\nOutput ONLY the corrected strict JSON. No prose, no code fences.`,
      });
      toolCalls.push(...turn.toolCalls);
      toolResults.push(...(turn.toolResults ?? []));
      costUsd += turn.costUsd ?? 0;
      usage = addUsage(usage, turn.usage);
    }
  }
  throw new Error('unreachable');
}

/** True when a turn ended because someone asked the session to stop. */
export function abortedByUser(err: unknown): boolean {
  // A timeout is not a stop. Checked first, because it is also an AbortError.
  if (err instanceof TurnTimeoutError || (err as any)?.name === 'TurnTimeoutError') return false;
  const m = String(err);
  return /abort/i.test(m) || (err as any)?.name === 'AbortError';
}

/** True when a turn ran out of its own time budget. */
export function isTurnTimeout(err: unknown): boolean {
  return err instanceof TurnTimeoutError || (err as any)?.name === 'TurnTimeoutError';
}

export function extractJson(text: string): any {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object found');
  return JSON.parse(cleaned.slice(start, end + 1));
}
