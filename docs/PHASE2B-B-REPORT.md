# Phase 2b-B report: the turn trailer, the linter, provider-neutral research

**Date:** 2026-10-26
**Brief:** implement plan steps 2b-3 and 2b-4 from `docs/PHASE2-PLAN.md` section 7, with no model quota. Stop at the offline acceptance tests; the real runs R1 and R2 need the owner's approval.
**Result:** both steps done and committed. Every gate was green after each step. No live model call was made, no debate ran against a real model, nothing left this machine, nothing was pushed (there is no remote). R1 and R2 were not run.

## Commits

| Step | Commit | What |
|---|---|---|
| 2b-A decisions | `99f8e77` | The owner's defaults: one report adversary on quick, the planner marks optional motions |
| 2b-3 | `5a07549` | The turn trailer, a shared tic lexicon, the realism linter (pure modules and their tests) |
| 2b-3 | `572da81` | Wired in; prompts de-seeded; claims to the judges; word budgets; `lint` replaces `bid` |
| 2b-4 | `c94d823` | Provider-neutral research: adapters, contract suite, fetch rule, engine, report, UI |
| 2b-4 | `591c9b8` | Docs: research on every door, the fetch rule |
| | (this commit) | This report |

## Method

Before each step I stated the approach against the plan's section 7 text and acceptance list, and against sections 2e, 2f and 3. After each step I reviewed the diff the way gstack `/review` does. The Skill tool returned an error for `review` again (as in 2a and 2b-A), so I followed `~/.claude/skills/gstack/review/checklist.md` by hand: pass 1 (data safety, races, LLM trust boundary, enum completeness, gate integrity), pass 2 (prompt issues, completeness, stale docs), then fixed what it found. Steps of that skill that contact outside services were skipped.

Gates after every step: `npm run typecheck`, `npm run build`, `npm run qa`, `npm run security-test`, a `MOCK=1` debate driven to `complete` through the real HTTP API and SSE by the local driver (`.scratch/e2e.mjs`, not committed), and the 8 imported debates listed and opened on a copy of `./data` with the agent CLI pointed at `/usr/bin/false`. For 2b-4 the mock was also run on the OpenAI and Codex doors.

## The owner's 2b-A decisions (applied first)

