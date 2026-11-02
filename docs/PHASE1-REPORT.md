# Phase 1 report: foundation

**Date:** 2026-10-26
**Brief:** pin the models, make it local-first and open-source ready.
**Result:** done, with the open items listed at the end. Nothing was pushed; there is no remote.

## Commits

| Commit | What |
|---|---|
| `3eec52a` | Baseline: the received tree, minus `deploy/`, two internal operations reviews that described the private server, and rendered motion output. |
| `433873f` | Dependency upgrades: 14 audit advisories (2 critical, 11 high) to 0. |
| `2621523` | All model ids in `shared/models.ts`; product-decided seat casting; Fable 5 and gpt-5.6 removed; provider door replaces the model picker. |
| `f37e9ec` | Single-user local mode: hosted machinery removed, new access model, local credentials, security test rewritten. |
| `d8be89f` | `npm run import-backup`. |
| `b82aa3f` | Unforgeable prompt-injection fences around uploaded text. |
| `44ec67c` | Personal and hosted-era leftovers removed from code (hard-coded IST time zone, a real name in the sample report, probe scripts with personal paths). |
| `3b67e62` | LICENSE, README, SECURITY.md, .env.example, docs rewritten, ROADMAP. |
| (this commit) | This report, plus one self-review fix. |

## Test results (final run)

| Gate | Result |
|---|---|
| `npm run typecheck` | pass (server and web) |
| `npm run build` | pass |
| `npm run qa` | pass: report renderer "all documents measured clean"; prompt fences 10/10; OpenAI client 54/54; Codex client 120/120 |
| `npm run security-test` | 78 passed, 0 failed |
| `npm audit` | 0 vulnerabilities |
| `MOCK=1 npm run dev` | started; `/api/health` OK directly and through the Vite proxy; a mock debate created through the API with a CSRF token, driven through clarify and all three approvals, ran to `complete` (60 events, 18 messages); casting sheet showed `claude-opus-5-5` chair and `claude-haiku-4-5` bids; report served with `CSP: sandbox`; server stopped |
| Real engine on imported data | built server on `./data` listed and opened all 8 imported debates and a stored report; 0 agent turns started |
| Brief's grep | `git grep -nIiE` for the retired model ids, Telegram and the old hosting names returns two intentional historical notes only: `docs/SECURITY-AUDIT.md` (says the old Telegram/Google sign-in is gone) and `shared/models.ts` (names the legacy ids that old rows still carry) |

## Model verification

Probed with `claude -p x --model <id> --output-format json`:

| Id | canonicalModel | Context reported | Notes |
|---|---|---|---|
| `claude-opus-5-5` | `claude-opus-5-5` | 1,000,000 | costBasis "list" |
| `claude-sonnet-5-5` | `claude-sonnet-5-5` | 200,000 | costBasis "unknown" |
| `claude-haiku-4-5` | `claude-haiku-4-5` | 200,000 | costBasis "list"; its reported cost matched $1/$5 with cache reads at 0.1x exactly |
| `claude-bogus-9-9` (control) | none | | `is_error: true`, "may not exist", so the probe discriminates |

Sonnet 5.5 verified, so it is used for research and the dossier. Seven probes in total (two each for the three models, one control), about $0.40 at list rates.

OpenAI ids and prices came from the brief. Offline confirmation: the model catalogue inside the Codex CLI shipped with `@openai/codex-sdk` 0.164.0 lists `gpt-6-astra`, `gpt-6.1-sol` and `gpt-6-luna`, each with a 272K context window on that door. The 0.147.0 SDK the project pinned did not list them, so it was upgraded.

## Backup import

