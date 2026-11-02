# Logic report: pure modules for plan steps 2b-5 and 2b-6 (and the 2e lint rules)

**Date:** 2026-10-26
**Branch / worktree:** `wt/logic` in `debate-wt-logic`, based on `2b58e8c`.
**Brief:** pure, fully unit-tested TypeScript for the belief ledger (2c), persona dossiers and the panel diversity check (2a), stakes (2d) and the realism lint rules (2e). New files only. No engine, prompt or runner integration, because another agent owns those files. This report lists the integration points so the merge can be done mechanically.
**Result:** done. Four modules, one shared fixture file, four test suites and one cross-module scenario, all in `server/src/realism/`, all in `npm run qa`. No live model call, no debate against a real model, nothing sent off this machine, nothing pushed.

## Commits

| Commit | What |
|---|---|
| `d26c34f` | `lint-rules.ts` (the one banned-phrase list and the rules), the test helper, the fixtures |
| `1a0da02` | `dossier.ts`: dossier validation, diversity check, voice card, public roster |
| `8540f1f` | `stakes.ts`: stakes with assumed/real marking, meeting clock, dissent tripwires and minority report, reality-check seat |
| `51932b8` | `ledger.ts`: belief ledger reducer, STANCE line parser, "how minds changed" summary |
| `653b863` | `selftest.ts` (all suites plus the scenario), one `&&` added to `server/package.json` `qa` |
| `4e789c4` | Fixes from the review pass (below) |
| (this commit) | This report |

The only edit to an existing file is the end of the `qa` script in `server/package.json` (` && tsx src/realism/selftest.ts`). If it conflicts on merge, keep both sides' additions on that line.

## Gates (final run, in this worktree)

- `npm run typecheck`: pass (server and web).
- `npm run build`: pass.
- `npm run qa`: pass. Existing suites unchanged (prompts 10/10, OpenAI 54/54, Codex 120/120, director 36/36, budget 28/28, engine 47/47, reducer 17/17, metrics self-test). New: lint-rules 66/66, dossier 79/79, stakes 68/68, ledger 96/96, scenario 15/15.
- `npm run security-test`: 78 passed, 0 failed.
- `MOCK=1` debate through the real HTTP API: `complete` (64 events, 21 messages, report written). Driver: `.scratch/e2e.mjs` (gitignored, not committed), `DATA_DIR` in `.scratch/`, `CHROME_PATH=none`.
- `npm install` used the npm registry only. It changed one line of `package-lock.json` (`hasInstallScript` on better-sqlite3); I reverted that so the lockfile stays as it was.

## Method

gstack `/review` was tried through the Skill tool and returned an error, as in Phases 2a and 2b-A. I followed `~/.claude/skills/gstack/review/checklist.md` by hand on the branch diff. Pass 1 (SQL, races, LLM trust boundary, shell, enum completeness, gate integrity) found one real issue: model-written dossier strings had no length cap, and `publicReputation` goes into the shared prefix. Pass 2 found two more. All three are fixed in `4e789c4` and have tests:

1. `parseDossier` caps every model string at 400 characters and cuts `publicReputation` to 45 words.
2. A hardening that cites evidence or a computation no longer counts toward a herd. Concessions already worked this way.
3. The voice card's "under pressure" line is now in the second person ("Goes quiet" became "go quiet.").

Gate integrity: the diff adds tests and one `qa` step. It removes and relaxes nothing.

## What was built

All modules are pure. They do no I/O, use no clock and no randomness, and never mutate their inputs. The same inputs always give the same output, and the tests check that.

### 1. `server/src/realism/ledger.ts`: belief ledger (2c)

- `reduceLedger(state, input) → { state, emits }` and `foldLedger(state, inputs)`. Inputs:
  - `open`: starting stances, from the clerk call.
  - `turn`: a spoken turn carrying the parsed STANCE line, or nothing if the trailer was missing.
  - `evidence`: research landed, or the desk computed something.
  - `attribute`: the referee names a cause.
  - `audit`: the referee's read of stated against revealed belief.
  - `checkpoint`.
