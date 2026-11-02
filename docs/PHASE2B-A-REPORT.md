# Phase 2b-A report: groundwork, event contract, budget

**Date:** 2026-10-26
**Brief:** implement plan steps 2b-0, 2b-1 and 2b-2 from `docs/PHASE2-PLAN.md` section 7, with no model quota.
**Result:** all three steps done and committed. Every gate was green after each step. No live model call was made, no debate was run against a real model, nothing left this machine, and nothing was pushed (there is no remote).

The run was interrupted once (the machine lost its connection during 2b-2). 2b-0 and 2b-1 were already committed. On resume, the uncommitted 2b-2 work was inspected in the working tree and finished in place; nothing was lost or redone.

## Commits

| Step | Commit | What |
|---|---|---|
| 2b-0 | `d45fea4` | Remotion project and rendered clips removed; the CSS scanner is the only waiting animation |
| 2b-0 | `2f29062` | Dead bidding loop removed; founder answers written to `transcript.md`; metrics self-test in `qa` |
| 2b-1 | `2085810` | Realism event contract; SSE hub and web state hold one partial per message |
| 2b-1 | `110abae` | FloorDirector, the `wireAgents` seam and offline real-engine test, mock overlap scene, realism index and guards |
| 2b-2 | `aa3bbf6` | Budget profiles, hard caps, meter, research slots in the semaphore |
| 2b-2 | `cc7d506` | Profile picker, caps on the estimate, budget meter in the war room |
| | (this commit) | This report |

## Method

Before each step I stated the approach to myself against the plan's section 7 text and acceptance list. After each step I reviewed the diff the way gstack `/review` does. The Skill tool returned an error for `review` (as it did in Phase 2a), so I followed `~/.claude/skills/gstack/review/checklist.md` by hand: pass 1 (data safety, races, LLM trust boundary, enum completeness, gate integrity), pass 2 (completeness, stale comments, docs), then fix-first. Steps of that skill that contact outside services were skipped.

Gates run after every step: `npm run typecheck`, `npm run build`, `npm run qa`, `npm run security-test`, plus a `MOCK=1` debate driven to `complete` through the real HTTP API and SSE by a local driver (`.scratch/e2e.mjs`, not committed), and a check that the 8 imported debates still list and open (on a copy of `./data`, with the agent CLI pointed at `/usr/bin/false` so an accidental spawn could not reach a model).

## 2b-0. Groundwork

**Done**
- `motion/` (the Remotion project), `web/public/motion/*.webm`, the `<video>` in `Cinematic.tsx`, its CSS override, the README line and the `.gitignore` entry are gone. The waiting bay shows the existing CSS scanner at its original size. The local render output in `motion/out` (gitignored, never committed) was moved to `.scratch/motion-out-backup` rather than deleted.
- Dead bidding path removed: `marcusMove`, `bidRound`, `pickWinner`, `lastBids`, `sinceMarcus`, and the helpers only they used (`markMarcusSeen`, `leastRecentSpeaker`, `bidSystem`, `bidPrompt`, `marcusTurnPrompt`), plus imports orphaned by them. Kept on purpose: the `bid` seat (until 2b-3), the `Bid` type and the `bids` event (imported debates carry it, and the web still renders it).
- `transcript.md` now carries what the founder said: mid-meeting answers (`**Dana (founder):** ...`), the chair's question before it, and autonomous assumptions. Clarify answers are given before the file exists, so they go into its header from the event log (latest answer wins, matching amend). The mock writes the same lines. The metrics script parses the new lines.
- `npm run metrics` already existed; its `--self-test` is now part of `npm run qa`.

**Acceptance**
- `git grep -i remotion` matches only `docs/PHASE1-REPORT.md` and `docs/PHASE2-PLAN.md`.
- Mock run: `complete`; `transcript.md` contains the mid-meeting founder answer, both clarify answers and the chair's question.
- Imported debates: 8 listed and opened (507, 85, 266, 11, 10, 637, 373, 11 events), both stored reports served, no agent turn started.
- Gates: typecheck pass, build pass, qa pass (report renderer clean, prompt fences 10/10, OpenAI 54/54, Codex 120/120, metrics self-test all pass), security-test 78/0.

## 2b-1. Event contract, real-engine seam, director skeleton

