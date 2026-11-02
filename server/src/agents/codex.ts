import fs from 'node:fs';
import path from 'node:path';
import type { CodexOptions, ThreadEvent, ThreadOptions } from '@openai/codex-sdk';
import { CredentialError } from './openai.ts';
import type { AgentTurnOpts, AgentTurnResult } from './sdk.ts';

/**
 * Codex / ChatGPT-subscription client for debate agent turns.
 *
 * The THIRD door. sdk.ts spawns the Claude Code CLI; openai.ts speaks HTTPS to
 * the OpenAI Responses API on a pay-as-you-go API key; this module spawns the
 * Codex CLI on a user's ChatGPT Plus/Pro *subscription* — no API key exists
 * anywhere on this path, and the user pays nothing beyond the subscription
 * they already hold.
 *
 * The credential is the WHOLE `~/.codex/auth.json` file, verbatim:
 *
 *   { "auth_mode": "chatgpt", "OPENAI_API_KEY": null,
 *     "tokens": { "id_token": <JWT>, "access_token": <JWT>,
 *                 "refresh_token": <JWT>, "account_id": <uuid> },
 *     "last_refresh": <iso8601> }
 *
 * It is NOT a scoped API key. It carries a live session for the user's entire
 * ChatGPT account, refresh token included — OpenAI's own guidance is to treat
 * it like a password. Everything in this file is built on that premise: the
 * blob never enters an environment variable, never enters a log, never enters
 * an error message, and never goes back over the wire to a browser.
 *
 * PER-USER ISOLATION. CodexOptions.env REPLACES process.env entirely (the SDK
 * documents this: "When provided, the SDK will not inherit variables from
 * process.env"), so every turn runs with exactly three variables — PATH, HOME
 * and CODEX_HOME — the latter two pointing at a directory that belongs to ONE
 * debate. Nothing of the host's environment, and nothing of another user's
 * credential, is reachable from inside. Same promise cleanEnv() makes on the
 * Claude path, kept by a different mechanism.
 *
 * SERIALISATION. Turns on a given credential are strictly one at a time; see
 * withCredentialLock below. This is an OpenAI constraint, not a preference.
 *
 * DEPENDENCY RULE, inherited from openai.ts and for the same reason: no
 * runtime import here touches config.ts or the database. The usage ledger, the
 * timeouts, the data directory and (for tests) the Codex factory itself all
 * arrive through wireCodex() at boot, so codex.selftest.ts can import this
 * file, hand it a mock Codex, and assert every byte of what would be spawned.
 *
 * EVERY CLAIM BELOW WAS MEASURED on this machine on 8 Aug 2026 against
 * @openai/codex-sdk@0.147.0, the Codex CLI binary it depends on, and a real
 * ChatGPT credential. Where something is inferred rather than measured, the
 * comment says so.
 */

// ---- model identity ----

/**
 * The Codex door runs the same OpenAI model ids as the API door (see
 * MODEL_IDS.codex in shared/models.ts). Verified offline against the model
 * catalogue embedded in the Codex CLI that @openai/codex-sdk 0.164.0 ships:
 * gpt-6-astra, gpt-6.1-sol and gpt-6-luna are listed, each with a 272K
 * context window. Which door a debate uses is decided by the debate's
 * provider binding, never by the model id.
 */

// ---- credential shape ----

export interface CodexAuth {
  /** The raw file, byte for byte. This is what gets written to CODEX_HOME. */
  raw: string;
  accountId: string;
  /** free | plus | pro | business | enterprise | edu — straight from the id_token claim. */
  planType: string | null;
  /** The ChatGPT account claim — stable across token rotation, so it anchors identity. */
  chatgptAccountId: string | null;
  subject: string | null;
  /** Unix seconds. Null when the JWT could not be decoded (signatures are never verified). */
  idTokenExp: number | null;
  accessTokenExp: number | null;
  lastRefresh: string | null;
}

/**
 * Cheap pre-check: does this credential even LOOK like an auth.json blob?
 * Used by the provider router before anything is parsed, so a `sk-...` key
 * never takes this path and a JSON blob never lands in an env var.
 */
export function looksLikeCodexAuth(credential: string): boolean {
  return credential.trim().startsWith('{');
}

/**
 * Read the claims out of a JWT payload.
 *
 * NOT verified, deliberately, and it does not need to be: this is the USER'S
 * OWN credential, handed to us by the user, and the only things read out of it
 * are a plan label we show back to them, an identity anchor, and an expiry we
 * use to refuse a dead paste early. Nothing is authorised on the strength of
 * it — OpenAI verifies the signature when the token is actually spent. Total
 * failure to decode is fine and returns null.
 */
