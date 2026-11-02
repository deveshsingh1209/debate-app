# Engine report: plan steps 2b-5, 2b-6 and 2b-7

**Date:** 2026-10-27
**Branch / worktree:** `wt/engine` in `debate-wt-engine`, from `main` at `58aebba`.
**Brief:** wire the realism modules (dossiers and the diversity check, the belief ledger, stakes, the lint rules) into the real engine; add the report sections and apply the calibrated realism bands; replace the round-robin with the live floor director.
**Result:** done, one commit per step, gates green after each. No live model call, no real debate, no quota used. Every server ran on port 8861 and was stopped afterwards. Nothing was pushed.

## Commits

| Commit | Step |
|---|---|
| `e898c9d` | 2b-5: dossiers with the diversity check, stakes, the belief ledger and the realism lint rules, wired into the engine |
| `453f1e6` | 2b-6: report sections (stakes, how minds changed, the dissent record); the calibrated realism index |
| `348fa64` | 2b-7: the live floor director replaces the round-robin; `MOCK=1` runs the real engine with scripted models |
| (this commit) | Docs (ARCHITECTURE, CONTRACT, HOW-IT-WORKS, REFERENCE, ROADMAP, README) and this report |

## Gates (final tree)

| Gate | Result |
|---|---|
| `npm run typecheck` | pass (server and web) |
| `npm run build` | pass |
| `npm run qa` | pass, exit 0. New or grown suites: `floor.selftest` 25, `minds.selftest` 17, `mock-live.selftest` 24 (both scenarios through the real engine), the engine test 157 (was 102), prompts 108 (was 99), reducer 25 (was 23), metrics self-test (size-aware bands, discourse openers, broad concessions), print QA with a new `with-realism` hostile fixture |
| `npm run security-test` | **243 passed, 0 failed**, every server on 8861 (`SECURITY_TEST_PORT=8861`, through a small local wrapper) |
| `MOCK=1` debate | The built server on 8861 with `MOCK=1`, a driver playing the founder through the HTTP API: `complete`, report served (200). Live path: 36 expert turns, 12 reactions, a cut-off with its cut-in spoken over it, 3 overlaps, 3 pauses, research landing in the room, 2 concessions (one caused by a citation, one unexplained and raised to the chair). Server stopped, port free. |

One run of the security test showed 50 failures: my own mock server was still holding 8861, so the test's servers could not bind and its requests reached mine. With the port freed it passed 243/0. Recorded so nobody chases it.

## 2b-5: wiring the realism modules

The 25 integration steps in `docs/LOGIC-REPORT.md`, and what happened to each:

| # | Step | Status |
|---|---|---|
| 1 | Prompt de-seeding selftest on `BANNED_PHRASES` | Already done in 2b-3 against `PROMPT_BANNED`; every new builder (persona, relationships, stances, reaction, chair line) is covered |
| 2 | Lint each turn with the realism rules | Done: the engine linter now also applies `BANNED_PHRASES`, word-bounded `neverSay`, per-motion tic budgets, the fuller template and meta-speech (`engine/lint.ts`) |
| 3 | Never lint the founder, research, desk or rulings | Kept |
| 4 | Metrics keep their own lexicons | Kept; a metrics-only broad concession list was added (2b-6) |
| 5 | Persona call on the balanced `persona` seat, `goalLean` | Done; `goalLean` added to `Dossier`; a malformed draft is asked for once more with its errors |
| 6 | Relationships pass | Done, public parts only, unknown ids dropped |
| 7 | Diversity check, one regeneration with hints, proceed and log | Done; a panel that still fails goes ahead **flagged at panel approval** (`panel.diversity`, shown in the reveal) |
| 8 | Public reputation in the cached roster | Done (`buildRoomBlocks` `reputations`) |
| 9 | Voice card in the speaker's suffix | Done, with relationships and (2b-7) whispers to that speaker |
| 10 | `neverSay` from the dossier | Done |
| 11 | Director temperament and natural length from the dossier | Done (2b-7) |
| 12 | Stakes at intake | Done, with a change: see deviation 1 |
| 13 | STAKES block in the cached constants | Done |
| 14 | Reality-check seat | Done: one architect retry with the hint; the rule line is in `architectSystem` |
| 15 | Rulings: owner, cost of being wrong, dissent tripwires | Done; incomplete dissents are kept and marked, not re-asked (deviation 3) |
| 16 | Report minority and stakes sections | Done (2b-6) |
| 17 | Meeting clock | Done (2b-7), with a change: deviation 5 |
| 18 | Ledger state in `meta.ledger` | Done, created after the position cards |
| 19 | Starting stances by a clerk call | Done (`clerk:stances`, fast tier); a failure leaves the first trailers to set them |
| 20 | Each turn through `reduceLedger`, concessions published, latest per `messageId` in the web | Done |
| 21 | Evidence fed in on research and computations | Done (citation ids, desk task ids) |
| 22 | Referee checkpoint: flags, attribution | Done: unexplained moves are listed in the referee prompt; `move_causes` resolves them. The stated-vs-revealed audit is not wired (open question 6) |
| 23 | Chair triggers | Done: in the check-in (2b-5) and as chair lines on the floor (2b-7), each raised once |
| 24 | Report "how minds changed" | Done (2b-6) |
| 25 | Mock shows caused and unexplained concessions | Done in the live mock (2b-7) |

