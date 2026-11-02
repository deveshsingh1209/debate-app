# Costfix report: the research desk's cost

Branch `wt/costfix`, from `main` at `b9dfe5d`. No live model calls, no real debates, nothing pushed.

## The evidence

The real R1 run (backup `r1-debate-d_lTKHusaR`, server log `r1-server.log`) has two research calls:

```
[agent] research ok in 85s  ($3.970) [in=6 out=1854 cw=378565 cr=4370]
[agent] research ok in 117s ($3.973) [in=6 out=1788 cw=378286 cr=4370]
```

Together they cost about 7.94 USD. Every other call in that debate cost under 1.5 USD in total, and the biggest was the report revision at 0.61 USD. Each research call processed about 384,800 tokens. About 98% of them were cache writes, and the answer was about 1,800 tokens. Cache reads stayed at 4,370 in both calls. That matches the CLI's fixed prefix (its system scaffolding plus the web tool definitions). So almost none of the 378,000 tokens written to cache were ever read back. The caching premium was paid and nothing was saved.

## Root cause

**The brief's first hypothesis does not hold.** The research prompt never carried the room. `researchPrompt` is the question plus the panel goal, about 150 tokens, and the contract and security suites already assert that. Research was also not on the flagship: `SEAT_TIER.research` has been `balanced` (Sonnet 5.5) since `2621523`.

**The cost came from the tool loop.** I read the bundled CLI's own tool code (`node_modules/@anthropic-ai/claude-agent-sdk/cli.js`):

1. **No cap on how often the loop searched or fetched.** `budget.maxSearches = 6` only set `maxTurns` to `max(6, 6*2+4) = 16`. Nothing counted or refused a search, and nothing refused a repeated query. The `searches` figure in the result was a count after the fact, not a limit.
2. **WebFetch put whole pages into the loop.** The CLI's WebFetch reads up to 100,000 characters per page (`QV1=1e5`). For some hosts it returns the page text itself. Anything that enters the loop's context is re-sent with every later request in the loop.
3. **Every search is a nested model request.** The CLI's WebSearch runs a separate request on the main loop's model, using the server-side `web_search` tool with `max_uses: 8`. That request also **inherits the loop's `maxThinkingTokens`**. The research loop ran with `thinking: 4000`, so every search paid for thinking as well.
4. **No accounting.** The app saw one total per turn and nothing per request, so a runaway was invisible until the bill came in.

**What could not be settled offline:** how the 378,000 tokens split between fetched page bodies and search content. The new per-request log line (`req=`, `max=`, see below) will show the split on the next live run. Also, the per-token rate implied by R1 (about 10.3 USD per million tokens processed) is higher than Sonnet-class list rates would give for this mix. This needs the owner-approved probe (R2). It is listed under open questions.

## What changed

### The Claude door: three steps, each with its own context (`research/claude.ts`)

| step | model | context | tools |
|---|---|---|---|
| 1. search | Sonnet 5.5, **no extended thinking** | question + goal (unchanged) | **WebSearch only**, behind a gate |
| 2. read | none (the server) | the pages the draft cites that a search actually returned, at most 3 | the desk's own fetcher |
| 3. verify | Sonnet 5.5, 2,000 thinking | question + draft JSON + fenced extracts, **at most 4,000 characters per page** | none, fresh session |

- **The gate** (`research/meter.ts` `searchGate`, wired as a PreToolUse hook through a new `toolGate` option in `agents/sdk.ts`) refuses a search past the allowance (4), a repeated query (case, punctuation and word order are ignored), and WebFetch. Each refusal tells the model to write up what it has. The gate **ends the loop** (`continue: false`) in three cases: the call's tokens pass 60,000; a single request passes 30,000 tokens (a healthy loop stays near 12,000); or the model ignores refusals (a second over-allowance search, or a third refusal of any kind). The desk then asks the same session for the JSON in one turn. `maxTurns` is now `searches + 4` = 8. A gated loop that ends with no text throws `GatedLoopExhausted`, which is **not retried**, because a retry would pay for the whole loop again.
- **Reading** (`research/pages.ts`): the desk fetches only URLs a search returned and the draft cites, so an injected model cannot choose an address. It extracts readable text (no scripts, styles, navigation or footers) and keeps the passages that bear on the question, the claims and their figures, each with the passage on either side for context. The fixture pages were 545,621 characters; the model saw 884. Pages are cached per process, so a page cited twice is fetched once.
- **The fetch rule is tighter than before.** It is checked on every redirect hop, and checked again at connect time through a custom `lookup` that refuses non-public addresses. That closes the redirect/re-resolve gap the old note in `fetchguard.ts` and `SECURITY.md` recorded for research. The architect still uses the CLI's WebFetch, so the gap remains for it and is still documented.
- **Verify** corrects a figure the page states differently, lowers confidence where the page is silent, and drops a finding the page contradicts. It never adds a source: the numbered sources stay the search's. If the verify step fails, the unchecked draft stands, exactly as before this change.
- **Provenance**: a source whose page the desk read is `fetched`, and its `quote` is a verbatim sentence from that page when the search gave no snippet. The citation schema is unchanged.