function jwtPayload(jwt: string): Record<string, any> | null {
  try {
    const part = jwt.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Parse and validate an auth.json paste, with an error precise enough to act
 * on. Every branch names the file the user actually has in their hand, because
 * "invalid credential" to someone staring at a directory full of Codex files
 * is not an answer.
 */
export function parseCodexAuth(credential: string): { ok: true; auth: CodexAuth } | { ok: false; error: string } {
  const raw = (credential ?? '').trim();
  if (!raw.startsWith('{')) {
    return { ok: false, error: 'That is not a Codex auth.json. Run `codex login` and choose Sign in with ChatGPT.' };
  }
  let doc: any;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'That JSON will not parse. Copy the whole file — every character from the opening { to the closing } — out of ~/.codex/auth.json.' };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: 'That JSON is not an object. ~/.codex/auth.json is a single object with a "tokens" field inside it.' };
  }
  // The most likely wrong file in that directory, named so nobody has to hunt.
  if (!doc.tokens && (doc.model || doc.model_reasoning_effort || doc.sandbox_mode || doc.approval_policy)) {
    return { ok: false, error: 'That looks like a Codex config file, not auth.json. You want ~/.codex/auth.json — the one with a "tokens" object in it.' };
  }

  const tokens = doc.tokens;
  const apiKeyMode = doc.auth_mode === 'apikey' || (typeof doc.OPENAI_API_KEY === 'string' && doc.OPENAI_API_KEY);
  if (!tokens || typeof tokens !== 'object' || !tokens.access_token) {
    if (apiKeyMode) {
      return {
        ok: false,
        error: 'That auth.json is in API-key mode — it holds an OpenAI API key and no ChatGPT subscription tokens. Either run `codex login` and choose "Sign in with ChatGPT", or use the "OpenAI: API key" door with OPENAI_API_KEY instead.',
      };
    }
    if (!tokens || typeof tokens !== 'object') {
      return { ok: false, error: 'That auth.json has no "tokens" object. Run `codex login`, sign in with your ChatGPT account, then copy the file again.' };
    }
    return { ok: false, error: 'That auth.json has no access_token in its "tokens" object. Run `codex login` again and copy the fresh file.' };
  }
  if (typeof tokens.access_token !== 'string') {
    return { ok: false, error: 'That auth.json has no usable access_token in its "tokens" object. Run `codex login` again and copy the fresh file.' };
  }
  if (typeof tokens.account_id !== 'string' || !tokens.account_id) {
    return { ok: false, error: 'That auth.json has no account_id in its "tokens" object. Run `codex login` again and copy the fresh file.' };
  }

  const idClaims = typeof tokens.id_token === 'string' ? jwtPayload(tokens.id_token) : null;
  const authClaim = idClaims?.['https://api.openai.com/auth'] ?? {};
  const accessClaims = jwtPayload(tokens.access_token);

  return {
    ok: true,
    auth: {
      raw,
      accountId: tokens.account_id,
      planType: typeof authClaim.chatgpt_plan_type === 'string' ? authClaim.chatgpt_plan_type : null,
      chatgptAccountId: typeof authClaim.chatgpt_account_id === 'string' ? authClaim.chatgpt_account_id : null,
      subject: typeof idClaims?.sub === 'string' ? idClaims.sub : null,
      idTokenExp: typeof idClaims?.exp === 'number' ? idClaims.exp : null,
      accessTokenExp: typeof accessClaims?.exp === 'number' ? accessClaims.exp : null,
      lastRefresh: typeof doc.last_refresh === 'string' ? doc.last_refresh : null,
    },
  };
}

/**
 * The identity anchor for a Codex account, and the reason it exists.
 *
 * The Codex CLI ROTATES auth.json — new access_token, new last_refresh, and
 * (OpenAI's CI guide says refresh tokens are single-use) a new refresh token —
 * so a hash of the file would change within hours. So identity is taken over the parts that do NOT rotate: the ChatGPT account
 * id and the subject claim. Same person, same account, any vintage of the file.
 *
 * It is also the key the serialisation lock is taken on, which is why it must
 * be the ACCOUNT and not the debate: two debates by the same user share one
 * refresh-token chain and must not run turns at the same time.
 */
export function codexIdentity(credential: string): string | null {
  const parsed = parseCodexAuth(credential);
  if (!parsed.ok) return null;
  const a = parsed.auth;
  return `codex:${a.chatgptAccountId ?? a.accountId}:${a.subject ?? ''}`;
}

/** Which of two auth.json blobs is newer, by last_refresh. Ties keep the incumbent. */
export function codexIsNewer(candidate: string, incumbent: string): boolean {
  const a = parseCodexAuth(candidate);
  const b = parseCodexAuth(incumbent);
  if (!a.ok) return false;
  if (!b.ok) return true;
  const ta = Date.parse(a.auth.lastRefresh ?? '');
  const tb = Date.parse(b.auth.lastRefresh ?? '');
  if (!Number.isFinite(ta)) return false;
  if (!Number.isFinite(tb)) return true;
  return ta > tb;
}

/**
 * Intake check for a Codex credential.
 *
 * Mirrors validateOpenAIKey's posture: a DEFINITIVE problem is refused with a
 * plain answer, anything uncertain lets the user through (a dead credential
 * then surfaces on the first agent turn, the cheapest place left).
 *
 * The check is OFFLINE on purpose. The only live verification available on
 * this door is spawning a whole Codex turn, and a turn costs the user
 * rate-limit budget on a metered five-hour window — the one currency this
 * provider actually has. MEASURED: a real turn is ~11,000 input tokens before
 * the prompt even starts, because the CLI prepends its own agent instructions.
 * Spending that on a readiness check, where a network hiccup would close a door
 * that should stay open, is the wrong trade.
 *
 * `warning` is not a refusal. A free ChatGPT plan CAN hold a valid credential
 * — measured: a free-plan credential completed real turns on the previous
 * model generation — it is simply metered harder and may be refused mid-session.
 * The user is told, and decides.
 */
export function validateCodexAuth(
  credential: string,
  now = Date.now()
): { ok: true; planType: string | null; warning: string | null } | { ok: false; error: string } {
  const parsed = parseCodexAuth(credential);
  if (!parsed.ok) return parsed;
  const a = parsed.auth;

  /**
   * WHAT NOT TO REFUSE ON, and how that was learned.
   *
   * The obvious expiry check is the id_token's, and it is WRONG. MEASURED on a
   * real, fully working credential: the id_token had a ONE-HOUR life and had
   * expired two days earlier, while the same file completed real Codex turns
   * without complaint. It is an OIDC identity token, not a spending
   * credential; refusing on it would have rejected essentially every
   * credential anyone ever pastes, since almost none is under an hour old.
   * The first version of this function did exactly that, and an end-to-end run
   * against a real account is the only reason it did not ship.
   *
   * The access_token is the one that spends, and it measured a ten-day life.
   * Even that is not fatal on its own: an expired access token is precisely
   * what the refresh token is for, and the CLI renews it silently on the next
   * turn.
   *
   * So the only offline state that is genuinely unrecoverable is an expired
   * access token with NO refresh token to renew it. That is refused. Anything
   * else goes through, in keeping with the rule the other doors follow: a
   * dead credential surfaces on the first agent turn, and refusing a live one
   * at the door is the more expensive mistake.
   */
  let refreshToken: unknown;
  try { refreshToken = JSON.parse(a.raw)?.tokens?.refresh_token; } catch { refreshToken = undefined; }
  const accessExpired = a.accessTokenExp !== null && a.accessTokenExp * 1000 < now;
  if (accessExpired && !(typeof refreshToken === 'string' && refreshToken)) {
    return {
      ok: false,
      error: 'That Codex login has expired and carries no refresh token, so nothing can renew it. Run `codex login` again.',
    };
  }

  const plan = (a.planType ?? '').toLowerCase();
  if (plan === 'free' || plan === 'free_workspace') {
    return {
      ok: true,
      planType: a.planType,
      warning:
        'Heads up: this ChatGPT account is on the free plan. Codex on a free plan is metered hard and can be refused outright part-way through. Debates will start; they may not finish. Plus or Pro is what this door is built for.',
    };
  }
  if (accessExpired) {
    return {
      ok: true,
      planType: a.planType,
      warning:
        'That auth.json is a little stale — its access token has lapsed. It should renew itself on the first turn using its refresh token. If debates fail to start, run `codex login` again.',
    };
  }
  return { ok: true, planType: a.planType, warning: null };
}