- Emits: `belief` (persist as the `belief` event), `concession` (persist as the `concession` event), `concession_update` (persist as another `concession` event with the same `messageId`; readers keep the latest for each id), and `flag`.
- **A stance move emits a concession.** Its `kind` is `full` when the expert crosses to the other side and `partial` otherwise. The trailer can override it with `conditional` or `tactical`. `movedBy` comes from the trailer (`moved: evidence c_ab12 by kabir`) and is `unexplained` when the trailer gives none. `cost` comes from the trailer. If the trailer gives none, it is derived: a full concession costs "walks back a public stance: …" (from the dossier's `priorPublicStance`) or "gives up their opening side", leaving ±2 costs "gives up a firm position", and anything else costs "face".
- **Hardening** (moving further out on one's own side) is not a concession. It is recorded for the summary and for herd detection. A concession followed within 3 of that expert's own turns by a move straight back, with no evidence, computation or falsifier behind it, is reclassified `tactical` and flagged.
- **Confidence-only changes** update the belief and emit nothing.
- **Carry-forward:** a turn with no trailer, or an unreadable STANCE line, leaves the stance as it was. Two misses in a row raise `missing_trailer` for the referee, once per streak. Someone with no stance at all raises `no_stance` once, and nothing is invented for them. Their first readable trailer becomes their starting belief, not a concession.
- **Unexplained-move flag:** carries `chairTrigger: true` when the expert's stubbornness is 0.6 or more, plus `candidates` (evidence refs that landed since their last stance) for the referee. An `attribute` input resolves it.
- **Stubbornness trait:** `allowedCauses(s)` gives the causes that count for that level. At 0.7 or more: evidence, computation, falsifier. At 0.4 or more, argument and founder are added. Below 0.4, social is added too. A cause outside the allowed set raises `weak_cause`, which is a chair trigger at 0.7 or more. A cited `ref` that never appeared as an `evidence` input raises `unknown_ref`.
- **Herd detection** runs at each checkpoint over the window since the last one. It fires when 3 or more distinct experts move the same way, with no evidence or computation landing in the window, where moves that cite evidence or a computation do not count and anyone who moved both ways is excluded. It is a chair trigger. `detectHerd(motion, since, upto)` is also exported.
- **Drift to the middle:** at a checkpoint, polarisation (mean |stance|) at half or less of its opening value, from an opening of at least 1.0, raises a flag once per motion.
- **Stated vs revealed** (referee audit): flagged when the two stances are 2 or more points apart, or on opposite sides.
- `parseStanceLine(value)` parses the STANCE trailer line (`for+1 | confidence: medium | crux: … | moved: … | cost: … | kind: …`). It tolerates bold markers, a leading `STANCE:` and spaces, and returns `null` when the stance cannot be read.
- `ownBelief(state, motion, expert)` returns a copy of that expert's belief and nobody else's. `ledgerChairTriggers(state, motion, sinceSeq?)` returns the open chair triggers.
- **"How minds changed":** `mindChanges(state, motion, seatOrder?)` returns, per expert, the start and end stance, net shift, `changedMind` (crossed sides, or moved 2 or more points toward the other side), each move with its cause and cost, hardenings, unexplained moves and `heldFirm`. It also returns `evidenceThatMoved`, `persuaders`, cause counts, `causedShare` (the plan targets at least 0.8), herds, open unexplained moves, and polarisation at start and end. `renderMindChanges(summary, nameOf)` renders it as plain text with no pronouns.
- Rules live in `LEDGER_RULES`.

### 2. `server/src/realism/dossier.ts`: dossiers and the diversity check (2a)

- `parseDossier(raw, { personaId, panelIds })` validates the persona call's JSON against the shared `Dossier` type and `DOSSIER_RULES`.
  - **Hard errors fail the dossier**, so the caller regenerates it: fewer than 2 failures or 1 win in the history, a bad register, missing stubbornness, too little vocabulary, no tics, a tic that is itself a banned phrase, no under-pressure line.
  - **Soft problems are fixed and reported as warnings:** values out of range are clamped, long lists trimmed, duplicates removed, relationships to self or to anyone off the panel dropped.
- `checkDiversity(panel)` implements the plan's thresholds plus the "similar styles, incentives, biases" checks the brief asked for:
  - registers distinct across at least 70% of the panel;
  - longest `typicalWords` at least 3 times the shortest;
  - vocabulary Jaccard at most 0.2 for every pair;
  - someone at stubbornness 0.35 or less and someone at 0.7 or more;
  - at least `min(2, n-1)` pairs whose incentives point opposite ways on the goal;
  - bias, incentive and under-pressure token overlap within limits;
  - no tic shared between two experts.

  It returns `failures`, `regenerate` (in panel order; on a pairwise clash the later expert is regenerated) and per-expert `hints` for the regeneration prompt. Hints describe behaviour and never script wording. The converged fixture trips all ten rules and the varied fixture passes.
- `voiceCard(dossier, { motion, ticUse, belief })` builds the private suffix card, capped at 1,100 characters (about 250 tokens). It holds the register and natural length, the vocabulary, each tic with what is left of its budget ("spent this motion" once used up), behaviour under pressure, the two incentives most relevant to the motion, the stubbornness behaviour, the expert's own current belief, their own `neverSay`, and their prior public stance. When the card is too long, the least important lines are dropped first.
- `rosterText(members)` builds the public roster for the shared prefix. It reads only name, role and `publicReputation`, puts each member on one line, keeps panel order and is byte-identical across calls. Old debates without dossiers fall back to name and role.
- `effectiveNeverSay(d)` returns the global banned list plus the expert's own `neverSay`, for the linter.

### 3. `server/src/realism/stakes.ts`: stakes (2d)

- `resolveStakes(draft, { founderName })` returns the stakes with **per-field provenance** (`founder`, `dossier` or `assumed`). `stakes.source` is the weakest field's source. It also returns `missing`, `clarify` questions (one per missing field, including "What is at risk if this goes wrong: money, people, or time?") and `assumptions` (one line per assumed field, for autonomous mode).
  - **Missing fields get stated, conservative assumptions.** The owner defaults to the founder, the deadline to "the end of this session", and an unknown door to one-way.
  - **No figure is ever invented.** Money at risk that was not stated becomes "not stated".
- `stakesBlock(marked)` renders the constant STAKES block for the cached prefix, with `(assumed)` on every assumed line. `markAll(stakes)` marks a record that has no per-field provenance.
- `rulingOwner(stakes, roomNamed?)` and `costOfBeingWrong(marked, 'yes' | 'no')` build the ruling lines.
- **Meeting clock:**
  - `slotSecFor(turnCap, motions)` uses the plan's formula: turn cap ÷ motions × 42 words ÷ 2.5 words a second, plus 1.5 s of pause per turn. Standard comes out at about 11 minutes.
  - `advanceClock` moves the clock by words, pauses and research waits.
  - `clockMilestones(prev, next)` returns `half`, `five_left`, `one_left` and `time`.
  - `isOutOfTime` reports whether the slot is used up.
  - `clockLine(clock)` gives the suffix line: "Fourteen minutes into a twenty-minute slot."
- **Dissent with teeth:** `DissentRecord` extends today's dissent shape with `tripwire: { signal, by }` and `costOfIgnoring`. `dissentProblems(d)` returns which of these are missing: `no_tripwire`, `vague_signal`, `no_deadline` (a deadline must name a time or an occasion) and `no_cost`. `minorityReport(decisions)` keeps old-shape dissents and marks them incomplete. `renderMinorityReport` renders it as text.
- **Reality-check seat:** `realityKindFor(topic)` picks `operations`, `finance` or `delivery` from the topic words (operations by default). `checkRealitySeat(panel, topic)` passes on the exact kind or any implementer, and otherwise returns a hint for the architect's retry.

### 4. `server/src/realism/lint-rules.ts`: realism lint rules (2e)

- **`BANNED_PHRASES` is the one list.** `bannedPhrasesIn(text, extra?)` serves both the per-turn rule and prompt de-seeding (a selftest that no prompt builder's output contains a banned phrase). Matching ignores case and extra whitespace, respects word boundaries and treats ’ and ' alike.
- Rules, each with a weight in `LINT_CONFIG`:
  - banned phrase; the speaker's own `neverSay`; spoken evidence labels;
  - more than one antithesis in a turn, plus a per-motion room budget;
  - filler praise; em-dashes (and spaced en-dashes or `--`); markdown or lists; summary endings;
  - an opener shared with the last 30 turns (seated names normalised); 4-grams the speaker reused from their last 5 turns;
  - length outside the shape's word budget;
  - a reply to a colleague that opens on the chair's name;
  - the house template (name plus concession, then attack, label and a request to the chair: 3 of the 4 parts);
  - courtesy concession (concession language when the trailer says the stance did not move);
  - a tic over its per-motion budget; meta-speech; melodrama.
- `lintTurn(text, ctx) → { score, hits, rules, words, antithesisCount, ticsUsed }`, plus `shouldRewrite` (score 3 or more) and `toLintRecord(result, rewrote)` for `message.lint`.
- Not here: the fast-tier rewrite and its verifier (numbers, names and citation ids unchanged). Those are the other agent's 2b-3 work.

### Fixtures and tests

- `fixtures.ts`: a varied and a converged four-person panel (a fictional bakery), a raw dossier JSON with every soft defect, the corpus tics written as baseline turns, and clean turns. No private data.
- `selftest.ts` runs the four suites and a scenario that drives all four modules over one motion: a converged panel is sent back, the regenerated panel passes, stakes are assumed and marked, the ledger opens, five turns are linted and recorded, the clock advances, voice cards show only each expert's own belief, a checkpoint runs, and the mind-change summary and minority report are produced.

## Integration points (for the merge)

Every step below is additive. Debates without dossiers, stakes or beliefs keep today's behaviour, because absent means "feature off". Function names are given rather than line numbers, because the other agent is editing those files.

### Lint (2b-3, owned by the other agent)

1. **Prompt de-seeding selftest:** in `server/src/agents/prompts.selftest.ts`, call every prompt builder with fixture inputs and assert that `bannedPhrasesIn(output).length === 0`. The phrase list is `BANNED_PHRASES` only; do not create a second list. Known seeds to remove first: "Say which one is closer to right" (`openingFloor` in `motions.ts`), "would change my mind" (the closing prompt), "own them", "out loud" and "name the cost" (`MEETING_RULES`, `positionCardBlock`, `positionCardPrompt`), and "rather than admired" and "I am putting it to you in writing" (chair prompts).
2. **Per turn**, after `splitTrailer` and before performance or persistence:

   ```ts
   lintTurn(text, {
     neverSay: d.speech.neverSay,
     wordBudget: DIRECTOR_RULES.words[shape],   // or wordBudget(shape, seat)
     chairName: 'Marcus',
     replyTo,
     names,
     recentTurns,
     speakerRecentTurns,
     stanceMoved,      // from the ledger step below; undefined until 2b-6 is wired
     tics: d.speech.tics.map((x) => ({ ...x, used: floor.ticUse[speaker]?.[x.text] ?? 0 })),
     roomAntithesis: { used, budget },
   })
   ```

   If `shouldRewrite(r)`, run the rewrite and verifier, then re-lint. Persist `message.lint = toLintRecord(r, rewrote)`. Afterwards, add `r.ticsUsed` to `FloorState.ticUse[speaker]` and `r.antithesisCount` to the motion's room counter.
3. Never lint the founder, research, the quant desk or rulings, as the plan says.
4. **Optional:** `scripts/transcript-metrics.ts` keeps its own `FILLER`/`TICS` lexicons, which measure. The lint lexicons enforce. They overlap on purpose. If one source is preferred, the metrics script can import `FILLER_PATTERNS`, `ANTITHESIS` and `SUMMARY_ENDING` from `lint-rules.ts`, but its self-test baselines would then shift. Leave them separate until R1.

### Dossiers (2b-5)

5. **Persona call** (new seat `persona`, balanced tier; `shared/models.ts` gains the seat). Pass its JSON through `parseDossier(raw, { personaId, panelIds })` and regenerate once on `!ok`. Ask the call to also return **`goalLean: -1 | 0 | 1`**, which the diversity check needs. Either add `goalLean?: -1 | 0 | 1` to `Dossier` in `shared/realism.ts` (one optional line), or keep it beside the dossier in `meta`. Today `PanelEntry` carries it separately.
6. **Relationships pass:** call `parseDossier` with `panelIds` already set, which drops relationships to unknown ids. The relationships call should merge its output into each dossier's `relationships`.
7. **Diversity check:** `checkDiversity(entries)`. If it is not ok, regenerate each id in `regenerate` once, adding `hints[id]` to that persona prompt, then run the check again. If it still fails, proceed and log the failures, as the plan allows one retry. Store dossiers in `meta.dossiers[personaId]`, which needs a `DebateMeta` field in `server/src/db.ts`.
8. **Roster:** in `buildRoomBlocks` (`server/src/engine/transcript.ts`), put `rosterText(personas.map((p) => ({ id: p.id, name: p.name, role: p.role, dossier: meta.dossiers?.[p.id] })))` in the session-constant layer. It is byte-stable, so the plan's cache test should be extended with dossiers present.
9. **Voice card:** in the expert's per-turn suffix, add `voiceCard(dossier, { motion: item.motion ?? item.title, ticUse: floor?.ticUse[id], belief: ownBelief(ledger, motionId, id) })`. Never put it in the system prompt.
10. **Linter:** `neverSay` comes from the dossier, as in step 2.
11. **Director:** `DirectorSeat.temperament` and `typicalWords` come from `dossier.temperament` and `dossier.speech.typicalWords`.

### Stakes (2b-5)

12. **Intake JSON** gains `stakes` as a `StakesDraft`. Run `resolveStakes(draft, { founderName })`. In interactive mode, emit `clarify` events from `clarify[]`, then run `resolveStakes` again on the answers. In autonomous mode, emit one `assumption` event per `assumptions[]` line. Store `meta.stakes = marked` (the `MarkedStakes`, so per-field provenance survives).
13. **STAKES block:** `stakesBlock(meta.stakes)` goes in the cached constants of `buildRoomBlocks`, next to the goal.
14. **Reality-check seat:** after panel design, run `checkRealitySeat(personas, topic)`. If it is not ok, retry the architect once with `hint` appended (`architectRevisePrompt` takes feedback). Also add one rule line to `architectSystem()` asking for the implementer, described as behaviour.
15. **Rulings:**
    - The owner is `rulingOwner(meta.stakes?.stakes, roomNamed)`.
    - The ruling prompt gets `costOfBeingWrong(meta.stakes, 'yes' | 'no')`.
    - The ruling JSON's dissent shape (in `prompts.ts`, the `"dissents": [...]` lines) gains `tripwire: { signal, by }` and `costOfIgnoring`. `Decision.dissents` in `shared/types.ts` can widen to `DissentRecord` (both new fields optional, so old rows stay valid).
    - After each ruling, if any dissent has `dissentProblems(d).length`, either re-ask once or keep it marked.
16. **Report:** `minorityReport(meta.decisions)` and `renderMinorityReport` feed a minority-report section. `shared/report-types.ts` gains an optional `minority?: MinorityEntry[]` and a `stakes?` section. The renderer change belongs to whoever owns `report/`.
17. **Clock (2b-7):**
    - `newFloor(motionId, seats, seed, slotSecFor(profile.turnCap, motions))` (the director already takes `slotSec`).
    - After each performed turn, `floor.clock = advanceClock(floor.clock, { words, pauseMs })`.
    - `clockMilestones(prev, next)` produces chair triggers. When `isOutOfTime`, close the motion with reason `time`.
    - `clockLine(floor.clock)` goes in the speaker's suffix, never the prefix.

### Belief ledger (2b-6)

18. **State:** keep `LedgerState` in `meta.beliefs`, or rebuild it by folding events. Create it with `newLedger(Object.fromEntries(personas.map((p) => [p.id, { stubbornness: dossier?.stubbornness ?? 0.5, priorPublicStance: dossier?.priorPublicStance }])))`.
19. **Motion open:** the clerk call (new seat `clerk`) derives a starting stance per expert from the position cards. Feed `{ type: 'open', motionId, seq, beliefs }` and persist the emitted `belief` as the `belief` event.
20. **Each expert turn:** the 2b-3 `splitTrailer` yields the STANCE line value. Run `parseStanceLine(value)` (null if missing or unreadable) and feed `{ type: 'turn', motionId, seq, expert, messageId, report }`. Persist emitted `concession` and `concession_update` items as `concession` events.
    - **Web reducer:** keep the latest concession per `messageId` (`web/src/lib/debate-state.ts` currently appends each one).
    - **Linter:** set `stanceMoved = report ? report.stance !== before : undefined` in the lint context (step 2).
21. **Evidence:** on `research_done` (with a result) and `compute_done`, feed `{ type: 'evidence', kind, ref }`. Use the citation id or compute task id, the same id an expert's trailer would cite.
22. **Referee checkpoint:**
    - Feed `{ type: 'checkpoint' }` and pass the flags emitted since the last checkpoint into the referee prompt.
    - For each open `unexplained_move`, the referee may return a cause. Feed `{ type: 'attribute', messageId, movedBy }`.
    - The referee's stated-vs-revealed read is fed as `{ type: 'audit', expert, revealed }`.
23. **Chair triggers:** have `ledgerChairTriggers(state, motionId, sinceSeq)` join the director's `chairTrigger`:
    - `unexplained_move` (stubborn) becomes "You folded quickly, [name]. What moved you?"
    - `herd` becomes "the chair attacks the consensus".
    - `drift_to_middle` is also a chair trigger.
    - The chair prompt should describe the behaviour, not script those words.
24. **Report:** `mindChanges(state, motionId, seatOrder)` per motion goes into `reportMaterial`. `ReportData` gains `mindChanges?: MindChangeSummary[]`, as the plan's Appendix C lists. `renderMindChanges(sum, nameOf)` gives a ready text form for the report writer or the PDF.
25. **Mock v2:** the mock should show a caused and an unexplained concession (2b-6 acceptance). Its existing concession (`mock.ts`, around line 449) can be produced by `reduceLedger`, so the mock exercises the same code.

## Deviations and decisions

1. **Hardening is not a concession.** The plan says a concession event is emitted "when an expert's stance moves by one or more points". Moving further out on one's own side is not giving ground, so the ledger records it as a hardening instead. It still counts for herds, and it detects tactical reversals.
2. **Moving off the fence counts as a concession** (`partial`, toward the side moved to). Someone who was undecided and is persuaded did change their mind.
3. **Cause inference is left to the referee.** The ledger never guesses a cause. It only lists `candidates` on the unexplained flag. A guessed cause would inflate `causedShare`, which is the plan's 80% realism target.
4. **The voice card does not list the global banned phrases.** The plan's card includes `neverSay`, which by its own definition "includes the global banned list automatically". Printing those phrases in a prompt would break the de-seeding selftest (2a, item 6), so the card shows only the expert's own phrases that are not already globally banned. The linter enforces the global list.
5. **Assumed stakes are marked per field,** not only through `Stakes.source`. Integration stores `MarkedStakes` in `meta`; `markAll` covers stakes without per-field marks.
6. **An unknown door is assumed one-way:** it is the cautious default, and it is printed as assumed.
7. **Any implementer satisfies the reality-check seat.** The topic only picks which kind the architect is asked for when nobody suitable is seated.
8. **Extra diversity rules** (bias, incentive and under-pressure overlap, shared tics) go beyond the plan's list, because the brief asked for "similar styles/incentives/biases". Their thresholds are in `DOSSIER_RULES.diversity` and are uncalibrated.
9. **`banned_phrase` list:** in addition to the plan's corpus tics, it includes "would change my mind", "rather than admired" and "I am putting it to you in writing" (plan 1.2) and "load-bearing claim" (position-card jargon). Once wired, closing prompts must stop asking for "the one thing that would change your mind" in those words.

## Unfinished or uncertain

- **Nothing is wired.** That is by design: integration happens after the merge, following the list above.
- **Thresholds are uncalibrated:** the lint weights and rewrite threshold (3), the diversity overlaps, the stubbornness trigger (0.6), the herd size (3), the tactical window (3 turns) and the drift share (0.5). R1 and R3 transcripts should tune them. Each lives in one config object.
- **Lint regexes are heuristics.** The antithesis pattern catches the corpus forms ("X is not A, it is B", "not a X, a Y."), but not every rhetorical symmetry. The template rule needs 3 of its 4 parts, so it will miss some cases.
- **`contentTokens` uses a crude stemmer.** It is fine for overlap checks, but the overlap numbers are approximate.
- **`goalLean` is not yet in `Dossier`** (see step 5).
- **The concession event is append-only,** so a cause the referee fills in later arrives as a second event with the same `messageId`. The web reducer and any report reader must keep the latest one per id.

## Open questions for the owner

1. **Hardening:** should moving further out on one's own side also appear as an event (for example a `concession` with a new kind such as `hardened`), or stay ledger-only as now?
2. **Unknown deadline:** is "the end of this session" the right default, or should autonomous mode ask the founder for a date in the report's open questions?
3. **Closings:** may they still ask for "the one thing that would change your mind" in different words, now that the exact phrase is banned?
4. **Diversity retry:** after one regeneration, should a panel that still fails go ahead (current integration advice, per the plan) or block at panel approval with the failures shown?
