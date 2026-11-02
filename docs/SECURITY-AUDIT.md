# Security audit: local single-user mode

**Date:** 2026-10-26 (Phase 1 of the open-source rework)
**Scope:** the access layer (`server/src/auth.ts`, `index.ts`, `api.ts`), credential handling (`config.ts`, `agents/sdk.ts`, `openai.ts`, `codex.ts`), the agent tool sandbox, upload handling and prompt fences, report serving, the backup importer, and dependencies.
**Method:** code review plus executable tests: `npm run security-test` (78 assertions against a live server in three configurations) and the self-tests in `npm run qa`.

An earlier audit of the hosted, multi-user version is superseded: accounts, guests, Telegram and Google sign-in no longer exist.

## Threat model

One person runs the app on their own machine. The assets are: that person's model credentials (Claude login, OpenAI key, Codex login), their debates and uploaded files, and their model quota. The attackers considered are:

1. **A web page in the user's browser** (CSRF, DNS rebinding, cross-origin reads of the API or the event stream).
2. **Another device on the same network**, if the user exposes the server.
3. **An uploaded file or a web page read by an agent** that carries prompt-injection text.
4. **Model-written output** (the report) rendered in the user's browser.

## Controls, and how each is verified

| Boundary | Control | Verified by |
|---|---|---|
| Network exposure | Binds 127.0.0.1; any other `HOST` without `ACCESS_PASSWORD` refuses to start | security-test B |
| DNS rebinding | Host header allowlist, 421 otherwise, on every route including static files | security-test A |
| Cross-origin reads | Origin check on every request (covers SSE, which runs before the socket is hijacked) | security-test A |
| CSRF | `x-csrf-token` on every POST/DELETE, HMAC-bound to the session (or to the process when there is no password); a custom header also forces a CORS preflight that is never granted | security-test A, C |
| Password sessions | 256-bit random ids, in memory, HttpOnly + SameSite=Strict cookie, server-side logout, 5 attempts/min/address, timing-safe compare | security-test C |
| Path tricks | Paths normalised (repeated decoding, `..`, backslashes) before any guard decision; debate ids validated against `^d_[A-Za-z0-9_-]{4,32}$` | security-test A, C |
| Credential secrecy | OpenAI key and password removed from `process.env` after reading; never in responses or logs; `/api/me` reports booleans only | security-test D (canary key and password searched in every response body) |
| Agent environment | Claude subprocess env is an allowlist (PATH, HOME, locale, optional CLAUDE_CODE_OAUTH_TOKEN); Codex env is exactly PATH/HOME/CODEX_HOME | codex selftest [6] |
| Agent tools | Experts hold none (`tools: []`, `dontAsk`); dossier file tools scoped to the upload dir; python seats in the OS sandbox, network denied, no unsandboxed fallback; Codex in a deny-all filesystem profile with no network | code review; codex selftest [7] |
| Codex login | Re-read per turn; rotation written back atomically at 0600 unless the user's CLI wrote a newer one; per-debate copy deleted after every turn | codex selftest [22] |
| Prompt injection | Upload text and the brief written from it sit inside content-hashed `<<<UNTRUSTED>>>` fences; forged markers neutralised; brief capped at 8K chars | prompts selftest |
| Report XSS | Renderer escapes; report served with `CSP: sandbox` (opaque origin, no cookie or API access); fallback page escapes too | code review; dev end-to-end check |
| Headers | nosniff, frame-options SAMEORIGIN, no-referrer | security-test A |
| Backup import | Only debates/events/workspaces; accounts, sessions, secrets, `.env`, `*.key`, `codex-home/`, `auth.json` excluded; source opened only as a temp copy and checked unchanged | run against the real backup |
| Dependencies | `npm audit`: 0 vulnerabilities after the Phase 1 upgrades | npm audit |

## Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | High (fixed) | The python quant desk had an unrestricted shell with network access; a prompt-injected upload could read local credential files and send them out. In the hosted version this was mitigated by restricting the desk to the owner; in local mode everyone is the owner. | **Fixed:** OS sandbox with no network for python-bearing seats. Not exercised against a live model in this phase (see Open items). |
| 2 | Medium (fixed) | Upload fences were prose-only; inline file delimiters (`===== FILE =====`) could be forged by a file. | **Fixed:** content-hashed markers, neutralisation, selftest. |
| 3 | Medium (fixed) | Model-written report HTML was served from the app's own origin. | **Fixed:** `CSP: sandbox`. |
| 4 | Medium (fixed) | The Codex door wrote a per-debate copy of the user's login into the data directory and kept it there. | **Fixed:** deleted after every turn; the source is the user's own `~/.codex`. |
| 5 | Low | The research desk and panel architect can fetch arbitrary URLs. A prompt-injected page, or a brief written from a hostile upload, could ask them to fetch an attacker URL with data in it. What they hold is the topic and the dossier brief, not credentials. | Accepted for now; listed on the roadmap (domain allowlist for fetches). |
| 6 | Low | Login rate limiting is per client address. Behind a reverse proxy every client shares one address, so a stranger can lock the owner out for a minute at a time. | Accepted; documented. Only relevant when exposed. |
| 7 | Low | The session cookie gets `Secure` only when the server itself sees HTTPS. | Accepted; local by default. Behind a TLS proxy the cookie is still HttpOnly and SameSite=Strict. |
| 8 | Low | `DATA_DIR` is created 0700, but an existing directory's mode is not changed. | Accepted; documented. |
| 9 | Info | The UI and reports load Google Fonts (IP disclosure to Google). | Roadmap: self-host fonts in the UI redesign. |
| 10 | Info | Write-back of a rotated Codex login can race with the user's own Codex CLI writing at the same moment; the loser has to `codex login` again. | Accepted; rare, recoverable. |

## Open items

- The OS sandbox for python seats (finding 1) and the Codex and OpenAI doors have not been run against live models in this phase, by instruction (no quota spent beyond model-id probes). The first real run should confirm the quant desk still computes inside the sandbox.

## Re-running

```bash
npm run security-test   # three server configurations, MOCK=1, throwaway data dirs
npm run qa              # includes provider client and prompt-fence self-tests
npm audit
```