// ---- wiring from sdk.ts (no runtime imports; see header) ----

interface UsageSink {
  bump(debateId: string, turn: {
    input?: number; output?: number; cacheWrite?: number; cacheRead?: number;
    webSearches?: number; costUsd?: number;
  }): void;
  role(debateId: string, label: string | undefined, usd: number): void;
}

/** Just enough of the SDK's Codex class to be swappable for a mock in tests. */
export interface CodexLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}
export interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(
    input: string,
    turnOptions?: { outputSchema?: unknown; signal?: AbortSignal }
  ): Promise<{ events: AsyncIterable<ThreadEvent> }>;
}

/**
 * What gets handed to `new Codex(...)`. Exported so the selftest can assert
 * every byte of it — the env isolation and the sandbox profile are the two
 * security properties of this provider, and both live in this object.
 */
export type CodexClientOptions = Required<Pick<CodexOptions, 'env' | 'config'>>;

/**
 * Load the SDK's Codex class, lazily and through a REAL dynamic import.
 *
 * `new Function` is not a trick for its own sake; it is the only way this
 * survives deployment. `@openai/codex-sdk` is ESM-only — its package exports
 * name a single `import` condition and nothing else — while the production
 * server is an esbuild CJS bundle (`npm start` runs server/dist/index.cjs). A static import would be inlined into the bundle and
 * break on `import.meta.url`, which the SDK uses to locate the Codex binary; a
 * plain `import()` would be rewritten by esbuild into `require()`, which
 * throws ERR_REQUIRE_ESM on an ESM-only package. Hiding the import inside a
 * Function body makes it opaque to the bundler and leaves a genuine dynamic
 * import at runtime, which CJS is allowed to do.
 *
 * Lazy as well as dynamic: an instance that never has a Codex debate never
 * loads the SDK at all.
 */
type CodexCtor = new (options: CodexOptions) => unknown;
let codexCtor: CodexCtor | null = null;

async function loadCodex(): Promise<CodexCtor> {
  if (codexCtor) return codexCtor;
  const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
  const mod = await dynamicImport('@openai/codex-sdk');
  if (!mod?.Codex) throw new Error('@openai/codex-sdk loaded but exported no Codex class');
  codexCtor = mod.Codex as CodexCtor;
  return codexCtor;
}

const wiring: {
  usage: UsageSink | null;
  defaultTimeoutMs: number;
  maxConcurrent: number;
  /** Where a debate's private CODEX_HOME is materialised. sdk.ts passes config.debateDir. */
  debateDir: (id: string) => string;
  /** Constructs the Codex client. Overridden by the selftest; nothing else. */
  codexFactory: (opts: CodexClientOptions) => Promise<CodexLike>;
} = {
  usage: null,
  defaultTimeoutMs: 10 * 60_000,
  maxConcurrent: 3,
  debateDir: (id: string) => path.join(process.cwd(), 'data', 'debates', id),
  codexFactory: async (opts) => {
    const Ctor = await loadCodex();
    return new Ctor(opts) as CodexLike;
  },
};

/** Called once from sdk.ts at boot; the selftest calls it with a temp dir and a mock Codex. */
export function wireCodex(w: Partial<typeof wiring>) {
  Object.assign(wiring, w);
}

// ---- per-credential registry ----

interface Cred {
  /** The freshest auth.json we know of. Updated in place after every turn. */
  json: string;
  /** Handed the rotated file so the caller can persist it. */
  onRefresh?: (updated: string) => void;
  /** The user's own auth.json on disk, re-read before every turn. */
  sourcePath?: string;
}

/**
 * Keyed by ACCOUNT identity, not by debate, and that is load-bearing twice
 * over. One user may have several debates open; they share one ChatGPT
 * session, one refresh-token chain, and therefore one lock and one copy of the
 * credential. If each debate kept its own copy, debate A would refresh the
 * token, debate B would keep spending the old one, and OpenAI would reject the
 * reused refresh token for both.
 *
 * The credential is resolved from debateId INSIDE the call — never a per-call
 * parameter, never process.env — for exactly the reason AgentAuth in sdk.ts is
 * a registry: a forgotten argument here silently runs a debate on
 * someone else's subscription. NOTHING in this file may log, return or
 * serialise the contents.
 */
const credsByIdentity = new Map<string, Cred>();
const identityByDebate = new Map<string, string>();

export const CodexCreds = {
  use(debateId: string, json: string, onRefresh?: (updated: string) => void, sourcePath?: string) {
    const raw = (json ?? '').trim();
    const identity = codexIdentity(raw) ?? `codex:unparsed:${debateId}`;
    identityByDebate.set(debateId, identity);

    const existing = credsByIdentity.get(identity);
    /**
     * A re-bind with an OLDER file must not overwrite a fresher one: the copy
     * in memory may have been refreshed by a turn since the file was read.
     * Taking the stale one would spend a dead access token and, because
     * refresh tokens are single-use, could break the login for no reason.
     */
    if (existing && !codexIsNewer(raw, existing.json)) {
      existing.onRefresh = onRefresh ?? existing.onRefresh;
      existing.sourcePath = sourcePath ?? existing.sourcePath;
      return;
    }
    credsByIdentity.set(identity, {
      json: raw,
      onRefresh: onRefresh ?? existing?.onRefresh,
      sourcePath: sourcePath ?? existing?.sourcePath,
    });
  },
  drop(debateId: string) {
    const identity = identityByDebate.get(debateId);
    identityByDebate.delete(debateId);
    if (!identity) return;
    // Only forget the credential when no other debate of this account holds it.
    for (const id of identityByDebate.values()) if (id === identity) return;
    credsByIdentity.delete(identity);
  },
  bound(debateId: string): boolean {
    const identity = identityByDebate.get(debateId);
    return !!identity && credsByIdentity.has(identity);
  },
  /** Test seam only. Never call this from anything that logs. */
  peekIdentity(debateId: string): string | undefined {
    return identityByDebate.get(debateId);
  },
};

