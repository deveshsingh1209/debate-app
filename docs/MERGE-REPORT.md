# Merge report: `integ`

Date: 2026-10-26. Branch `integ` (worktree `debate-wt-integ`), based on `main` at `0b420f3`.

Merged in this order, one `--no-ff` merge commit each: `wt/install`, `wt/logic`, `wt/notify`, `wt/baselines`, `wt/evalkit`, `wt/budget`, `wt/mockv2`, `wt/ui`, `wt/cso`. `npm run typecheck && npm run build` passed after every merge, and after the fixes that some merges needed. Nothing was pushed. No model calls, no outside services. Dependencies were installed with `npm ci --offline` from the local cache.

## Gate results (final tree)

| Gate | Result |
|---|---|
| `npm run typecheck` (server + web) | clean |
| `npm run build` (web + server bundle) | clean |
| `npm run qa` (server: 19 suites; web: design selftest) | all passed. Runner 102/0, research contract 81/0, realism logic all, notify 60/0, budget 69/0, eval golden, design 200/0, doctor and friendly ok |
| `npm run security-test` | 109 passed, 0 failed (parts A, B, C, D, E research, F Telegram) |
| `git grep fonts.googleapis` / `fonts.gstatic` / CDNs in code | none. The only hits are the design selftest's ban list and historical audit docs |
| Remotion | none in code, manifests or the lockfile |
| MOCK=1 demo on port 8831 | reached `complete` in about 18 s (`MOCK_SPEED=10`, interactive, the driver answered the clarify batch and the mid-debate question and approved each gate). Events included `quota` pause and resume, `research_done`, `decision`, `report_ready`. The report has no external font refs. The server was stopped and port 8831 is free. |

There is no Chrome on this machine, so PDF export was skipped (`NoChromeError`) in qa and in the demo; `CHROME_PATH=none` changed nothing. The HTML report paths ran.

## Conflicts and how they were resolved

### wt/install (OSS docs, README, CI, doctor, start, demo, Docker)
- **README.md**: kept main's wording on all three points. Haiku rewrites memo-like turns (the linter). Research runs on every provider, with Codex sources labelled "reported by the model". `BID_THINKING` is gone. Also fixed a "(Claude only)" research line that had merged in cleanly from the install side.
- **docs/ARCHITECTURE.md**: main's lint seat, research-on-every-door paragraph and stateless-expert "Agents" section, plus install's detailed meeting loop, Budget, Concurrency and floor-director sections. The bid sentences were dropped.
- **docs/CONTRACT.md**: main's "research on every provider", plus install's correct note that `floor_set` appears only in older debates. Neither engine emits it.
- **docs/ROADMAP.md**: main's partly-done fetch-allowlist line, plus install's three new items.
- **server/package.json `qa`**: union of both lists.

### wt/logic (realism pure modules)
- `qa`: added `src/realism/selftest.ts`. No other conflicts.

### wt/notify (attention states, Telegram)
- **server/src/db.ts**: combined the imports (research types and `attentionOf`).
- **server/scripts/security-test.mts**: both sides added a `partE`. Main's research desk stays as **E**, which runs in-process after the servers are killed. Telegram became **F**, which runs inside the server phase where `tgFake` is closed. Telegram uses ports 8894-8896, and nothing else in the suite clashes with them.
- **README** dev table: merged both, and the qa line now lists every suite. **ARCHITECTURE** diagram: lint, budget meter and notifier. **CONTRACT**: the trailer and research sections plus notifications.

### wt/baselines
No conflicts.

### wt/evalkit
- Root scripts: `eval` alongside `notify:*`. `qa` adds `eval.selftest`.
- **Drift fix:** the golden snapshot `scripts/fixtures/eval-golden.json` was regenerated with `--update-golden`. Only two things changed, both from other branches: realism index 30.4→39.3 and 79→86.4 (wt/baselines re-sourced the human bands, and its report states these exact numbers), and a new `lintRewriteRate: null` guard from main's metrics.

