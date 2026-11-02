# Merge 2 report (`integ2`)

Branch `integ2`, from `main` at `b9dfe5d`. Merged in this order, one `--no-ff` merge commit each: `wt/calib` (1906ff8), `wt/start` (fe270cf), `wt/doors` (c070ba7), `wt/secfix` (190fe19), `wt/costfix` (96bef6c). The owner's three follow-ups are one commit after that (62e89b1), and this report is the last commit. `npm run typecheck && npm run build` passed after every merge. Nothing was pushed. There were no model calls and no outside services. Dependencies were installed with `npm ci --offline` from the local cache.

## Gate results (final tree)

| Gate | Result |
|---|---|
| `npm run typecheck` | pass (server and web) |
| `npm run build` | pass |
| `npm run qa` | pass, exit 0. Every suite reports 0 failed, including the new ones: doors 112, door-view, research cost, calibrate-human, start 3, design 205 |
| `npm run security-test` | **243 passed, 0 failed**. Every server runs on port 8841 |
| MOCK=1 demo on PORT 8851 | Started through the real launcher (`scripts/start.mjs --mock --no-open`), which printed "Open this link" on 8851. `GET /` returned 200 with no external font or CDN references. `/api/doors` listed the four doors by their setup names. A debate was created, a small driver played the founder through the API, and it reached `complete` with `/report` returning 200. The server was stopped afterwards and the port is free. |
| `git grep` for external fonts (googleapis, gstatic, typekit, bunny, rsms, `@import url(http…)`) | Clean in code. The only hits are historical docs: SECURITY-AUDIT-2's old CSP proposal and the earlier reports' gate tables. |
| `git grep -i remotion` | Clean in code, manifests and the lockfile. The only hits are PHASE1-REPORT, PHASE2-PLAN and MERGE-REPORT, all historical. |

## Conflicts and resolutions

### wt/calib
- **server/package.json `qa`**: calib branched before main's longer qa chain. I kept main's chain and added `calibrate-human.selftest.ts` at the end.

### wt/start
- Merged without conflicts. start's README already had the fourth AI row, **Claude API key**, and a link to `docs/CONNECT-YOUR-AI.md`. That file only arrived with wt/doors, so the link worked from the next merge on. start's `node scripts/start.selftest.mjs` was already in the root `qa`.

### wt/doors
- **server/package.json `qa`**: union. Added `doors.selftest.ts` and `door-view.selftest.ts`, and fixed doors' two missing spaces (`&&tsx`).
- **docs/README.md**: union of start's HOW-IT-WORKS/REFERENCE/DOCKER rows and doors' CONNECT-YOUR-AI row.
- **Mixed README claims, fixed:** start's README said "Restart the app after changing `.env`", but doors made keys re-read on **Re-check** with no restart. The README now points to the Connect screen and Re-check, and so does its "Not signed in" troubleshooting entry. The table rows now use the four setup names, and the non-coder tone is kept. HOW-IT-WORKS now uses the same names.

### wt/secfix
- **README.md**: start owns the README prose, so I kept start's version. secfix's three README facts went where they belong:
  - the `PUBLIC_URL` reverse-proxy note → `docs/REFERENCE.md` settings table
  - the security-test row (port 8841, `SECURITY_TEST_PORT`) → REFERENCE's command table
  - "no login in local mode; set `ACCESS_PASSWORD` on a shared computer" and "the AI that reads your files cannot browse" → the README's "Is it safe?" list, in plain words
- Also fixed REFERENCE's broken `CONTRIBUTING.md` and `docs/README.md` relative links (they came from start).
- **server/src/agents/sdk.ts**: both sides added an error class, so both are kept: doors' `redactClaudeSecrets`/`claudeCredentialRefusal` and secfix's `FetchBreachError`. Both no-retry rules are kept too (`CredentialError` and `FetchBreachError` both throw straight through).
- **Checked after the merge:** doors' `claudeChildEnv` (the API key goes only to that debate's Claude CLI child) and secfix's `credentialDenyRules` and sandbox now compose in one `runOnce`. `.env` is in the deny rules, so the new key file is covered. security-test merged without a conflict: doors' `/api/doors` attacks already used secfix's single `PORT`, both in default mode and in password mode.
- **docs/DOCKER.md and docker-compose.yml:** both listed only three providers. I added a "Claude: API key" row and passed `ANTHROPIC_API_KEY` through in compose; the image already installs the Claude Code CLI that this door runs on. I renamed the other rows to the setup names.