// ---- the user's own Codex login ----

/**
 * The local `codex login` at $CODEX_HOME/auth.json. This app keeps no copy of
 * its own: the file is re-read before every turn, so a refresh made by the
 * user's own Codex CLI is picked up, and a rotation made during one of our
 * turns is written back, because refresh tokens are single-use and an
 * unwritten rotation would sign the user's own CLI out.
 */
export function readLocalCodexAuth(authPath: string): string | null {
  try {
    const raw = fs.readFileSync(authPath, 'utf8').trim();
    return parseCodexAuth(raw).ok ? raw : null;
  } catch {
    return null;
  }
}

/** Write a rotated login back, unless the user's own CLI has since written a newer one. */
export function writeBackLocalCodexAuth(authPath: string, updated: string) {
  const current = readLocalCodexAuth(authPath);
  if (current && !codexIsNewer(updated, current)) return;
  const tmp = `${authPath}.debate-${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${updated.trim()}\n`, { mode: 0o600 });
  fs.renameSync(tmp, authPath);
}

/** Bind a debate to the local Codex login. False when there is no usable login. */
export function bindLocalCodex(debateId: string, authPath: string): boolean {
  const raw = readLocalCodexAuth(authPath);
  if (!raw) return false;
  CodexCreds.use(debateId, raw, (updated) => writeBackLocalCodexAuth(authPath, updated), authPath);
  return true;
}

// ---- serialisation: one turn at a time, per credential ----

/**
 * ONE TURN AT A TIME PER CREDENTIAL. This is a documented OpenAI constraint,
 * not a design preference.
 *
 * OpenAI's Codex CI/CD authentication guide states it verbatim: "Use one
 * auth.json per runner or per serialized workflow stream. Do not share the
 * same file across concurrent jobs or multiple machines." Refresh tokens are
 * single-use — the client carries a distinct refresh-token-reused error — and
 * a refresh REWRITES auth.json. Two concurrent turns on one credential
 * therefore rotate the token out from under each other and hard-fail, and the
 * failure is not a clean one: the surviving process holds a refresh token that
 * has already been spent, so the account stops working until the user runs
 * `codex login` again.
 *
 * This app runs agent turns concurrently in several places — the position-card
 * step fires one call per expert through Promise.allSettled, the adversary
 * desk runs three seats at once, research runs in the background alongside the
 * floor, and CFG.maxConcurrentAgents allows several subprocesses generally. On
 * a Codex session every one of those would collide.
 *
 * So each credential gets a FIFO queue. Callers QUEUE, they are never
 * rejected. The lock is held across the whole turn — from materialising
 * CODEX_HOME, through the run, until the rotated auth.json has been read back
 * and handed to the write-back callback — because the write-back is exactly the
 * critical section that must not interleave.
 *
 * The honest cost, stated plainly: a Codex floor round is SEQUENTIAL where a
 * Claude one is parallel, so a round takes roughly (experts x turn time)
 * instead of (turn time). That is slower. Silent token-rotation failure is not
 * an acceptable alternative.
 */
const credQueues = new Map<string, Promise<unknown>>();

export function withCredentialLock<T>(identity: string, fn: () => Promise<T>): Promise<T> {
  const prev = credQueues.get(identity) ?? Promise.resolve();
  // `fn` runs whether the predecessor resolved or rejected: one failed
  // turn must not wedge the queue for the rest of their session.
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {}
  );
  credQueues.set(identity, tail);
  void tail.then(() => {
    if (credQueues.get(identity) === tail) credQueues.delete(identity);
  });
  return run;
}

/** How many turns are queued or running for a credential. Diagnostics only. */
export function credentialQueueDepth(): number {
  return credQueues.size;
}

// ---- errors ----

/**
 * Same name as sdk.ts's TurnTimeoutError ON PURPOSE — isTurnTimeout() and
 * abortedByUser() there duck-type on `err.name`, and a runtime import of
 * sdk.ts from here would drag config.ts's side effects into the selftest.
 */
class CodexTurnTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`agent turn "${label}" exceeded its ${Math.round(ms / 1000)}s budget`);
    this.name = 'TurnTimeoutError';
  }
}

/**
 * Nothing that leaves this module may contain a token.
 *
 * Codex errors quote the failing request, and the failing request carries a
 * bearer JWT; these messages reach nine console.error sites and can reach the
 * session transcript. Any three-segment `eyJ...` blob, any `Bearer ...`, any
 * quoted token field, and the absolute CODEX_HOME path (which is where the
 * credential file lives) are struck out before the message is allowed to
 * exist.
 */
export function redactSecrets(message: string): string {
  return String(message ?? '')
    .replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '[redacted-token]')
    .replace(/\b([Bb]earer)\s+[A-Za-z0-9._~+/=-]{12,}/g, '$1 [redacted-token]')
    .replace(/"(access_token|id_token|refresh_token)"\s*:\s*"[^"]*"/g, '"$1":"[redacted]"')
    .replace(/\S*codex-home\S*/g, '[codex-home]');
}

/**
 * Classify a failure from the CLI.
 *
 * Order matters: a spent credential and a spent allowance both mention
 * "token", and only one of them is worth retrying. Wordings below were read
 * out of the Codex binary itself rather than guessed —
 *   "You've hit your usage limit."  /  "You've hit your usage limit for ..."
 *   "OAuth refresh token was rejected:"
 *   "Failed to refresh token:"
 *   "Your access token could not be refreshed. Please log out and sign in again."
 * — and the rate-limit branch is worded so sdk.asUsageLimit() matches it, so
 * the driver PARKS the session and resumes it later instead of marking it
 * errored. On a subscription, hitting the five-hour window is the EXPECTED
 * failure, not an exceptional one.
 */
function classifyCodexError(rawMessage: string): Error {
  const raw = redactSecrets(rawMessage);
  if (
    /\b401\b|\b403\b|unauthoriz|unauthentic|not authenticated|please (?:sign|log) ?in|log out and sign in|refresh token was rejected|failed to refresh token|could not be refreshed|reused|invalid[_ ]?(?:grant|token)|credential/i.test(
      raw
    )
  ) {
    return new CredentialError(
      'This session runs on a ChatGPT: Codex sign-in that OpenAI would not accept. Run `codex login` again and re-supply ~/.codex/auth.json; the debate resumes where it stopped.'
    );
  }
  if (/\b429\b|rate.?limit|usage limit|quota|too many requests|try again (?:in|later)|limit reached/i.test(raw)) {
    return new Error(`429 usage limit reached on this ChatGPT plan: ${raw.slice(0, 240)}`);
  }
  return new Error(`Codex turn failed: ${raw.slice(0, 400)}`);
}