## 2b-6: report sections and the calibrated index

**Report.** `ReportData` gains three optional, server-written fields: `stakes` (each line marked assumed when the founder did not state it), `minority` (every dissent with its tripwire and cost of ignoring, or marked incomplete; it replaces the writer's own dissent list when present) and `mindChanges` (per motion, from the ledger: who moved, what moved them, what it cost, who held firm, the caused share). The renderer adds "What Was at Stake" and "How Minds Changed" and prints tripwires in the dissents. The writer is handed the same three sections as material. Sources were already server-written (2b-4). Old reports have none of these fields and render as before.

### Band decisions

Rules from the brief: prefer the human-corpus numbers (AMI/ICSI, `docs/calibration-proposed-bands.json`) for rhythm metrics; keep the plan's targets only where documented; panel-size-dependent Gini and A-B-A; real talking-over 3-20; a broader concession list at lower weight; discourse-marker openers are not repeats. "Baselines" below is the literature band from `docs/HUMAN-BASELINES.md` (the `wt/baselines` targets that were live before this step).

| Metric | Baselines (was live) | Corpus proposal | Applied | Why |
|---|---|---|---|---|
| wordsCv | 1.0-1.7 | 0.9-2.3 | **0.9-2.3**, scale 0.6, w2 | Rhythm: corpus. The literature ceiling failed the human p90 |
| wordsP10 | ≤ 12 (scale 100) | ≤ 6 (scale 30) | **≤ 6**, scale 30 | Rhythm: corpus |
| wordsP90 | ≥ 40 | 20-90 | **20-90**, scale 60 | Rhythm: corpus. A floor of 40 failed the median human window |
| shortTurnShare | 0.40-0.90 | ≥ 0.65 | **≥ 0.65**, scale 0.3, w2 | Rhythm: corpus |
| memoTurnShare | ≤ 0.15 | ≤ 0.08 | **≤ 0.08**, scale 0.3, w2 | Rhythm: corpus |
| interruptionRate | 3-11 | 5-20 | **5-20**, w2 | Rhythm: corpus; the detector matches ICSI's hand-coded rate |
| overlapRate | 5-29 | 8-35 (0.5 s) | **3-20**, scale 10, w2 | Owner decision: real talking-over. The corpus at a 1 s threshold reads ICSI 0-12.5 and AMI 5-27.5; the engine overlaps only on a performed cut-in or reaction |
| pingPongRate | 0.20-0.50 | 0.25-0.60 | **size-aware**: ≤3 experts 0.25-0.60, 4-5 0.20-0.55, 6+ 0.15-0.50 | Owner decision. Anchored on AMI (3 speakers, chaired); chance A-B-A falls as 1/(N-1). ICSI reads higher only because it has no chair. Beyond 3 experts this is an assumption |
| questionShare | 0.08-0.25 | 0.05-0.25 | **0.05-0.25**, w2 | Rhythm: corpus (the two agree) |
| addressesChairShare | ≤ 0.10 | (not measurable) | ≤ 0.10 | Unchanged |
| concessionPer100 | 0.5-12, w1 | 0-5 | **0-12, weight 0.5**, counted on strict + broad lists | Owner decision: broader list ("fair enough", "granted", "true, but", "I'll give you that"), half weight until a real run calibrates it. Corpus drops the floor; the literature's upper bound kept because the broad list will read higher than the strict one did |
| positionChangePer100 | 0-2 | 0-2 | 0-2 | Agree |
| fillerTurnShare | ≤ 0.05 | ≤ 0.03 | **≤ 0.05** | Lexicon metric: the documented literature band kept |
| summaryEndingShare | ≤ 0.02 | ≤ 0.05 | **≤ 0.02** | Lexicon metric: the documented band kept, though humans run up to 0.05 (open question 4) |
| openerRepeatShare | ≤ 0.05 | ≤ 0.10 (scale 0.15) | **≤ 0.10**, scale 0.15, discourse-marker openers excluded | Owner decision: "yeah I think", "okay so" (openers starting yeah, yes, okay, so, well, um, uh, right, oh, mm, hmm, alright, no) do not count |
| recycled4gramShare | ≤ 0.03 | ≤ 0.03 | ≤ 0.03 | Agree |
| giniTurns | 0.15-0.45 | 0.08-0.42 | **size-aware**: ≤3 experts 0.05-0.30, 4-5 0.10-0.40, 6+ 0.15-0.45 | Owner decision. AMI (3) 0.05-0.30, ICSI (4-6) 0.15-0.42; uneven air-time is wanted |
| chairWordShare | 0.08-0.20 | 0.10-0.30 | **0.10-0.20**, scale 0.15 | Owner decision: Marcus is a light facilitator at 10-20% of words. The AMI chair's median 0.28 is a presenter-chair |
| multiParagraphShare, emDashPer1k, tics | as before | (not measurable) | unchanged | No human analogue |

Effect: the committed fixtures score 39.6 (baseline-like) and 89.6 (target-like), a 50-point gap. Re-running the corpora under the applied bands, 40-turn windows (p10 / median / p90):

| | AMI | ICSI |
|---|---|---|
| overlap counted from 0.5 s | 86.0 / 90.5 / 94.8 | 87.6 / 91.5 / 97.5 |
| overlap counted from 1 s (what the engine's overlap means) | 89.8 / 95.2 / 98.7 | 88.4 / 94.2 / 97.8 |

`docs/calibration-proposed-bands.json` keeps the corpus evidence and now says it was applied with these reconciliations; `HUMAN-CALIBRATION.md` and `HUMAN-BASELINES.md` carry a one-line note pointing here. `calibrate-human`'s `scoreWithBands` uses the same size-aware bands.

## 2b-7: the live floor

`server/src/engine/floor.ts` runs every motion. What it does, in order, for each turn:

1. **Who speaks** (`director.ts pickNext`): owed answers dominate, then being addressed, heat, wanting the floor, the relevance rule (someone the crux turns on who has not spoken), silence, minus floor share divided by an air-time weight (dominance and conviction from the dossier and the ledger). Some picks are forced by the room: the winner of a cut, the person the chair nudged, the expert whose crux a research finding hits, the asker answering the desk.
2. **Shape and length**: a set piece at the speaker's own natural length when they open the motion or return after four turns; a reply of 25 (duel), 35 (owed or addressed) or 45 words otherwise.
3. **Written in full** on the flagship against the frozen checkpoint prefix plus a projection of what has been heard; linted.
4. **Read by the listeners**: one fast `react` call per set piece or contested reply returns each listener's intensity, the sentence, an optional cut-in line and backchannel.
5. **Planned**: the director decides a cut (heat + 0.25 × intensity against the listener's threshold, never before the first sentence, never the founder, at most `interruptCap` per motion by profile, a gap between interruptions by the same person), the floor fight (dominance plus heat), a trailing reaction (intensity 2+, one listener, not the same listener two turns running, a third of them started over the last words) and, on a deep panel, one whisper per motion.
6. **Booked** on the floor state (turns, owed questions, duels, heat), and the plan and the whole text saved to the motion checkpoint.
7. **Next turn written** while this one plays, unless the chair, the desk or the end of the checkpoint comes in between.
8. **Performed** at `SPEAKING_PACE`: deltas word by word, the cut-in streamed over the speaker's last words, the speaker's message published with only the heard words and `cutOff`, the cut-in with `overlap`, a `pause` of 1.2-2.4 s, the resumed remainder (the cut sentence restarted) or the interrupter's turn. A caused concession earns a pause too.
9. **After**: research requests go out in the background; a desk calculation stops the room and comes back to the asker.

Between turns the chair may speak on a trigger (a dodge pressed twice, which also puts the dodger straight back up; heat above 0.85 with a six-turn cooldown; the ledger's herd, drift or unexplained fold by a stubborn expert; the clock at five minutes and at time), never twice in a row. At each checkpoint he checks in (a nudge to one person, research, the desk, the agenda, a question for the founder; silent by default). After each checkpoint the referee scores it, a `floor_set` says why those people had the floor, and a `floor` event carries heat, hands up and the clock. Before the ruling, the wind-down gives anyone the crux turns on who was not heard one short turn.

Unchanged: the waste guards (identical calls shared or refused, the stale-turn stalemate), the runaway backstops, the founder ceiling (now checked between checkpoints), quota pause and resume, the adversary challenge (one checkpoint of floor on the defeaters), the report. No cost caps.

**The MOCK engine.** `MOCK=1` now wires scripted models (`engine/mock-live.ts`) built from the two mock-v2 scenarios and runs the real engine: every word is scripted, every decision about who speaks, who cuts in and when is the engine's. Research goes through the real normaliser so citation ids are real, and the scenario's evidence-driven concession cites the id the room actually heard. `MOCK_ENGINE=scripted` keeps the older player (`mock.ts`, `mock-v2.ts`), still tested by `mock-v2.selftest`.

**Setup screen.** The directed / free-for-all choice is removed; new debates store `mode: 'directed'` and the engine ignores it. The war room and the deck no longer show it. Old debates keep their stored mode and open as before; old round-engine events (`floor_set` slates, interjections) still render.

### Integration tests the brief asked for

| Proof | Where |
|---|---|
| Overlap events appear | engine test [2e]: the cut-in carries `overlap` pointing at the cut turn, inside it; `mock-live.selftest` on both scenarios; `floor.selftest` [cut] |
| Belief changes carry causes | engine test [2d]: Ana's move carries `argument by bo` and its cost, Cy's is `unexplained`, raised once to the chair; `mock-live.selftest`: every concession has a cause and a cost (one cites a real citation id) |
| The dossier diversity check works | engine test [2d]: a twin draft fails, is redrafted with hints, the panel passes and says who was redrafted; `mock-live.selftest` (library): an opposed-incentives failure is fixed by the redraft |
| Budget and waste guards still end loops | engine test [5]-[7]: an expensive session is not cut, a founder ceiling asks and stops, repeating turns close the motion as a stalemate, and the identical-call guard refuses a third identical reaction call on the live path |
| Quota pause and resume still work | engine test [8]: a spent allowance parks the debate as paused with the step it was on, Resume brings it back, nothing is cut |
| Also | the projection (the next turn's prompt holds the heard words and never the unsaid remainder), a restart mid-performance replaying the turn with no model call, deterministic replay with a fixed seed, the relevance rule in the wind-down, an old row running unchanged |

## Realism scores (offline scorer, calibrated bands)

| Transcript | Expert turns | Index | Notes |
|---|---|---|---|
| MOCK v2 on the live path (`pricing`, `.scratch` run through the HTTP API) | 36 | **95.0** | CV 1.09, p10/p50/p90 1/14/49 words, 86% under 40 words, none over 150, interruptions 2.8, overlap 8.3, A-B-A 38%, questions 14%, Gini 0.26, chair 16% of words. The weak parts are recycled 4-grams (12%, the scripted words repeat) and interruptions (2.8, under the 5-20 band). In `mock-live.selftest` the two scenarios score 94.6 and 93.9 |
| MOCK v2, the old scripted player (`MOCK_ENGINE=scripted`), for comparison | 19 | 89.8 | CV 0.72, 63% short, interruptions and overlap 10.5, A-B-A 12%, Gini 0.14 |
| R1 (`_backups/r1-debate-d_lTKHusaR/transcript.md`) | 3 | 66.6 | **Not a meaningful score.** The backup holds only the three closing statements and four chair lines: that session was stopped by the old budget cap ("That is the budget for this session") before any floor turn. CV 0.04, every turn 85-90 words, chair 41% of words |

The mock scores measure the engine's rhythm on scripted words, not realism of speech; the plan's rule stands that realism is gated on real transcripts (R3, R4).

## Deviations and decisions

1. **No extra clarify question per missing stakes field.** The plan turns each missing field into a clarify question. With "zero extra steps for users" in the owner's decisions, intake is told to read the stakes and may fold one stakes question into the questions it already asks; anything still missing becomes a stated, conservative assumption marked "(assumed)" in the STAKES block, shown beside the goal (interactive) or logged as an `assumption` (autonomous).
2. **A failing panel proceeds, flagged.** After one redraft a panel that still fails the diversity check goes ahead; the problems are shown at panel approval in plain words and the founder can press Revise.
3. **Incomplete dissents are marked, not re-asked.** A re-ask is a whole ruling call; the report prints the dissent with what it lacks.
4. **Reactions are turns in the room, not turns on the floor.** They do not use the reactor's floor share or reset their silence, so the person who pushed back is free to take the floor next. A reaction that is a question makes the speaker owe an answer.
5. **The clock drives wind-down; it never closes a motion.** "The motion ends on substance": the referee decides. Clock milestones become chair lines, and the slot appears in each speaker's suffix. The `time` close reason the plan described was removed rather than left unused.
6. **The referee did not move onto the shared prefix.** It still judges the checkpoint's text with the claims beside it (the plan's 2b-7 note). Unchanged behaviour, smaller change.
7. **The unsaid remainder is not given to the referee.** It lives only in the motion checkpoint while the turn plays and is dropped when the performance ends.
8. **The chair line is a flagship call.** One or two sentences on a trigger, with a cooldown; the check-in stays on the floor's model so it writes the checkpoint's cache entry.
9. **Asides** reach the recipient's private card ("leaned over and said to you"); no shared prefix and no other seat ever sees them. Deep panels only, one per motion.
10. **The report header's mode badge** reads "live floor" for new reports; the stored setup mode means nothing now.
11. **The cost projection** (`scope.ts`) now counts about seven written turns a checkpoint, a reaction call for about two in three, a quarter of turns rewritten, check-ins and chair lines, dossiers and the clerk. It remains information only and uncalibrated.

## Uncertainties and open questions

1. **Nothing here has met a real model.** The reaction call's intensities, the cut rate, the chair's cooldown, the checkpoint size (6-8) and the reply budgets are design choices; the live mock's interruption rate (2.8 per 100) sits under the calibrated 5-20. R3 should tune them.
2. **Speaking pace costs wall time.** At 2.5 words a second a 100-word set piece takes 40 seconds to play; the next turn is written meanwhile, but a session will feel slower than raw streaming. A "skip ahead" control (Phase 3) or a higher default pace may be wanted.
3. **Air-time weights and the relevance rule are uncalibrated**: how uneven the room gets on a deep 8-expert panel is untested.
4. **summaryEndingShare stays at 0.02** (documented literature band) though the corpus shows humans up to 0.05. The owner may prefer the corpus band.
5. **The broad concession list** will make the engine's concession rate read higher than before; its weight is halved until a real run calibrates it.
6. **The stated-vs-revealed audit** (`audit` ledger input) is not wired: the referee is not asked for it yet.
7. **Debates in flight from before 2b-7** resume on the live floor at their next checkpoint (their round-engine checkpoint has no floor state, so a fresh one is made). They do not get dossiers, stakes or a ledger, by design.
8. **The `persona` seat on Codex** runs through the Codex JSON path like any other balanced call; untested offline beyond the fake seam.