- **Quick gets one report adversary** (`reportAdversarySeats` in `shared/budget.ts`, separate from the rulings' `adversarySeats`; quick 1, standard 1, deep 3). The rulings' desk stays off on quick. The seat is held in the budget reserve, so it is never what the cap cuts.
- **The planner marks motions optional** (`optional` in the plan JSON; only an explicit `true` counts). An agenda marked all-optional keeps its first motion, so the 80% rule can never skip the whole agenda.
- Deep stays at $45 and the motion in hand at 100% is still ruled: both were already the behaviour; no change.

## 2b-3. Turn trailer, prompt de-seeding, rules lint, fast-tier rewrite

**Done**
- `server/src/engine/trailer.ts`: `splitTrailer()` takes `STANCE`, `CLAIMS`, `ASK`, `COMPUTE` and `RESEARCH` lines off the end of a turn (bold markers and bullets tolerated; a wrapped `CLAIMS` line continues). Only a block at the end counts: a trailer-looking line followed by more speech stays speech. `TrailerStreamFilter` holds back anything that could become a key line while the turn streams, and releases it if speech follows. It replaced `splitDeskCall`.
- `shared/lexicon.ts`: one data file for the corpus tics, used by the metrics script (which now imports it), the linter, and the prompt selftest (`PROMPT_BANNED`, `SPEECH_BANNED`).
- **Prompts de-seeded.** Gone from every builder: "say which is closer to right", "label every claim … say the word out loud", "say what it costs you", "your biases (own them…)", "what is everyone missing", "the one thing that would change your mind", "your falsifier fires … say it fired", "attack the strongest version". The rules now describe behaviour (talk to the person, not the chair; ask for sources; never speak the grade; no talk about your own talking). The position card is private and its parts are never named in the room. Five dead builders were deleted (`expertSystem`, `expertTurnPrompt`, `motionTurnPrompt`, `interjectionPrompt`, `closingPrompt`). The chair's mode note no longer describes the deleted bidding loop; free-for-all now means a quieter chair, and the setup screen says so.
- **Evidence grades move from speech to `message.claims`**, shown as chips under the bubble. The judges still see them: the referee's round text uses a judge view of `formatEvents` (`[claims: …]` beside each turn); the ruling and the adversary desk get a claims record in their own suffix; the audit's figure list and the report material carry the grades. The experts' shared prefix carries none, so the cache is untouched. The referee's rung 2 is now "graded in the claims record", and its `next_pressure` must be in plain words.
- **Word budgets inside today's round engine:** the openings and the first voice of each later round open a point (set piece, at most 130 words, floor thinking); everyone after them replies (at most 60 words, reply thinking); interjections at most 35; closings at most 90. Recorded as `message.shape`.
- **Rules lint** (`server/src/engine/lint.ts`): banned phrases, spoken labels, the antithesis (twice in a turn, or over three per motion across the room), filler, em-dashes, markdown, summary endings, an opener shared with the last 30 turns, recycled phrasing from the speaker's last 5 turns, length outside the budget, addressing the chair in a reply, the concede-attack-request template, a courtesy concession with no stance move, melodrama, a speaker's own never-say list. Threshold 3.
- **Fast-tier rewrite with a deterministic verifier** on the new `lint` seat (Haiku 4.5 / GPT-6 Luna, no thinking): same numbers (digits and number words), same names (no dropped and no invented capitalised names), same citation markers, inside the budget, a lower score, no trailer line. One retry with the reasons, then the original ships. Never applied to the founder, research, the desk or rulings. `message.lint` records score, rules and whether it rewrote.
- **The flagship 170-word re-run is removed.**
- **Seats:** `bid` is gone; `react` (idle until 2b-7, left off the casting sheet until it runs) and `lint` are added. Old casting sheets that name `bid` still render. `BID_THINKING` is removed.
- Stances from the trailer are kept server-side per motion (`meta.stances`); the linter uses them for the courtesy-concession rule, and 2b-4 uses the cruxes.
- The metrics script now computes the "unsupported figures" guard from the claims record and reports the lint rewrite rate (both `null` on older logs).

**Acceptance and test output**
- Trailer parser: 33 passed (full trailer, bold and bulleted keys, case, malformed lines dropped but stripped, an ungraded claim graded `assumed`, a wrapped `CLAIMS` line, a trailer-looking line mid-turn stays speech, the streaming hold-back at chunk sizes 1/3/7/1000, held lines released when speech follows).
- Prompt selftest: 68 passed at 2b-3 (76 after 2b-4): every exported builder is called with arguments that reach its branches and none outputs a `PROMPT_BANNED` phrase; a guard fails if a new builder is not covered.
- Lint: 40 passed (each rule on a synthetic turn; the verifier rejects a changed number, a dropped name, an invented name, a lost citation id, a non-improving edit, a trailer line, an over-budget edit; one retry then the original ships; a throwing rewriter costs only the polish; no model call below the threshold).
- Rung-2 guard: the engine test asserts the referee's prompt carries `[claims: [observed] …]` for a round whose speech carries no spoken label, and the referee's rubric defines rung 2 on the claims record. Whether the real referee then awards rung 2 is a model judgement R1 checks.
- Engine integration test: 70 passed at 2b-3 (no trailer on any published message or any live delta; Ana's tics rewritten on the lint seat; exact lint call count; only verified rewrites replace a turn; claims on the message; ASK addresses it; shapes and budgets in the prompts; the judges see the grades and the experts' prefix never does; stances kept; casting sheet has `lint` and no `bid`).
- Gates: typecheck, build, qa all pass; security-test 78/0; mock `complete` with claims and lint records on its messages; 8 imported debates open; the reducer folds them unchanged.

**Not run:** REAL R1 (Claude door, quick, the bakery topic). It needs the owner's approval.

## 2b-4. Provider-neutral research

**Done**
- `server/src/research/`: `types.ts` (request, adapter contract, the draft every adapter produces), `normalise.ts` (one normaliser for every door), `claude.ts`, `openai.ts`, `codex.ts`, `fake.ts`, `fixtures.ts`, `fetchguard.ts`, and `index.ts` (`runResearch`: picks the adapter from the debate's own door, turns a timeout into `partial`, an error into `failed` with a sentence for the room, a cancel into `failed`, and refuses a result that breaks an invariant).
- **The normaliser**: citation ids `c_` plus 8 hex of a SHA-256 of the normalised URL (scheme, `www.`, fragment and tracking parameters folded away); the cited URL is kept as the source wrote it, cleaned. On Claude and OpenAI a source no tool attested is `model_reported`: it gets no citation, no finding rests on it, and the summary says "[uncorroborated]" where it leaned on one. On Codex every source is `model_reported`, kept and labelled. Findings with no surviving citation are dropped; `[n]` markers become `[c_…]`; URLs written into prose are stripped (markdown links keep their text); summary ≤ 220 and spoken ≤ 60 words.
- **Claude**: `runOnce` in `sdk.ts` now reads the `tool_result` blocks of `user` messages and keeps each WebSearch/WebFetch call's input and a bounded copy (20K chars) of its result. Provenance: in a WebSearch result's link list, `search_result`; also read by WebFetch without error, `fetched`. A `quote` is only ever a search result's own snippet. One repair turn if the JSON does not parse. New seam `wireClaude({ queryImpl })`.
- **OpenAI**: step one is a Responses call on the balanced tier with `tools: [{type:'web_search'}]` and `include: ['web_search_call.action.sources']`; its `url_citation` annotations become numbered sources (`search_result`) and the annotated spans become `[n]` markers. Step two is a tool-free strict-schema call on the fast tier (new `clerk` seat) that turns the brief into findings by source number; it cannot add a source. Search calls are counted in the ledger.
- **Codex**: a research-only thread with `webSearchMode: 'live'` and a strict output schema; every other Codex turn keeps web search disabled, and the research thread keeps the shell's network off and the filesystem denied. Its capability note says it has search and nothing else. The SDK's `web_search` item carries the query only, so sources are `model_reported`.
- **The fetch rule**: a `PreToolUse` hook on WebFetch resolves the host and refuses loopback, private, link-local (cloud metadata), CGNAT, unique-local v6, v4-mapped v6, multicast, local names, credentials in the URL and non-http schemes.
- **The engine**: experts send the desk out with a `RESEARCH:` trailer line, offered only while the motion's allowance lasts (new `researchPerMotion`: quick 1, standard 2, deep 4; unprofiled 2; on Codex at most 1 for quick and standard). The chair's research goes through the same path; the "research desk is offline for OpenAI sessions" branch is gone. The answer lands as one `research` message holding the desk's spoken line with its citation markers; `research_done.result` carries the summary, findings and citations; failures are told to the room. A fast-tier clerk call matches findings to the experts' cruxes (from their STANCE lines); the room is told whose crux it hits, and the chair's next steer gets "who asked, what landed, whose crux". A motion waits up to 150 s for research on it before ruling, and the ruling says what was still pending. Requests in flight are persisted in `meta.researchInflight` and re-issued once after a restart; the planner waits on a resumed pre-session brief instead of asking again.
- **Fencing**: research text is fenced (`fenceUntrusted`) in `formatEvents` and the settled-motion block (so every prompt that reads the record), in the chair's planning digest and steer, in the report material and in the clerk's prompt. Research prompts carry the question and the panel's goal, nothing else.
- **Report**: a server-written `sources` list (never the writer's), rendered as a Sources section with each source's provenance in words ("reported by the model, not attested by the tool" on Codex); the writer is given the ids to cite. The side panel lists each answer's sources. A hostile Sources document was added to the print-QA corpus (it caught an overflow on unbreakable titles, fixed in the template).
- **MOCK**: research runs through the fake provider and the real normaliser on every door, so an OpenAI-door mock shows cited research and a Codex-door mock shows the labelled sources.

**Acceptance and test output**
- Contract suite (`server/src/research/contract.selftest.ts`, in `qa`): 81 passed. Every door (Claude, OpenAI, Codex, fake) satisfies the invariants; provenance per door, including the Claude cases (`fetched`, the snippet quote, an unattested URL dropped and marked "[uncorroborated]"); **golden equivalence: Claude, OpenAI and the fake normalise to the same result**, and Codex differs only in provenance; the request each door makes (tools, hook, tiers, schema, Codex thread options and capability note); on every door a cancel stops promptly as `failed`, a timeout is `partial` not a throw, a provider error is `failed` with a sentence; the fetch rule on 17 URLs and the hook itself; normalisation; the ledger saw the spend and searches.
- Engine integration test: 90 passed. Research from Bo's trailer runs through the real Claude adapter behind the fake seam, lands as one short line with markers, the room reads it only inside a fence, the clerk drops an expert it invented, the chair's steer names who asked and whose crux it hits, nothing is left in flight, the report carries and renders the sources, the writer was handed the ids, `transcript.md` lists them. **Restart**: a session killed with a pre-session brief in flight comes back, says it is picking the request up, asks the question once and answers it once, and completes.
- Reducer: 19 passed (a result's summary and citations are held; an old `research_done` still folds).
- Security test: 92 passed (the 78 before, plus an in-process session with an uploaded canary file and an injected forged fence marker: no research prompt carries the uploaded text; wherever the desk's words reach a prompt they are fenced and the forged marker is neutralised; the fetch rule refuses this machine's addresses and the hook denies the fetch).
- Mock over HTTP/SSE on the Claude, OpenAI and Codex doors: `complete`, research with citations, provenance as expected per door, no "offline" line. Imported debates: 8 list and open, no agent turn.
- Final gate run: typecheck pass; build pass; qa all pass (print QA 6 documents clean, prompts 76, OpenAI 55, Codex 120, director 36, trailer 33, lint 40, research contract 81, budget 29, engine 90, reducer 19, metrics self-test all pass); security-test 92/0.

**Not run:** REAL R2 (one research request per door). It needs the owner's approval.

## Deviations from the plan, and why

1. **Owner decisions committed first, on their own** (`99f8e77`), so the 2b-3 diff is only 2b-3.
2. **Word budgets.** The plan's set piece is 60-160 words from the persona's `typicalWords`; dossiers arrive in 2b-5, so it is one budget for everyone, 40-130, well under the old 160-word median. The reply floor is 3 words, not 12: "Which base?" is exactly the turn the room was missing.
3. **The lint rewrite prompt is exempt from the banned-phrase selftest**, because it has to quote the stock phrase it is removing. Its output is checked instead, by the verifier and a re-lint.
4. **A rewritten turn is visible as a swap.** The turn streams, is linted, and the published message replaces the stream. Holding flagged turns back from the screen needs generate-then-perform, which is 2b-7.
5. **Courtesy concession** is flagged only when the speaker's stance is known and did not move (it needs a previous STANCE line on the motion); without one it is not judged.
6. **The fetch rule is a `PreToolUse` hook, not `canUseTool`.** Web turns run under `dontAsk` with WebFetch pre-approved, and per the SDK types a pre-approved tool does not reach `canUseTool`; a hook runs on every call.
7. **Crux matching** reaches the chair's next steer and a system line, not the floor director (2b-7), and uses the cruxes from STANCE lines, not the belief ledger (2b-6).
8. **A motion waits for its research before ruling** (plan 2f item 3). Not in section 7's 2b-4 list, but cheap and it closes the "ruled before the evidence arrived" hole the new background research would otherwise open.
9. **Research per motion** is a new profile setting (`researchPerMotion`), next to the existing session cap; the Codex door gets a 4-minute research budget because its turns are serialised per credential and research there stops the floor.
10. **Golden fixtures are fictional facts on example domains**, not the Irish VAT question: the fixtures must not assert anything about the real world. The VAT question stays for R2.
11. **The research message carries the spoken line only** (the full summary and sources are on `research_done.result` and in the side panel). Old debates' research messages, which carry the old brief, render as before, now fenced in prompts.
12. **Research that lands after the room has closed** goes to the side panel and the record only, with no message nobody can hear.
13. `Engine.forget(id)` was added: it drops a run from memory without touching data, which is what a restart does; the engine test uses it.
14. **OpenAI's structuring step sees the brief unfenced.** It is inside the research desk; the desk's output is fenced where it enters the room, as the plan specifies.

## Unfinished or uncertain

- **All transport shapes are hand-written.** Claude Code's WebSearch result format ("Links: [{title, url}]"), whether its link objects ever carry a snippet, OpenAI's `url_citation` spans and the `include` field, and the Codex `web_search` item are taken from the SDK types and my reading; R2 records one real transport per door and checks them.
- **The fetch hook is not exercised against the real CLI.** The contract suite checks the hook is in the options and that it denies; that the bundled CLI honours a `PreToolUse` deny under `dontAsk` is from the SDK's types, not observed. A redirect or re-resolution to a private address after the check is a known gap (in SECURITY.md).
- **OpenAI web-search charges are counted, not priced.** Where the API reports them is for R2.
- **`thinking: 0`** on the lint and clerk calls is assumed to mean no thinking on the Claude CLI (it maps to `none` on Luna).
- **Real-model behaviour is unmeasured**: whether models emit the trailer reliably, the lint false-positive and rewrite rates (the plan's target is ≤ 25-30%), whether the verifier is too strict on paraphrased number words, and whether the referee awards rung 2 from the claims record. R1 measures all of these.
- **No browser was opened** (the pages request Google Fonts). The claim chips, the Sources list in the side panel and the report's Sources section are built, typechecked and exercised through the reducer, the renderer and print QA, but not looked at.
- **Pre-existing:** `qa`'s print check launches local Chrome on HTML that links Google Fonts, so `qa` may make font requests.
- The local e2e driver and the old-debate reducer check live in `.scratch/` (gitignored), as in 2b-A.

## Open questions for the owner

1. **Approve REAL R1?** Claude door, quick profile, no files, the Sunday-bakery topic: about 50-55 flagship calls and 15 fast-tier calls, about $4-5 (cap $6), under 25 minutes. It measures the tics, the rewrite rate, meaning drift in every rewrite, and whether rung 2 is still reached.
2. **Approve REAL R2?** One research request per door on the Irish VAT question, under $0.25 per door. Include Codex? It also settles whether OpenAI can do search and strict JSON in one call, and where search charges are reported.
3. **Codex research parity.** Sources on that door are labelled "reported by the model, not attested by the tool", and research there pauses the floor for up to 4 minutes. Keep it, or limit Codex research to the pre-session briefs?
4. **Rewrites visible as a swap until 2b-7**, or hold back the stream of a turn while it is being linted (a few seconds of silence instead)?
5. **Allowances**: research per motion 1 / 2 / 4 (quick / standard / deep), lint threshold 3, set piece 130 and reply 60 words. Fine to start with and calibrate after R1?
6. Still open from 2a: whether a less balanced room (Gini 0.25-0.45) is wanted.