// ---- reasoning effort ----

/**
 * Thinking-token budget -> Codex `model_reasoning_effort`.
 *
 * The Claude path budgets thinking in TOKENS (CFG.*Thinking); Codex takes a
 * named tier. Mapping, keeping the app's intent per seat:
 *
 *   tokens        effort   seats that land here
 *   <= 12_000  -> low      lint rewrites (0), replies (2_000), steering (8_000)
 *   <= 32_000  -> medium   floor (24_000), referee/chair (32_000)
 *   <= 48_000  -> high     —
 *   >  48_000  -> xhigh    architect/planning/report (60_000)
 *
 * `minimal` and `none` are NOT emitted: the GPT-6 family supports
 * low/medium/high/xhigh/max (only Luna also accepts `none`), so fast-tier
 * calls floor at `low` rather than risk a rejected config value on the
 * cheapest and most frequent turns in the app. `max` is equally deliberately never
 * emitted: the CLI's own copy warns that high effort "can quickly consume Plus
 * plan rate limits", and rate limit is the only currency on this door.
 */
export function codexEffortFor(thinkingTokens: number | undefined): 'low' | 'medium' | 'high' | 'xhigh' {
  const t = thinkingTokens ?? 32_000;
  if (t <= 12_000) return 'low';
  if (t <= 32_000) return 'medium';
  if (t <= 48_000) return 'high';
  return 'xhigh';
}

// ---- CODEX_HOME materialisation ----

export interface CodexHome {
  dir: string;
  authPath: string;
  workDir: string;
}

/**
 * One private Codex home per debate, under that debate's own data directory.
 *
 * 0700 on the directory and 0600 on auth.json, written before the CLI is ever
 * spawned. The file is a live session for the user's whole ChatGPT account;
 * the mode bits are set explicitly rather than left to the process umask,
 * which is often 022 and would make the copy world-readable. The copy is
 * deleted again after every turn.
 *
 * The directory also becomes HOME for the child, so the CLI finds no
 * AGENTS.md, no config.toml, no skills, and no prior sessions belonging to
 * anyone else. That is the same isolation `settingSources: []` buys on the
 * Claude path. Measured: the CLI then populates it with its own sessions/,
 * caches and sqlite state, all of which stays inside this directory.
 */
export function materialiseCodexHome(debateId: string, authJson: string): CodexHome {
  const dir = path.join(wiring.debateDir(debateId), 'codex-home');
  const workDir = path.join(wiring.debateDir(debateId), 'codex-work');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  // mkdir's `mode` is masked by the umask, so it is re-asserted; a directory
  // left behind by an earlier release would otherwise keep its old mode.
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort on exotic filesystems */ }
  try { fs.chmodSync(workDir, 0o700); } catch { /* ditto */ }

  const authPath = path.join(dir, 'auth.json');
  fs.writeFileSync(authPath, authJson, { mode: 0o600 });
  try { fs.chmodSync(authPath, 0o600); } catch { /* ditto */ }
  return { dir, authPath, workDir };
}

/**
 * The environment the Codex CLI runs in. THREE variables, and no inheritance.
 *
 * CodexOptions.env replaces process.env wholesale, so this list is the entire
 * environment of the child and of anything it runs. Nothing from the parent's
 * environment (OPENAI_API_KEY, ACCESS_PASSWORD, ...) exists inside. Note what is ALSO absent: the credential itself.
 * It reaches the CLI as a file at CODEX_HOME/auth.json, never as an
 * environment variable, so it cannot leak through an `env` dump in a command
 * transcript.
 */
export function codexEnv(home: CodexHome): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home.dir,
    CODEX_HOME: home.dir,
  };
}

/**
 * SANDBOX POSTURE, and why it is expressed this way rather than the obvious
 * way.
 *
 * The obvious way is `sandboxMode: 'read-only'`. MEASURED, and it is not
 * enough: read-only restricts WRITES, it does not scope READS. Under
 * `sandboxMode: 'read-only'` a turn on this machine ran
 * `cat /private/tmp/.../canary.txt` — far outside its working directory —
 * and got the file back, exit 0.
 *
 * Read scoping needs Codex's permission profiles. THE TRAP, and it is a silent
 * one: profiles do not compose with the older sandbox settings. If
 * `sandbox_mode` appears in any loaded config, or `--sandbox` is passed, Codex
 * uses the old settings and IGNORES `default_permissions` entirely — and the
 * SDK's `sandboxMode` option is exactly `--sandbox`. So passing sandboxMode
 * would silently disable everything below.
 *
 * `sandboxMode` is therefore OMITTED, and the profile is passed through the
 * `config` option instead. MEASURED with the same canary: the identical `cat`
 * exited 134 (killed by the sandbox) with empty output, while an ordinary
 * no-tool debate turn, a strict `--output-schema` JSON turn, and a resumed
 * thread all completed normally.
 *
 * Everything else is belt and braces: no network, never ask for approval, no
 * web search, an empty working directory of its own, and no git repo check.
 * The provider is tool-less in effect and is treated as untrusted regardless —
 * the runner's capability gates keep the dossier, the python desk and web
 * research off it entirely.
 */
const PERMISSION_PROFILE = 'debate_locked';

export function codexConfigOverrides(): CodexClientOptions['config'] {
  return {
    default_permissions: PERMISSION_PROFILE,
    permissions: {
      [PERMISSION_PROFILE]: {
        // ":root" is Codex's special path meaning the whole filesystem.
        // "deny" is one of read | write | deny.
        filesystem: { ':root': 'deny' },
      },
    },
  };
}

/**
 * `web` is true for the research desk's thread ONLY (2b-4), and it changes one
 * thing: the model's own web_search tool is switched to live. The shell's
 * network stays off, the filesystem stays denied, and approval stays never;
 * every other turn on this door keeps web search disabled.
 */
export function codexThreadOptions(model: string, thinking: number | undefined, workDir: string, web = false): ThreadOptions {
  return {
    model,
    modelReasoningEffort: codexEffortFor(thinking),
    // sandboxMode is deliberately ABSENT — see codexConfigOverrides above.
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    webSearchEnabled: web,
    webSearchMode: web ? 'live' : 'disabled',
    workingDirectory: workDir,
    skipGitRepoCheck: true,
  };
}