### Model choice

Research stays on the balanced tier for all three steps (`claude-sonnet-5-5`, verified in `shared/models.ts`). The flagship is not needed here. The desk finds text and checks text against text. Deciding what a finding means for the decision is the debate seats' work, and those seats are flagship (experts, chair, referee). They receive the finding fenced. The verify step is the one place a flagship would plausibly add quality, at about 5,000 to 8,000 tokens per call; it is listed as an open question.

### Token accounting (`research/meter.ts`)

Every research call on every door has a `ResearchMeter`. It records each step (search, repair, verify; OpenAI: search, structure; Codex: search) with input, cache-write, cache-read and output tokens, the model, and the reported cost. On the Claude path it also records the model requests seen live: `sdk.ts` now reads `message_start` and `message_delta` from the stream through `onRequestUsage`. The meter logs one line per call, including calls that fail and calls served from cache:

```
[research:tokens] r_x claude: search(claude-sonnet-5-5) in=21 cw=11,069 cr=47,191 out=936 req=7 max=11,288 $0.070 | verify(claude-sonnet-5-5) in=3 cw=5,177 cr=0 out=775 req=1 max=5,955 $0.031 || total 65,172 of 80,000 tokens, 4 searches (2 refused), 2 pages (884 chars), $0.101
```

A call over budget also logs a `went OVER its budget` warning. `ResearchTokens.list(debateId)` keeps the last 50 calls per debate. `runJsonAgent` now returns `usage` on all three doors (summed across repair turns).

### Dedupe and caching

- **The same question in the same debate is answered once** (`research/index.ts`). The repeat gets the first answer under its own request id, at 0 USD and 0 tokens. A request already in flight is shared. Only `ok` answers are kept, for 6 hours, and `Engine.remove` forgets them. Before this change, the third identical ask was refused by the waste guard and logged as failed (open question 2 in `MERGE-REPORT.md`).
- Repeated queries inside one loop are refused by the gate. Pages are cached by URL.

### The other doors: checked for the same flaw

- **OpenAI** had the same flaw: the `web_search` response could search as often as the model liked, and every search's retrieved text is billed as input. Step one now sends `max_tool_calls: 4`. Both steps were already lean (question and goal; then the brief and our numbered list). Both steps are metered.
- **Codex** has no per-search hook and no tool-call cap in its SDK. The prompt now states the allowance (4 searches), the meter records the searches the thread actually made, and a warning is logged when it goes over. Its prompt was already lean. Spend on this door is the user's plan allowance, not dollars.
- **The architect** (not a research seat, but it has the same exposure) still holds WebSearch and WebFetch on the flagship with heavy thinking, and every nested search inherits that thinking. It now goes through the same gate: 4 distinct searches, 3 pages, no repeats, and the gate never ends its loop (`noStop`), because a design turn without an answer would stall the session. **Its prompt is unchanged.** No debate-seat prompt was changed. Only the research desk's own prompts changed: `researchSystem` no longer says to open pages, `researchPrompt` states the search allowance, and the new `researchVerifySystem` / `researchVerifyPrompt` were added. All of them are covered by the prompt selftest's de-seeding and fence checks.

## The budget, and the proof

**Stated budget: 80,000 tokens processed per research call** (`RESEARCH_LIMITS.tokenBudget`). This sums every step and every token kind: input, cache write, cache read and output. R1 spent 384,795 per call.

`server/src/research/cost.selftest.ts` (36 checks, in `npm run qa`) drives the real Claude adapter through a simulated CLI. The simulation does the same token accounting as the real CLI: each request re-reads the context so far, writes what is new, and adds its output. Tool results join the context at characters/4. The fixed prefix is the 4,400 tokens R1 read. Page reads come from fixture HTML.

| scenario | total tokens | cache writes | within 80,000 |
|---|---|---|---|
| R1, one research call (real) | 384,795 | 378,565 | no |
| realistic question, eager model (a repeated query, one search past the allowance) | **65,172** | 16,246 | yes |
| model that ignores refusals (the third refusal ends the loop, then one write-up turn) | 79,301 | 16,565 | yes |
| runaway: R1-scale tool results (~45,000 tokens each) and a model that ignores refusals | 113,826 | 56,589 | no: ended at the first huge result, not retried, still answered, **logged OVER budget** |

The suite also checks:
- the loop holds WebSearch only, with no thinking, on Sonnet 5.5, with 8 turns;
- searches stop at 4;
- at most 3 pages reach the verify step, each at most 4,000 characters, fenced, with a forged closing marker neutralised;
- only cited, search-returned URLs are fetched;
- the verify step's correction lands (60 becomes 62);
- a `fetched` citation's quote is verbatim from the page;
- the repeat question costs 0 and makes no model call;
- a second question citing the same pages fetches nothing new;
- the debate's usage ledger agrees with the meter;
- the page fetch rule refuses a redirect to loopback, a redirect to a name that resolves privately, and a redirect loop;
- the connect-time lookup refuses `localhost`.