**Done**
- `shared/realism.ts` (turn shapes, cut-off, overlap, lint and claim records, `Dossier`, `Belief`, `Concession`, `Stakes`, `FloorState`, `PendingTurn`, `BudgetSnapshot`) and `shared/research.ts` (`Citation`, `Finding`, `ResearchResult`), re-exported from `types.ts`.
- `message` gains optional `shape`, `to`, `cutOff`, `overlap`, `lint`, `claims` and kind `reaction`; `text` is documented as spoken words only. New events `aside`, `pause`, `floor`, `belief`, `concession`, `budget`; `research_done.result?`; a `budget` live frame.
- SSE hub: one partial per message id, all replayed in start order on subscribe; finalizing one message no longer deletes another speaker's partial (in the old code any message, for example a research brief, wiped the streaming speaker's buffer). Partials are cleared when the debate reaches reporting/complete/error/cancelled, so an orphaned partial cannot replay forever.
- Web: the pure reducer moved to `web/src/lib/debate-state.ts` (no React, no network, so it is testable); `streaming` became `streams[]`; explicit handling of `reaction`, `aside`, `pause`, `concession`, `floor`, `belief`, `budget`; minimal rendering: an em-rule and "cut off by X" on a cut turn, an "over X" tag on an overlap, a whisper line for an aside, a pause line, a concession chip. `CONTRACT.md` describes the additions.
- `formatEvents` renders `...month— [cut off by BO CHEN]` and `BO CHEN (role) (over ANA RUIZ): ...`, and never renders an aside. The transcript PDF shows the same tags.
- `wireAgents({ run, runJson })` in `sdk.ts`: every provider's turn goes to scripted replies, billed through the real ledger. `CHROME_PATH=none` turns PDF export and print QA off.
- `server/src/engine/runner.selftest.ts`: drives a real `DebateRun` from intake to complete against a throwaway `DATA_DIR`.
- `server/src/engine/director.ts`: pure, seeded FloorDirector (owed answers, duels with a cap, heat gain and decay, interruption decision with the founder never cut, never before sentence one, cap per motion and minimum gap, cut placed mid-sentence on a word boundary, floor fight, chair triggers). Not wired into the engine (2b-7).
- Mock: a set piece cut off mid-sentence by a cut-in spoken over its last words, with the cut point chosen by the real director from a scripted reaction; both turns stream at once for three seconds; then a pause and the speaker resuming; plus an aside and a caused concession.
- Metrics script: reactions count as expert turns, cut-offs count as interruptions, overlap is measured, asides never count. New 0-100 realism index with per-metric parts (`REALISM_TARGETS`), decision-quality guards from the event log (mean top rung, fresh arguments per checkpoint, defeaters landed, dissents, rulings above `assumed`; unsupported figures is `null` until the 2b-3 claims record exists) and `guardFalls()` for the "no guard falls more than 10%" rule. Two hand-written synthetic fixtures in `scripts/fixtures/` (fictional bakery topic, no private data).

**Acceptance and test output**
- Director unit tests: 36 passed (owed answers win, presses bring the chair, duel cap, live duel continues, no back-to-back speaker, founder never picked or interrupted, never before sentence one, cold listener does not cut in, cap and gap hold, heat decay and cap, same seed gives the same room, shapes and word budgets).
- Engine integration test: drives today's engine to `complete` through the fake seam; statuses in order; every expected event type emitted; six floor turns and three closings; ruling recorded; report written; spend reached the ledger; founder answer and chair question in `transcript.md`; an aside published mid-motion reaches none of the prompts built after it (system or suffix, for any seat) nor `transcript.md` nor `buildRoomBlocks`; an old record formats byte-for-byte as before; the hub replays two overlapping partials and keeps one when the other finalizes. 35 passed at 2b-1, 47 after 2b-2 added its section.
- Reducer test: 17 passed (old debate folds as before, two overlapping streams, a refresh mid-overlap rebuilds both, finalizing one leaves the other, late delta ignored, orphan cleared when the room stops, the new events, unknown future event ignored).
- Mock over real HTTP/SSE: two turns streamed at once; a refresh in that window (re-read the snapshot, stream from its last seq) replayed both partials; the cut message was persisted with only the spoken words (`text.length === cutOff.atChar`); the cut-in was persisted as an overlap on it.
- Old debates: all 8 folded through the new reducer with every message in the feed and no stray streams; their formatted records contain no cut-off or overlap markers.
- Realism index: imported corpus pooled **35.5** (per debate 29.1, 29.1, 32.5, 43.2, 55.7); synthetic baseline-like fixture 30.4, target-like 79.0.