// ---- semaphore (own lane; these are subprocesses) ----

let running = 0;
const waiters: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (running < wiring.maxConcurrent) { running++; return; }
  await new Promise<void>((resolve) => waiters.push(resolve));
  running++;
}
function release() {
  running--;
  waiters.shift()?.();
}

// ---- in-flight registry (so a stop request kills Codex turns too) ----

const inflight = new Map<string, Set<AbortController>>();

/** Called by sdk.abortDebate. Returns how many turns were killed. */
export function abortCodexDebate(debateId: string): number {
  const set = inflight.get(debateId);
  if (!set?.size) return 0;
  const n = set.size;
  for (const c of set) {
    try { c.abort(); } catch { /* already gone */ }
  }
  set.clear();
  return n;
}

// ---- system-prompt continuity ----

/**
 * Codex has no `system` parameter: a thread's identity is whatever its first
 * message said. So the persona's system prompt is prepended to the FIRST turn
 * of a thread and not re-sent afterwards — re-sending several thousand tokens
 * of persona on every floor turn would burn the user's five-hour window for
 * nothing, and the thread already holds it. MEASURED: a resumed thread
 * correctly answered "who are you" as the persona set two turns earlier.
 *
 * The exception, which is why this map exists: when a caller resumes a thread
 * with a DIFFERENT system prompt (Marcus re-casting a seat, a persona being
 * re-briefed), the thread has never seen it and must. Hashing is enough to
 * spot that. The map is memory-only, so after a restart the first turn of each
 * resumed thread re-sends the system prompt — the safe direction to fail in.
 */
const threadSystems = new Map<string, string>();