### wt/costfix
Nine conflicts. The real one was meaning, not text: **secfix guarded the research desk's WebFetch** with hooks (search-result-only, public-address checks before and after). **costfix took WebFetch away from the desk**: the desk now searches only, and the server's own guarded fetcher (`research/pages.ts`) reads the cited pages. secfix had also **split the architect** into a web scout and a tool-free designer, while costfix **metered the architect's web loop**.
- **sdk.ts**: union. The web branch now takes costfix's `webTools` option and runs both PreToolUse hooks: secfix's fetch rule (with `debateId`) and then costfix's `gateHook`. It keeps secfix's PostToolUse hooks (recording search results, the after-fetch breach check) and secfix's credential deny rules. Errors: `FetchBreachError` and `GatedLoopExhausted` are both kept and both never retried.
- **runner.ts, architect**: secfix's split is kept, so the designer that reads the dossier holds no tools. costfix's `searchGate`/`ResearchMeter` now sits on the **scout** (`scoutDomain`), the one architect seat that still has the web. Its write-up nudge reads "Write the landscape now from what you have." Imports are the union of both; on delete, both `SearchSeen.drop` and `forgetResearch` run.
- **prompts.ts**: I took costfix's `researchSystem` wording. secfix's line ("open a page … only pages a search returned") would have told the model to use a tool the desk no longer has. The scout prompt keeps secfix's wording, since the scout still fetches.
- **prompts.selftest.ts**: union of both sides' checks (the scout takes no dossier; the verify step's fences).
- **security-test.mts**: union (`web` flag, `HOSTILE_Q`, `researchWebTools`). I added one check: **the architect's web pass runs behind the same search gate.**
- **server/package.json**: added `research/cost.selftest.ts` to the union.
- **README.md**: kept start's README; costfix's qa wording went into REFERENCE's qa row.
- **SECURITY.md**: secfix's threat-model version, with costfix's facts folded in:
  - the research desk searches only; its page reader checks every redirect hop and the address the connection actually uses
  - the scout is the one seat with the CLI's WebFetch, under secfix's before and after checks
  - the DNS-rebinding known limit now applies to the scout only
  - the credentials line now covers the Claude API key door
- **ARCHITECTURE.md**: doors' door wording, costfix's metering paragraph (plus one line saying the scout is metered the same way), and secfix's Agents paragraph with costfix's "web search only; pages read by `research/pages.ts`".

## Owner follow-ups (62e89b1)

- **One set of provider names.** `PROVIDER_LABEL` in `shared/models.ts` is now the single source: **Claude: sign in**, **Claude: API key**, **ChatGPT: Codex sign-in**, **OpenAI: API key**. Everything reads from it:
  - the doors probe (`DOOR_TITLE`, now an alias), so the Connect cards and `npm run doctor` show the same names
  - New Debate's door buttons (the duplicate `name` field was removed)
  - the home screen's "No AI is connected yet" note and the provider chip on each past debate
  - the debate screen's provider chip
  
  Two user-facing Codex errors said "OpenAI API door" and "ChatGPT (Codex) login"; they now use the setup names.
- **Codex keychain fix in plain words.** `docs/CONNECT-YOUR-AI.md` now explains it as "Codex saved your sign-in in your computer's password store, where the app cannot see it". It gives one copy-paste command each for Mac/Linux and Windows PowerShell, which adds the setting and runs `codex login`, then says to press Re-check. The Connect card's fix text says the same, more briefly.
- **Research-question hostnames** (`server/src/research/gate.ts`). A bare host of 3+ labels now passes when it reads as an ordinary public site: a public top-level name, at most 5 labels, short word-like labels (`docs.python.org`, `data.gov.uk`, `ec.europa.eu`, `developer.mozilla.org`). These are still refused:
  - IPv4 and IPv6 literals (new: these used to pass the gate entirely)
  - private or reserved names (`.local`, `.lan`, `.internal`, `.home.arpa`, `.corp`, `.example`, `.invalid`, `.test`, `localhost`, …)
  - data-shaped subdomains (three or more digits in a row, or alternating letters and digits like `m41f`, `q2x9`)
  
  Versions (`3.12.1`), times (`10:30:00`), `std::vector` and abbreviations (`U.S.A.`) are not mistaken for addresses. `scrubForWeb` follows the same rule. There are 18 new security-test checks, and the original refusal list still passes.

## Uncertainties

1. **The looser hostname rule lets a few word-like characters through in a subdomain** (for example `margin.acme.com`). I accepted this because, after costfix, the research desk only searches: naming a host in a question contacts nobody, and pages are opened only if a search returned them. If the owner wants the old strictness for the scout, the gate is one function (`publicHost`).
2. **On the Codex door the scout's search gate is not enforced.** It is a Claude CLI hook; Codex ignores `toolGate`. That matches costfix's own scope (gating is "on the Claude door"), but the scout on Codex is unmetered.
3. **Hooks were only tested offline.** The PreToolUse/PostToolUse hooks (secfix's fetch rule, costfix's gate) are checked in-process with fakes; there were no live CLI runs (no model calls allowed). The two hooks were never run against a real CLI in the same turn.
4. **Docker:** `ANTHROPIC_API_KEY` in compose and the new DOCKER.md row were not built or run.
5. **The launchers** (`Start on Mac.command` and the others) were not double-clicked. That was already noted in START-REPORT, and the same sandbox limit applied here.
6. **UI:** the name changes were checked by typecheck, build, the mock and the API. I did not look at them in a browser, so long names like "ChatGPT: Codex sign-in" might wrap on New Debate's four-button row at narrow widths.
7. **The README screenshots** are older than the Connect screen, and their caption already says so.