## 2b-2. Budget profiles, meter, hard caps

> **Superseded (Oct 2026).** The caps and the 80% / 100% behaviour below were removed on the owner's "quality over cost" decision; see [BUDGET-REPORT.md](BUDGET-REPORT.md).

**Done**
- `DebateConfig.profile` (`quick | standard | deep`). The API defaults new debates to `standard`; rows without a profile run exactly as before (no caps, today's thinking budgets, three adversaries).
- **One config file**, `shared/budget.ts`, holds every budget number: per profile the expert and motion maximums, turn cap, flagship-call cap, call cap, output-token cap, dollar cap and target per door (Claude $6/$12/$45, OpenAI $9/$16/$60), research cap, adversary seats (0/1/3), thinking per seat, interruption cap and asides; the 80% and 100% thresholds; the reserve; and the per-model cost bands the estimate is priced from (moved out of `scope.ts`). Standard is $10.50 target, $12 cap, per the owner decision.
- Scope sizing inside the envelope: the intake's depth read sizes the session and the profile caps it (the rationale says so when it does). `projectTurns` rewritten for the round engine: it now counts position cards, the consensus check, interjections, adversary seats, the adversary round and re-ruling, the report's adversaries and revision, and holds spoken turns to the turn cap. The estimate carries the caps and never shows a figure above the dollar cap.
- Per-profile thinking: referee 8K/16K/32K (still on the flagship), floor 6K/8K/12K, reply 1K/2K/2K, steer, heavy.
- The meter, `server/src/budget.ts`: a pure function of the ledger, against each cap minus a reserve for closings, the open ruling, the report and its adversaries. Flagship calls are counted at the one dispatch point in `sdk.ts` every provider passes through. A `budget` live frame after every call; a persisted `budget` event at each transition and once per motion.
- 80%: the room is told; the motion rules at the end of the current round; the adversary round is skipped; optional motions (those the chair added mid-session, or any marked `optional`) are dropped. 100%: the round stops after its first speaker, the motion is ruled, and the session goes to closing statements and the report, which run on the reserve. State only moves forward.
- Research cap per profile.
- Semaphore: `MAX_AGENTS` default 4; one slot the critical path never takes; research held to two slots; a freed slot goes to the first waiter that can run.
- UI: a Budget switch on the setup screen, the caps on the chair's sizing card, and spend/cap, projected spend, flagship calls and spoken turns in the war-room meter. README and `.env.example` updated.

**Quota guard: not built.** `@anthropic-ai/claude-agent-sdk` 0.1.77 has no message type carrying subscription-window usage (its only rate-limit surface is the `rate_limit` assistant error code), and the bundled CLI contains no rate-limit event. Per the plan, the meter shows spend only and the profile caps are the guard; `BudgetSnapshot.quota` is defined and left unset. The existing limit-park-and-resume logic is unchanged.

**Acceptance and test output**
- `budget.selftest.ts`: 28 passed (reserve arithmetic, pressure against cap minus reserve, binding cap, projection, Codex has no dollar cap, OpenAI's own cap, ok → wind_down → closing on a fake ledger with a line at each, threshold exactly at 80%, monotonic state, sizing capped by quick and deep, unprofiled sizing unchanged, estimate carries and respects caps, turn cap holds, quick has no adversaries, semaphore reservation behaviour).
- Engine test, new section: a quick-profile session with expensive fake calls reaches `complete`; the meter crossed into closing; the room was told at 80% and 100%; budget checkpoints persisted; the open motion was still ruled after one round; no red-team call; three closings; report written; the referee's thinking was 8K on quick and 32K on the unprofiled debate; the unprofiled debate was never metered.
- Mock: created on the default standard profile; the scope event carries the caps ($12); live budget frames streamed; a budget checkpoint persisted.
- Final gate run: typecheck pass; build pass; qa all pass (renderer clean, prompts 10/10, OpenAI 54/54, Codex 120/120, director 36/36, budget 28/28, engine 47/47, reducer 17/17, metrics self-test all pass); security-test 78/0; mock debate `complete` (64 events); 8 imported debates list and open, no agent turn.

## Deviations from the plan, and why

1. **Budget numbers moved into one file** (`shared/budget.ts`), including the cost bands that used to be in `scope.ts`. The owner asked for one-line changes; the plan had said "in one place (`scope.ts`)". `scope.ts` keeps the arithmetic only.
2. **"Optional" motions** are defined as motions the chair added mid-session, plus any item with the new `AgendaItem.optional` flag. The planner does not mark motions optional today, so without this the 80% rule would have nothing to skip.
3. **100% stops after the first speaker of a round, then rules.** The plan says the session goes to closings and the report. A motion already under way is still ruled (one flagship call, covered by the reserve), because an unruled motion would leave a hole in the report.
4. **Profile adversary seats apply to the report attack too** (quick: no report adversary). The plan's table lists one setting for the desk; applying it to both is what keeps quick inside $6.
5. **2b-1 mock goes beyond overlap**: it also shows a pause, an aside and a concession so all the new minimal rendering can be looked at. Asides are deep-only in the real engine (2b-7).
6. **The aside/no-leak test runs through the real engine** (every prompt built after an aside is published is checked), in addition to the plan's `buildRoomBlocks` check.
7. **Web reducer split into its own module** so it could be tested without a browser; `stream.ts` re-exports it, so no import elsewhere changed.

## Unfinished or uncertain

- **No browser was opened.** The war-room rendering (cut-off rule, overlap tag, whisper, pause line, concession chip, budget meter, profile switch) is typechecked, built and exercised through the reducer and the HTTP/SSE driver, but nobody has looked at it. Headless Chrome was avoided because the app's pages request Google Fonts, which would be outside traffic. The three-way switch reuses the two-way switch's CSS with an inline width; it may need a visual tweak.
- **Pre-existing:** `npm run qa`'s report-renderer check launches the local Chrome on HTML that links Google Fonts, so `qa` may make font requests. That was true before this phase and the brief requires running `qa`; the new engine test sets `CHROME_PATH=none` and opens no browser.
- **Estimates are still uncalibrated.** For a standard session the rewritten `projectTurns` gives roughly 60 agent turns at the motion's target round count, well under the plan's ~155-call standard figure, because the round engine's target rounds are low and real motions run past target until the referee closes them. The caps, not the estimate, bound the spend. R1 calibrates both.
- **Flagship counting is approximate on the Claude JSON path**: each repair retry is a real call and is counted; OpenAI and Codex count their internal retries once.
- **The research reservation applies to the Claude CLI semaphore only.** OpenAI and Codex keep their own limiters (Codex is serialised per credential anyway).
- **A wind-down crossed during setup or position cards** takes effect at the first motion, which then gets one round before it is ruled.
- **Prompt and UI copy still mention bidding** (`marcusSystem`'s mode note; the engine-mode blurbs on the setup screen; "floor bids on Haiku" in the door descriptions; the casting label). These are prompt de-seeding and seat changes scheduled for 2b-3; changing them in 2b-0 would have changed model behaviour, which the step said not to do.
- The local e2e driver and the old-debate reducer check live in `.scratch/` (gitignored) and are not part of `qa`; the engine test, director, budget, reducer and metrics tests are.

## Open questions for the owner

1. **Deep's dollar cap** is $45 on Claude, which the plan says can use most of a 5-hour window. Keep it, or lower it?
2. **Quick has no adversary desk** at all, report included. The report adversary once caught a real shipped error. Give quick one report seat (about $0.15)?
3. **100% behaviour**: rule the open motion (current), or stop without ruling it and say so in the report?
4. **Optional motions**: should the planner be told to mark motions optional at drafting, so the 80% rule skips the right ones?
5. Still open from the plan: whether the standard estimate (about $10.50, cap $12) is acceptable as "not eating a 5-hour window", whether Codex research with model-reported sources counts as parity, and whether a less balanced room (Gini 0.25-0.45) is wanted.
6. Approval for **REAL R1** once 2b-3 lands (Claude door, quick profile, about $4-5).
