# Progress report

Living status of the Debate App. Updated after every work session. Newest entry first in the log at the bottom.

**Last updated:** 2026-11-01 (P1-P4 merged)
**Main branch:** `176842c` (local only, nothing pushed)
**Overall status:** NOT production-ready. Works end to end on Claude sign-in; quality, cost and install proof still open.

## Status board

| Area | Status | Evidence | Next step |
|---|---|---|---|
| Core engine (live floor, ledger, stakes, report) | Working | Real run d_R8dL2LGj completed: 142 messages, report + transcript (2026-10-28) | Fix evidence honesty and session length (P1, P2) |
| Evidence honesty | **Proven live** | Re-scoring the 2026-10-28 run: 17 `[observed]` claims before, 0 after (13 persona, 4 assumed) | P5 |
| Session length on Quick | **Proven live: 53 messages, $6.10 (was 142, $21.13)** | Live bakery run 2026-11-01 | Calibrate Standard and Deep |
| Research cost | **Proven live: $0.99 for 6 calls, envelope fix confirmed, no empty calls** | One trimmed search per call, token envelope, reuse; simulator (calibrated within 10% on the real run) says about $0.12 per call vs $1.44 | P5 |
| Pause / resume | Fixed offline | Pause never closes or advances a motion; 196 checks pause at 14 phases and resume to the same outcome | P5 |
| Claude sign-in door | Working (live) | Isolated login verified; full real debate ran | Keep a smoke check |
| Claude API key / Codex / OpenAI doors | Built, offline-tested only | 115 door checks pass; no live run | P6 (needs keys or Codex quota) |
| Browser UI | Working (mock) | 31/31 Playwright tests on the merged branch | Re-check after live run |
| Security | Passing | 253/253 security tests, secret scan clean | Re-run after each change |
| Install (Mac) | Working | Launchers + demo pass `--check` | P7 clean-machine test |
| Install (Windows / Linux) | Unproven | Never run on a real machine | P7 |
| Release / GitHub | Not started | Checklist exists; repo name not chosen | P8 |

## Plan (priority order)

- **P1 Evidence honesty.** Expert personas must never present invented personal experience as observed fact. Persona anecdotes become `[persona experience]`, `[observed]` is reserved for founder-supplied facts and cited research, and the report and numbers audit downgrade anything unsourced. Acceptance: re-score the 2026-10-28 transcript with the new rules; zero persona anecdotes graded as observed.
- **P2 Sensible length per profile.** Quick, Standard and Deep get real round and message budgets that the director respects, and the referee closes motions when the crux is settled. Acceptance: offline replay shows Quick at about 40-60 messages total; Deep still allowed to run long.
- **P3 Research cost.** Keep research on the user's chosen setup (owner rule). Cap searches per call, trim fetched pages before the model sees them, reuse the architect's scout results instead of searching again, and log tokens per call. Acceptance: offline budget test plus one live research call under a stated cost.
- **P4 Pause/resume correctness.** Pausing never closes a motion; resume returns to the exact step (including the adversary round). Acceptance: a regression test that pauses at each phase and resumes.
- **P5 One real Quick debate to prove P1-P4.** Owner approval needed; report cost, length and evidence grading against the 2026-10-28 baseline.
- **P6 Live proof of the other three AI setups** (Codex sign-in is available on this Mac; the two API-key setups need keys).
- **P7 Install proof** on a clean Mac, Windows and Linux machine from the release zip.
- **P8 Publish** as a labelled beta: repo name, single fresh commit, CODEOWNERS, links, CI green.

## Baseline from the real run (2026-10-28, Claude sign-in, Quick)

| Metric | Value |
|---|---|
| Messages | 142 (132 on motion 1) |
| Model calls | 207 |
| Usage (list-price equivalent, Max plan) | $21.13 |
| Research + architect scout | ~$10.10 |
| Wall time | ~39 minutes of meeting |
| Report | Produced (PDF 1.0 MB, 15 sections) |
| Problems | invented "observed" anecdotes; Quick too long; pause closed a motion; motion 2 cut short |

## Log

