# Install and first-run report (branch wt/install)

## What was added

| Piece | Where | Notes |
|---|---|---|
| `npm run doctor` | `scripts/doctor.ts` | Pure `runChecks(env)` over an injected environment; prints PASS/WARN/FAIL with the exact fix. Exit 1 only on FAIL. |
| `npm start` | `scripts/start.mjs` | Plain Node. Checks Node 22+, deps installed, builds when output is missing or older than sources, refuses non-loopback `HOST` without `ACCESS_PASSWORD`, friendly port-in-use message, opens the browser once `/api/health` answers. `--no-open` skips the browser. |
| `npm run demo` | `start.mjs --mock` | Sets `MOCK=1` and, unless `DATA_DIR` is set, uses `data/demo` so demo debates never mix with real ones. |
| Friendly errors | `server/src/friendly.ts` | Engine failures become one plain sentence in the room (raw error stays in the terminal). Fastify error handler hides 500 details. Boot errors for EADDRINUSE/EACCES are explained. |
| Docker | `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `docs/DOCKER.md` | Optional, marked advanced. Host side bound to `127.0.0.1`; mounts `./data`. |
| README | Quick start, dev table | Small edits only. |
| Tests | `scripts/doctor.selftest.ts`, `server/src/friendly.selftest.ts` | Added to `npm run qa`. |

## What doctor checks

Node version; `claude --version` and `claude auth status` (no model call); `OPENAI_API_KEY` presence (never printed; a test asserts the value cannot appear in output); Codex `auth.json` presence and shape (no network); port free; `./data` writable; SQLite opens in memory; and whether at least one provider is ready. Missing providers are WARN, not FAIL, because only one is needed and `npm run demo` works with none.

## Verification

typecheck, build, `npm run qa` (including both new self-tests) and `npm run security-test` (78 passed, 0 failed) all pass. `npm run doctor` was run on this machine (all PASS for Claude and Codex, WARN for the unset OpenAI key). `start.mjs --mock --no-open` was run on port 8824, answered `/api/health`, and was stopped. No model calls were made.

## Not verified

- Docker was not built or run (no Docker commands were approved in this environment), so the Dockerfile and compose file are untested. Specific risks: the pruned `node_modules` carrying the native `better-sqlite3` build across stages, and `CLAUDE_CODE_OAUTH_TOKEN` as the Claude passthrough (documented from the Claude Code CLI's `setup-token`, not exercised).
- `claude auth status` output format on other CLI versions. Doctor treats an unrecognised answer as "could not tell" (WARN), never as a pass.
- Whether a real Claude failure (logged out) reaches the room as a thrown error matching `friendlyError`'s patterns, or as result text. It needs a live call to confirm; the fallback sentence is generic and safe either way.
- The browser auto-open on Linux/Windows (`xdg-open`, `cmd start`) is untested; failure prints the URL.

## Decisions and open questions

- Containers need `HOST=0.0.0.0`, so Docker requires `ACCESS_PASSWORD`. Is a sign-in screen acceptable for Docker users, or should the app trust a loopback-published port?
- `claude` availability still reports `true` in `/api/me` (the CLI only reports a missing login on the first turn). Doctor covers this offline; a cached status probe in the server could move it into the New Debate screen.
- Stale-build detection uses file mtimes; a `git checkout` that touches old files may trigger a harmless rebuild.
- The demo shares the provider-availability code path with mock mode, so all three providers show as selectable in the demo.