`npm run import-backup -- <backup>/2026-10-24/debate/data` (a copy of the old server's data folder):

- **8 debates imported** (2 complete, 4 cancelled, 1 error, 1 meeting), 1,900 events, 42 workspace files.
- `d_Y6GM5D7V` was mid-meeting; it is now `paused` with its old agent session ids cleared. It does not resume until you press Resume, and resuming spends quota.
- Not imported: accounts (11 rows), auth codes, grant requests, the session-secret file, backups. No `.env`, recovery key, `codex-home`, `auth.json` or token ciphertext was present in or copied to `./data`; a scan of `./data` for token patterns found none, and the new database holds only the `debates` and `events` tables.
- The source was opened only as a temp copy; its database files were fingerprinted before and after and did not change.

## Decisions not covered by the brief

1. **Clean history.** The first commit already excludes `deploy/` and two internal ops reviews (`STRUCTURAL-REVIEW.md`, `QUALITY-REWORK-PLAN.md`) that described the private server and its paths, so personal infrastructure never enters history. The originals still exist in the source copy. Code in the first commit still contains the Telegram/guest machinery that later commits remove.
2. **Seats the brief did not name.** `summon` (designing an expert mid-session) runs on the flagship tier as chair-level judgement; `repair` (copy-fitting a report that overflows the page) runs on the balanced tier. Position cards, the contrarian check and the adversary desk count as floor seats (flagship).
3. **No casting agent call.** Marcus used to spend a turn choosing models, and another before every motion. Both are gone; the casting sheet is built from the table at no cost and refreshed for debates resumed from before the change.
4. **No Claude per-token prices.** The CLI reports real cost per turn, so the table holds Claude display names and context only. I could not verify list prices offline (web search was not available, Sonnet 5.5's cost basis is "unknown", and the Opus 5.5 probes did not resolve to clean figures). The pre-debate estimate uses per-turn cost bands carried over from the old models by tier and labelled uncalibrated.
5. **OpenAI tools.** The API door already used the Responses API; I did not add hosted tools (web search) in this phase, so OpenAI and Codex debates still have no research desk or quant desk, as before. `reasoning.effort: none` is sent only to Luna.
6. **Local credentials.** OpenAI key from env, removed from `process.env` after reading. Codex: the user's own `~/.codex/auth.json` is read before each turn and, when a turn rotates the token, written back atomically (0600) unless the user's CLI has written a newer one. Without the write-back, single-use refresh tokens would sign the user's own Codex CLI out. A Claude `CLAUDE_CODE_OAUTH_TOKEN` in the environment is passed to the agent CLI for headless setups; nothing is stored.
7. **Access model details.** Sessions are in memory (a restart signs you out). The CSRF token is an HMAC of the session id, or of a per-process secret when there is no password, served by `GET /api/me`. A foreign Host gets 421. New knobs: `ALLOWED_HOSTS` (needed to open the app by a LAN name when `HOST=0.0.0.0`) and `FOUNDER_NAME` (replaces account display names). `HOST=localhost` counts as loopback.
8. **The python sandbox.** The hosted version kept the python quant desk safe by giving it only to the owner. In local mode everyone is the owner, so the shell of the python-bearing seats now runs in the Claude CLI's OS sandbox with no network and no unsandboxed fallback.
9. **Report served sandboxed** (`Content-Security-Policy: sandbox ...`), plus nosniff, frame-options and referrer-policy headers.
10. **Telegram notifications** (questions, report ready, PDFs) were removed with no replacement; the browser is the only surface.
11. **Old databases.** The legacy `accounts`, `auth_codes` and `grant_requests` tables and `debates.account_id` are left untouched in old files and never read; new databases do not create them. Old rows that stored a model id are read through `providerOfConfig()`.
12. **Imported mid-run debates** are not resumed automatically: `meeting` becomes `paused`; any other working phase becomes `error` with a note; agent session ids are cleared because those sessions lived on the old machine.
13. **Toolchain.** better-sqlite3 13 (v11 does not compile on Node 26; 13 needs Node 22+), TypeScript 7, Vite 8, zod 4, @fastify/static 10. `npm start` pointed at a file the build never produced; fixed. The server now also finds a `claude` on `PATH` (Homebrew cask, native installer), and only pins a node runtime for a JavaScript CLI.
14. **Removed** the one-off probe scripts that called live models or read personal temp paths (`sdk-probe`, `dossier-probe`, `extract-test`, `reducer-probe`).

## Self-review (gstack /review method)

Read every diff before each commit. Found and fixed:

- A splice artefact (`*//**`) that merged two doc comments in `runner.ts`.
- A resumed debate would have kept a casting card naming models that no longer run; the sheet now refreshes when the chair model differs.
- `npm start` ran `server/dist/index.js`; the build writes `index.cjs`.
- A false "no supported node" warning on native Claude CLI installs.
- An import orphaned by removing re-casting (`motionOf`).
- Two staged script deletions slipped into the prompt-fence commit; split back out before moving on.
- Selftests that read the per-debate Codex login after a turn (now deleted by design) were changed to assert on what the turn actually saw.

Not fixed, pre-existing: `tsc --noUnusedLocals` lists dead code in `runner.ts` and `motions.ts` that predates this phase (`marcusMove`, `pickWinner`, `sinceMarcus` and some unused prompt imports), and the web stylesheets still carry rules for the removed sign-in and session screens. Both are left for the Phase 2/3 rework, where those areas change anyway.

## Security pass (gstack /cso method)

Full write-up in `docs/SECURITY-AUDIT.md`. Fixed in this phase: unrestricted networked python on uploaded files (now OS-sandboxed, no network); forgeable upload fences; model-written HTML served on the app origin; a persisted copy of the Codex login in the data directory. Accepted and documented: research/architect web fetches could be steered by injected text (roadmap: fetch allowlist), per-address login throttling behind a proxy, `Secure` cookie only on direct HTTPS, existing `DATA_DIR` permissions not tightened, Google Fonts requests, a rare Codex write-back race.

## Unfinished or uncertain

- **No live model run in this phase** (by instruction). Not yet proven against real models: the OS sandbox around the python desk (it fails closed: if it does not work, the quant desk errors and the debate continues without measured numbers), the Codex door on the GPT-6 ids with the 0.164 SDK, the OpenAI door against the real API, and the Claude Agent SDK (0.1.77, unchanged) driving the installed CLI with the new model ids.
- **Cost estimates** are uncalibrated for the new models (bands carried over by tier).
- **Claude Agent SDK** is 0.1.77; 0.3.x exists. It is not flagged by `npm audit`, and upgrading without a live run would be untested, so it was left for Phase 5.
- **`motion/`** depends on Remotion, which is not MIT-licensed (free for individuals and small companies). It is a dev tool for rendering the waiting videos, not part of the app at runtime, and the README says so.
- **Sonnet 5.5** reported a 200K context window; seats that run on it (research, dossier) are well within that.

## Open questions

1. Should Telegram-style notifications come back in some local form (desktop notifications, email), or is the browser enough?
2. Should the OpenAI door get the Responses API's hosted web search so OpenAI debates can research, or stay text-only until the cross-provider phase?
3. Is the Remotion dependency in `motion/` acceptable for an MIT repository, or should the waiting videos be shipped as assets only and the project dropped?
4. Do you want the flagship tier for the referee long-term? It runs every round, so it is a large share of spend; the brief put it on Opus 5.5 and that is what ships.