### 2026-11-01 (live proof run, all fixes)
- Live Quick debate on the bakery-Sundays question (same as the 2026-10-28 baseline), Claude sign-in, build `d1e0338` with P1-P4 and P3b.
- Result: 53 messages (baseline 142), 2 rounds, 21 minutes, 105 model calls, $6.10 list-price equivalent (baseline $21.13). Report + transcript delivered.
- P2 length: PROVEN live. 53 messages is inside the 40-60 target.
- P3/P3b research: PROVEN live. 6 research calls, $0.99 total; search calls $0.20-0.22 each; one reused an earlier answer; 0 "Research incomplete"; session baselines 730-1,840 tokens (the ~46k connector block is gone).
- P1 evidence: WORKING live. 10 [observed] claims, all cited research ids; 4 persona stories graded [persona]; the regrader downgraded one unsourced "observed" claim to "assumed" live.
- P4 pause/resume: not exercised in this run (no pause); proven offline only.
- Cost split: report writer $1.41, research $0.99, chair $0.77, three experts $0.43-0.61 each.

### 2026-11-01 (research envelope)
- P3b fixed on wt/envelope, merged. Root cause: the user's claude.ai connectors (Gmail, Drive, ...) and user-scope MCP servers were loading into some agent sessions, adding a ~46,000-token block of tool definitions (37 of 385 sessions in that live run). Agents now run with no MCP servers and claude.ai connectors disabled (also a privacy improvement).
- The research envelope now counts only what research adds over each session's calibrated first request; a first search is never stopped; a stopped call returns "Research incomplete" instead of an empty answer; the write step's input is capped; a double-counting bug in the token meter is fixed.
- Restated research cost per call: about $0.12-0.24 without the connector block (the expected case now), $0.17-0.34 with it.
- Verified by the maintainer: typecheck, build, QA, doctor self-test, security 254/0, browser 31/31.
- Next: one live Quick debate on the bakery-Sundays question (2026-10-28 baseline: 142 messages, $21.13) to test P2 length and P3b live.

### 2026-11-01 (live run)
- Live debate on a real startup's 2027 strategy (Claude sign-in, Quick) on a build with P1 + P3 but without P2/P4. Completed: 307 messages, 18 rounds, 82 minutes, 391 model calls, $27.90 list-price equivalent. Report + transcript delivered.
- P3 research cost: CONFIRMED in a live run. Research cost $0.82 for 10 calls, against $8.73 in the 2026-10-28 run.
- NEW BUG (P3b): the search step's first request already carries about 49,000 tokens, above the envelope's 30,000 trigger, so the envelope stopped 4 research calls before they searched (0 searches, no answer); 2 other calls still exceeded the 80,000-token budget (121k, 217k).
- P1 evidence honesty: WORKING in a live run. 17 [observed] claims, all traceable to cited research or the founder's brief; 40 persona stories graded [persona]; the report has the "Panel Anecdotes, Not Evidence" section.
- Length: 307 messages is the old engine without P2; P2 still needs its own live test.
- Biggest cost now: the chair (Marcus) at $8.30 over 49 calls, then the report writer at $3.45.

### 2026-11-01
- Wrote this progress report and the plan P1-P8.
- P1 evidence honesty, P3 research cost, and P2+P4 session length and pause/resume built by three parallel offline agents (wt/evidence, wt/cost, wt/flow from `d38cf0b`).
- the maintainer verified each branch: typecheck, build, QA, security, and the full browser suite. Two agents exited before finishing; the maintainer completed their browser runs and reports and committed their work.
- Found and fixed: a stale browser test that failed on any non-default port, and a doctor self-test broken since `de0fcc2` (not part of `npm run qa`).
- Merged all three into `176842c`. The merge exposed one real bug: the split report step lost the `nameOf` helper the evidence code used, which would have crashed every report. Fixed. Merged branch: typecheck, build, QA pass; security 253/0; browser 31/31.
- Status: P1-P4 DONE offline. P5 (live proof) in progress: a live Quick debate on a real startup's 2027 strategy was started on a build with P1 and P3 but WITHOUT P2/P4 (started before they finished), so its length is not a test of P2.

### 2026-10-28
- Real end-to-end debate on Claude sign-in completed (report + transcript delivered). Found P1-P4.
- Fixed: readiness check now uses the same isolated Claude settings as the agents (`de0fcc2`).
- Fixed: Claude Code error results are no longer treated as successful answers; expired OAuth recognised as a sign-in problem.
- Added: double-click "Try Demo" launchers; launcher no longer reuses a demo server for a real session (`adbe517`).
- Changed: cost estimates labelled uncalibrated in README, reference docs and the app.
- Fixed: repeated deadline in the dissent section of the PDF; chart value labels no longer overflow.

### 2026-10-27
- Browser test suite (31 tests, accessibility checks) merged (`922a46a`).
- Live floor director, ledger, stakes and release prep merged (`ed888c6`).