## Verification (all in this worktree)

| check | result |
|---|---|
| `npm install` | ok |
| `npm run typecheck` | clean (server and web) |
| `npm run build` | ok |
| `npm run qa` | every suite passed: research contract 95/0 (was 81: new checks for the gate, no thinking, the stated allowance, `max_tool_calls`, cache on every door, metering on every door), research cost 36/0 (new), runner 102/0, prompts, OpenAI, Codex, director, mock-v2, trailer, lint, realism, budget 69/0, notify 60/0, friendly, web reducer, attention view, metrics, doctor, eval golden, design 197/0 |
| `npm run security-test` | 114 passed, 0 failed (was 109; +5 in part E: the desk's page reader refuses loopback, link-local and `[::1]` without making a request, does not follow a public-to-loopback redirect, and the research desk holds WebSearch only behind its gate) |
| MOCK=1 debate | server on port 8842 (`MOCK_SPEED=10`, autonomous, `CHROME_PATH=none`, throwaway data folder): reached `complete` in 16 s with `research_done` and `report_ready`. Server stopped, port 8842 free, driver script deleted. |

Note on `CHROME_PATH=none`: this session's sandbox refused an inline environment assignment for `npm run qa`. Plain `npm run qa` found no Chrome on this machine (PDF export was logged as skipped), which is the condition `CHROME_PATH=none` sets up. The MOCK run did pass `CHROME_PATH=none`.

One test fix that is not a behaviour change: `runner.selftest` [2c] depends on research landing before the chair's first steer, which is a microtask race. The page-reading step added awaits even when scripted agents are wired, and that lost the race. The adapter now skips the read step synchronously when no page can be read (`pagesOffline()`), and the test passes as before. The race itself was already in the test.

## Files

- new: `server/src/research/meter.ts` (limits, meter, ledger, gate), `server/src/research/pages.ts` (guarded fetch, extraction, page cache), `server/src/research/cost.selftest.ts`
- `server/src/agents/sdk.ts`: `webTools`, `toolGate` (PreToolUse hook, deny and stop), `onRequestUsage`, `GatedLoopExhausted` (not retried), `usage` on JSON turns, `agentsAreFake()` keeps the page reader offline under test seams
- `server/src/agents/openai.ts`: `openaiMaxToolCalls` sent as `max_tool_calls`; JSON turns return `usage`
- `server/src/agents/codex.ts`: JSON turns return `usage`
- `server/src/research/{claude,openai,codex,index}.ts`, `server/src/agents/prompts.ts` (research desk prompts only), `server/src/engine/runner.ts` (research allowance from `RESEARCH_LIMITS`, the architect's gate, `forgetResearch` on delete)
- tests: `contract.selftest.ts`, `prompts.selftest.ts`, `security-test.mts`; `server/package.json` qa line
- docs: README, ARCHITECTURE, SECURITY, this report

## Open questions

1. **R2 probe, before the next real run.** Run one research call and read its `[research:tokens]` line. Check three things. (a) `req=` and `max=` should stay near the fixture's (7 requests, about 11,000 at most). (b) The CLI's `total_cost_usd` should be in line with its `usage`. R1's 3.97 USD over 384,795 tokens is high for Sonnet-class rates, which suggests the nested WebSearch requests are billed in `total_cost_usd` but not reported in `usage`. If so, the budget should be measured on cost as well. (c) OpenAI should accept `max_tool_calls` on `gpt-6.1-sol` (it could not be verified offline).
2. **Budget number.** 80,000 tokens per call is an engineering envelope with about 20% headroom over the realistic fixture. The tripwires (60,000 total, 30,000 per request) end runaways; they do not trim normal calls. If the owner prefers a looser envelope under "quality over cost", raise `tokenBudget` and `tripwire` together in one place (`RESEARCH_LIMITS`).
3. **Verify on the flagship?** The verify step compares text with text on Sonnet 5.5. Moving only that step to Opus 5.5 would cost about 5,000 to 8,000 flagship tokens per call. My call is that it is not needed; an eval-kit comparison would settle it.
4. **No mid-loop page reading.** The model can no longer open a page during the search to follow a lead; it reads cited pages only afterwards. This is a deliberate trade for bounded context, and it also removes the CLI's fetch from the research path. An eval on real questions should confirm it costs nothing in answer quality.
5. **The architect still holds WebFetch** on the flagship with heavy thinking. It is now bounded but still exposed (`SECURITY-AUDIT-2.md` finding 2 recommends removing its web tools and sending its questions through the desk). That would move its research onto the lean path described here.
6. **Codex has no hard search cap.** Only the prompt and the meter hold it. If the R2 probe shows the thread over-searching, the only lever left is aborting the thread on the fifth `web_search` item, which would lose that answer.