### wt/budget (caps removed, waste guards, quota pause, optional ceiling)
- **shared/budget.ts**: took wt/budget's cap-free `ProfileSpec`. Main's 2b-4 research desk reads `researchPerMotion`, which wt/budget's base did not have, so it is kept as a per-motion **runaway guard**. Values were raised in line with wt/budget's higher session caps: quick 3, standard 4, deep 6 (main had 1/2/4). Codex is still held to 1 per motion below deep (main's rule).
- **runner.ts research desk**: kept main's `requestResearch`/`researchLeft`. At the session cap it uses wt/budget's "treating that as a loop" wording, and at the per-motion allowance it uses main's wording. wt/budget's old "research offline on OpenAI" branch was dropped because main gave OpenAI research.
- **agents/sdk.ts**: wt/budget's limit latch and waste guard wrap dispatch. The JSON repair loop is bounded by `WASTE.jsonRepairs` and keeps main's `toolResults` and `costUsd` accumulation. The public `runJsonAgent` return type gained `toolResults?` and `costUsd?`, because `research/openai.ts` needs them.
- **db.ts meta**: union (main's stances and research fields, wt/budget's `profilePick` and `ceilingUsd`).
- **engine/motions.ts**: imports union. Main's `closeReason === 'budget'` check was dead, because wt/budget removed the budget close path, and TypeScript rejected it. The check was removed.
- **engine/mock.ts**: kept `fakeResearch` and dropped the unused `isProfile`.
- **runner.selftest.ts**: merged both fixture sets. Ana keeps main's tic and trailer turn (except in the repetition section). Bo and Cy get wt/budget's "fresh figure" suffix before their trailer, so the novelty guard sees new content. The limit-latch hook comes before the research stub. One section label was duplicated and was renumbered to `[9]`.
- **web Dock / debate-state.selftest**: ScopeCard gets the profile override and keeps `NotifyToggle`. Both reducer sections were kept (research is [4], the info-only meter is [5]).
- **README / ARCHITECTURE**: took wt/budget's no-cap text everywhere (the "Depth and cost" section, `BUDGET_CEILING_USD`, the trade-off row). Main's "Stateless experts" trade-off row was kept, and the "Hard caps per budget profile" row was removed. `BID_THINKING` stays out.
- **Breakage fixed after merging:**
  - `research/contract.selftest.ts` ran the same question on the same debate id more than twice, so wt/budget's waste guard correctly refused the third run. The test now calls `Waste.drop` before the abort/timeout/error scenarios.
  - `realism/stakes.selftest.ts` (wt/logic) read `BUDGET.*.turnCap`, which no longer exists. It now uses the literal 80/40 turn counts the clock was designed on. The `slotSecFor` doc says whoever wires it must choose the turn count.

### wt/mockv2
- `qa`: added `mock-v2.selftest`.
- **Breakage fixed:** mock v2 had been written against the capped budget. It used the old `budgetSnapshot` signature, printed a wind-down notice at 80%, put caps on the scope estimate and cast a `bid` seat. Ported it to the merged engine:
  - the meter is info only, with the estimate and the founder's ceiling
  - no wind-down message
  - the scope carries the profile and ceiling instead of caps
  - the casting sheet has `lint` instead of `bid`
  - the simulated limit pause now publishes `quota` events, so the WarRoom banner shows
- Changed one scripted chair line from "as far as the budget lets us go" to "the room has stopped finding new ground". `MOCKV2-REPORT.md` was updated to match.

### wt/ui (design system, self-hosted fonts, sound)
- Root `package.json`: install's `start`/`demo`/`doctor`, plus wt/ui's `qa` that runs the web suite too. wt/ui's `start: node server/dist/index.cjs` was dropped in favour of `scripts/start.mjs`.
- **main.tsx**: `MotionConfig` wraps the router, and the router holds `AttentionWatcher` and `App`.
- **NewDebate.tsx**: kept the notification imports. Dropped `Brackets`, which wt/ui no longer uses.
- **WarRoom.tsx**: kept both the quota banner and the `TableStrip`.
- **MotionHud.tsx (the "x/$12" meter)**: wt/ui's `BudgetBar` drew pressure against a cap with an 80% wind-down tick, and the header read `$x / $cap`. Per wt/budget it is now information only:
  - the bar shows spend against the typical estimate range, labelled "information only"
  - there is no tick
  - the header shows only the founder's own ceiling, never an old cap
  - Flagship-call and spoken-turn rows are plain counts
  - old capped snapshots still fold, with "(old cap)" in the Limit row and Dock's "No longer applied" note
  - CSS: the `wind_down`/`closing` styles were replaced by a `ceiling` style
  - the dev Rehearsal fixture is an info-only snapshot
- **Docs**: README FAQ, SECURITY.md, ROADMAP and a `report/render.ts` comment still said Google Fonts. wt/ui self-hosts the fonts, so these now say so.

### wt/cso
No conflicts (adds `docs/SECURITY-AUDIT-2.md`).

## Uncertain, for the owner

1. **`researchPerMotion` values (3/4/6).** I picked these values. Main had 1/2/4 under caps, and wt/budget had no per-motion field. If the per-motion allowance should go entirely under "quality over cost", remove it and keep only the session runaway guard.
2. **Repeated research and the waste guard.** In the runner selftest, Bo's trailer asks the same research question every turn. After two successes the waste guard refuses it, and the request is logged as failed. Each refusal still counts against `researchCount`. That is harmless, but a deduplicating check in `requestResearch` (before counting) would be cleaner.
3. **Two banned-phrase lists.** Main's `shared/lexicon.ts` drives the live linter. wt/logic's `realism/lint-rules.ts` `BANNED_PHRASES` is not wired in. `LOGIC-REPORT.md` says to keep one list. They need reconciling when 2e is wired.
4. **`SECURITY-AUDIT-2.md` (wt/cso)** was written before research-on-every-door and font self-hosting landed in this tree. Its CSP suggestion still allows the Google Fonts origins, and some of its findings may already be addressed. It needs a re-test pass against `integ`.
5. **Docs from before the merges** (`PHASE2-PLAN.md`, the phase reports, `UI-REPORT.md`) still describe caps, bids or the 80% line as history. They were left as they were. `docs/README.md` already flags the superseded cap sections.
6. **The meeting clock** (`realism/stakes.ts`) has no turn cap to derive from now. Whoever wires 2d must choose an expected-turns source, for example the scope estimate's `turns`.