function systemFingerprint(system: string): string {
  let h = 2166136261;
  for (let i = 0; i < system.length; i++) {
    h ^= system.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${system.length}:${(h >>> 0).toString(36)}`;
}

/**
 * Stated once, at the top of a thread, because on this provider it is true for
 * every turn of that thread and there is no tool the model could have reached
 * for. The Claude path says nothing like this because there the tools are real.
 */
const CAPABILITY_NOTE =
  '\n\nCAPABILITY NOTE: In this session you have NO web access, NO file tools and NO code interpreter. ' +
  'Say plainly when a figure or source cannot be verified without them. Never invent a citation, a file quote, or a computed number.';

/** The research thread's note: it has a search tool, and nothing else. */
const RESEARCH_CAPABILITY_NOTE =
  '\n\nCAPABILITY NOTE: In this session you have a web search tool and nothing else: NO file tools and NO code interpreter. ' +
  'Cite only pages your searches actually returned. Never invent a citation, a quote, or a figure.';

export function composeInput(opts: AgentTurnOpts): string {
  const fingerprint = systemFingerprint(opts.system);
  const known = opts.resume ? threadSystems.get(opts.resume) : undefined;
  if (opts.resume && known === fingerprint) return opts.prompt;
  return `${opts.system}${opts.web ? RESEARCH_CAPABILITY_NOTE : CAPABILITY_NOTE}\n\n---\n\n${opts.prompt}`;
}

function rememberSystem(threadId: string | null, system: string) {
  if (!threadId) return;
  threadSystems.set(threadId, systemFingerprint(system));
  // Unbounded growth would be a slow leak across weeks of uptime; a debate
  // holds a few dozen threads and the app a few hundred at most.
  if (threadSystems.size > 5000) {
    for (const k of threadSystems.keys()) {
      threadSystems.delete(k);
      if (threadSystems.size <= 4000) break;
    }
  }
}

// ---- credential refresh write-back ----

/**
 * THE line that keeps this door open past today.
 *
 * The Codex CLI refreshes the access token and REWRITES auth.json inside
 * CODEX_HOME. If that rewrite is not read back and written to the user's own
 * auth.json, the old refresh token is spent and the user has to log in again.
 * So after every turn, successful or not, the file is read back and any change
 * is handed to the caller's write-back callback. This runs INSIDE the
 * per-credential lock, so no other turn can be mid-flight with the superseded
 * token.
 *
 * Compared on the fields that actually rotate, not on the whole file, so a
 * cosmetic reformat by a future CLI does not rewrite the login every turn.
 */
export function readBackCredential(home: CodexHome, current: string): string | null {
  let after: string;
  try {
    after = fs.readFileSync(home.authPath, 'utf8');
  } catch {
    return null; // the CLI removed or never wrote it; keep what we have
  }
  if (!after.trim() || after.trim() === current.trim()) return null;

  const a = parseCodexAuth(after);
  const b = parseCodexAuth(current);
  if (!a.ok) return null;              // never adopt an unparseable file
  if (!b.ok) return after.trim();      // ours was junk; theirs parses

  let aTok: any, bTok: any;
  try {
    aTok = JSON.parse(after).tokens ?? {};
    bTok = JSON.parse(current).tokens ?? {};
  } catch {
    return null;
  }
  const rotated =
    a.auth.lastRefresh !== b.auth.lastRefresh ||
    aTok.access_token !== bTok.access_token ||
    aTok.id_token !== bTok.id_token ||
    aTok.refresh_token !== bTok.refresh_token;
  return rotated ? after.trim() : null;
}

// ---- core turn ----

async function runOnceCodex(opts: AgentTurnOpts, outputSchema?: Record<string, unknown>): Promise<AgentTurnResult> {
  const identity = opts.debateId ? identityByDebate.get(opts.debateId) : undefined;
  const cred = identity ? credsByIdentity.get(identity) : undefined;
  if (!identity || !cred) {
    throw new CredentialError(
      'This session runs on your Codex login, which is not available right now. Run `codex login`, then resume the debate.'
    );
  }

  // The user's own CLI may have refreshed the login since our last turn.
  if (cred.sourcePath) {
    const fresh = readLocalCodexAuth(cred.sourcePath);
    if (fresh && codexIsNewer(fresh, cred.json)) cred.json = fresh;
  }

  const home = materialiseCodexHome(opts.debateId!, cred.json);
  const codex = await wiring.codexFactory({ env: codexEnv(home), config: codexConfigOverrides() });

  const abort = new AbortController();
  const budgetMs = opts.timeoutMs ?? wiring.defaultTimeoutMs;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, budgetMs);

  if (opts.debateId) {
    let set = inflight.get(opts.debateId);
    if (!set) inflight.set(opts.debateId, (set = new Set()));
    set.add(abort);
  }
  if (opts.signal) {
    if (opts.signal.aborted) abort.abort();
    else opts.signal.addEventListener('abort', () => abort.abort(), { once: true });
  }

  const options = codexThreadOptions(opts.model, opts.thinking, home.workDir, !!opts.web);
  const thread = opts.resume ? codex.resumeThread(opts.resume, options) : codex.startThread(options);

  let threadId: string | null = opts.resume ?? null;
  const messages: string[] = [];
  /** The research thread's searches. The SDK's web_search item carries the query and no result URLs. */
  const searches: string[] = [];
  let usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let fatal: Error | null = null;
  /**
   * An `error` ITEM is not a failure. Only turn.failed and the stream-level
   * `error` event are fatal. Collected anyway, because when a turn DOES fail
   * with no other detail this is the only description of what went wrong.
   */
  const softErrors: string[] = [];

  try {
    const { events } = await thread.runStreamed(composeInput(opts), {
      ...(outputSchema ? { outputSchema } : {}),
      signal: abort.signal,
    });

    for await (const ev of events as AsyncIterable<ThreadEvent>) {
      switch (ev.type) {
        case 'thread.started':
          threadId = ev.thread_id;
          break;
        case 'item.completed': {
          const item = ev.item;
          if (item.type === 'agent_message' && item.text) {
            /**
             * WHOLE MESSAGES, NOT DELTAS — and this is a real, user-visible
             * difference from every other provider in this app.
             *
             * MEASURED: `item.updated` never fires for an agent_message, not
             * even on a 1,122-character response; across every probe run the
             * event sequence was exactly
             *   thread.started | turn.started | item.completed:agent_message | turn.completed
             * so a turn appears in one piece after a silence rather than
             * typing out live. The whole text is emitted to onDelta once, and
             * the returned text is exactly the concatenation of what was
             * emitted, so the live transcript and the stored message can never
             * disagree.
             *
             * TODO (restores live typing): the silence is a limitation of
             * `codex exec --experimental-json`, which is what this SDK drives
             * — NOT of Codex itself. One layer down, `codex app-server` speaks
             * JSON-RPC 2.0 over stdio and does emit true token deltas:
             *   item/agentMessage/delta
             *   item/reasoning/summaryTextDelta
             *   item/reasoning/textDelta
             * each shaped { threadId, turnId, itemId, delta }. Moving this
             * provider onto app-server would give the room the same live
             * rendering the Claude path has. Not attempted in this pass: the
             * SDK is the surface that is known to work end to end.
             */
            messages.push(item.text);
            opts.onDelta?.(item.text);
          } else if (item.type === 'reasoning' && item.text) {
            opts.onThinking?.(item.text);
          } else if (item.type === 'web_search') {
            searches.push(String(item.query ?? '').slice(0, 500));
          } else if (item.type === 'error' && item.message) {
            softErrors.push(item.message);
          }
          break;
        }
        case 'item.updated': {
          // Observed only for todo lists / plan updates, never for text. Kept
          // because a reasoning summary arriving this way costs nothing to
          // forward and keeps the room alive during a long silent turn.
          if (ev.item.type === 'reasoning' && ev.item.text) opts.onThinking?.(ev.item.text);
          break;
        }
        case 'turn.completed': {
          const u = ev.usage;
          /**
           * Recorded as-is, nothing invented. The ledger's `input` means
           * UNCACHED input on every provider, so the cached half is subtracted
           * rather than double-counted. Absent counts stay zero: a guessed
           * token count in a spend ledger is worse than a gap.
           */
          const cached = u?.cached_input_tokens ?? 0;
          usage = {
            input: Math.max(0, (u?.input_tokens ?? 0) - cached),
            output: u?.output_tokens ?? 0,   // includes reasoning_output_tokens
            cacheWrite: u?.cache_write_input_tokens ?? 0,
            cacheRead: cached,
          };
          break;
        }
        case 'turn.failed':
          fatal = classifyCodexError(ev.error?.message || softErrors.join(' | ') || 'turn failed');
          break;
        case 'error':
          fatal = classifyCodexError(ev.message || 'stream error');
          break;
        default:
          break; // turn.started, item.started: lifecycle noise
      }
    }
  } catch (err) {
    if (timedOut) throw new CodexTurnTimeoutError(opts.label ?? 'unlabeled', budgetMs);
    if ((err as any)?.name === 'AbortError') throw err;   // a user stop
    throw classifyCodexError(String((err as any)?.message ?? err));
  } finally {
    clearTimeout(timeout);
    if (opts.debateId) inflight.get(opts.debateId)?.delete(abort);
    /**
     * Read the rotated credential back even when the turn FAILED — an expired
     * access token is exactly the case where the CLI refreshes and the turn
     * still errors for some other reason, and losing that refresh would leave
     * the next turn holding a spent, single-use refresh token.
     */
    try {
      const updated = readBackCredential(home, cred.json);
      if (updated) {
        cred.json = updated;
        cred.onRefresh?.(updated);
      }
    } catch (err) {
      // Never fatal, and never verbose: the message could quote the file.
      console.error('[agent:codex] could not persist a refreshed credential:', redactSecrets(String((err as any)?.message ?? err)));
    }
    // No credential copy stays at rest in the data directory between turns.
    try { fs.rmSync(home.authPath, { force: true }); } catch { /* best effort */ }
  }

  if (fatal) throw fatal;

  rememberSystem(threadId, opts.system);

  const text = messages.join('\n\n').trim();
  if (!text) {
    throw new Error(
      `agent turn produced no text (${opts.label ?? 'unlabeled'})` +
        (softErrors.length ? `: ${redactSecrets(softErrors.join(' | ')).slice(0, 300)}` : '')
    );
  }

  /**
   * Zero, and it is not a placeholder. This turn was paid for by a
   * subscription the user already holds; there is no marginal charge to
   * report, and putting an API-rate estimate here would tell the founder his
   * session cost money nobody was billed. The token counts above are still
   * recorded in full, so "how much did this session consume" stays answerable
   * in the unit that actually binds on this door, which is the plan's rolling
   * usage window.
   */
  const costUsd = 0;
  if (opts.debateId && wiring.usage) {
    wiring.usage.role(opts.debateId, opts.label, costUsd);
    wiring.usage.bump(opts.debateId, {
      input: usage.input,
      output: usage.output,
      cacheWrite: usage.cacheWrite,
      cacheRead: usage.cacheRead,
      webSearches: searches.length,
      costUsd,
    });
  }

  return {
    text,
    sessionId: threadId,
    costUsd,
    usage,
    // Tool-less by policy (the audit gate reads this honestly), except the
    // research thread's searches, which are reported as what they are.
    toolCalls: searches.map((q) => ({ name: 'web_search', command: q })),
    ...(searches.length ? { toolResults: searches.map((q) => ({ name: 'web_search', input: q, ok: true, content: '' })) } : {}),
  };
}

/**
 * runAgent, Codex edition. Same retry posture as sdk.runAgent and
 * runAgentOpenAI: two attempts, but never for a user stop, a bad credential, a
 * timeout, or a usage limit — retrying any of those is at best useless and at
 * worst spends the user's rolling window faster.
 *
 * The per-credential lock wraps the WHOLE call including retries, so a retry
 * cannot interleave with another seat's turn on the same credential.
 */
export async function runAgentCodex(opts: AgentTurnOpts, outputSchema?: Record<string, unknown>): Promise<AgentTurnResult> {
  const identity = (opts.debateId ? identityByDebate.get(opts.debateId) : undefined) ?? 'codex:unbound';
  const queuedAt = Date.now();

  /**
   * A queue ticket, registered BEFORE the lock is taken.
   *
   * Serialisation creates a failure mode the other providers do not have: when
   * the user presses stop during a floor round, most of that round is not
   * running yet, it is sitting in this credential's queue. Only the in-flight
   * turn carries an AbortController, so without a ticket the stop would kill
   * one turn and then the five behind it would each start, one after another,
   * spending the user's usage window on a room that was told to be quiet.
   * The ticket makes a queued turn abortable, and it is checked on the way in
   * and between retries.
   */
  const ticket = new AbortController();
  if (opts.debateId) {
    let set = inflight.get(opts.debateId);
    if (!set) inflight.set(opts.debateId, (set = new Set()));
    set.add(ticket);
  }
  const stopped = () => {
    if (!ticket.signal.aborted) return null;
    const err = new Error(`agent turn "${opts.label ?? 'unlabeled'}" aborted before it started`);
    err.name = 'AbortError';
    return err;
  };

  try {
    return await withCredentialLock(identity, async () => {
      const queuedStop = stopped();
      if (queuedStop) throw queuedStop;
      await acquire();
      const started = Date.now();
      const waited = started - queuedAt;
      try {
        let lastErr: unknown;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const midStop = stopped();
            if (midStop) throw midStop;
            const res = await runOnceCodex(opts, outputSchema);
            const u = res.usage;
            console.log(
              `[agent:codex] ${opts.label ?? '?'} ok in ${Math.round((Date.now() - started) / 1000)}s` +
                (waited > 1000 ? ` (queued ${Math.round(waited / 1000)}s)` : '') +
                ` [in=${u.input} out=${u.output} cw=${u.cacheWrite} cr=${u.cacheRead}] (subscription, no marginal cost)`
            );
            return res;
          } catch (err) {
            lastErr = err;
            if ((err as any)?.name === 'TurnTimeoutError') throw err;
            if ((err as any)?.name === 'AbortError') {
              console.log(`[agent:codex] ${opts.label ?? '?'} aborted by stop request`);
              throw err;
            }
            if (err instanceof CredentialError) {
              console.log(`[agent:codex] ${opts.label ?? '?'} credential refused; not retrying`);
              throw err;
            }
            if (/\b429\b|rate.?limit|usage limit/i.test(String((err as any)?.message ?? ''))) {
              console.log(`[agent:codex] ${opts.label ?? '?'} hit a plan usage limit; not retrying`);
              throw err;
            }
            console.error(
              `[agent:codex] ${opts.label ?? '?'} attempt ${attempt} failed:`,
              redactSecrets(String((err as any)?.message ?? err))
            );
          }
        }
        throw lastErr;
      } finally {
        release();
      }
    });
  } finally {
    if (opts.debateId) inflight.get(opts.debateId)?.delete(ticket);
  }
}

// ---- JSON turns ----

/** Local copy of sdk.extractJson (6 lines) — a runtime import would drag in config.ts. */
export function extractJsonLoose(text: string): any {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object found');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * runJsonAgent, Codex edition — same contract and the same retry-on-invalid
 * behaviour as sdk.runJsonAgent: parse, validate, and on failure resume the
 * SAME thread with the parse error so the model corrects itself, three
 * attempts.
 *
 * When the caller supplies `opts.schema`, the turn runs with Codex's
 * `--output-schema`, which makes malformed JSON near-impossible and leaves the
 * retry loop firing only on a `validate` rejection. MEASURED end to end: a
 * strict schema turn returned a single JSON object matching the schema
 * exactly. Without a schema the loose extractor gives the behaviour the Claude
 * path has.
 */
export async function runJsonAgentCodex<T>(
  opts: AgentTurnOpts,
  validate?: (v: any) => T
): Promise<{ value: T; sessionId: string | null; toolCalls: { name: string; command: string | null }[]; usage: AgentTurnResult['usage'] }> {
  const schema = opts.schema?.schema;

  let turn = await runAgentCodex(opts, schema);
  // The research thread's searches, across the repair turns too.
  const toolCalls = [...turn.toolCalls];
  const usage = { ...turn.usage };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const value = extractJsonLoose(turn.text);
      return { value: validate ? validate(value) : (value as T), sessionId: turn.sessionId, toolCalls, usage };
    } catch (err) {
      if (attempt === 2) throw new Error(`JSON agent failed after retries (${opts.label}): ${err}`);
      turn = await runAgentCodex(
        {
          ...opts,
          resume: turn.sessionId ?? opts.resume,
          prompt: `Your previous output could not be used: ${String(err).slice(0, 300)}\nOutput ONLY the corrected strict JSON. No prose, no code fences.`,
        },
        schema
      );
      toolCalls.push(...turn.toolCalls);
      usage.input += turn.usage.input;
      usage.output += turn.usage.output;
      usage.cacheWrite += turn.usage.cacheWrite;
      usage.cacheRead += turn.usage.cacheRead;
    }
  }
  throw new Error('unreachable');
}
