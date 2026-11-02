# ENVELOPE-REPORT (plan P3b: the research token envelope stopped searches)

Branch `wt/envelope` from `d3c7b3b`. Offline only: no live model calls, no real debate. Research still runs only on the setup the user chose.

## What went wrong on 1 Nov 2026 (debate d_ntnoWyeC)

From `[research:tokens]` in the server log and the events in `debate.db`:

1. **4 of 10 research calls never searched.** The search session's first request, before any search, was already 49,267-49,312 tokens (`r_M1IklBTP`, `r_dWDRpttf`, `r_ZnsNbefK`, and the gap round of `r_U0v-RRql`). The envelope stopped any request that started above 30,000 tokens. The room was told "The search returned no sources for this question", which was false: no search had run.
2. **The two "over budget" totals were inflated by a counting bug.** A request stopped as it started was recorded once at its start and again at its end (`req=2 cr=94,544` is one ~49,400-token request counted twice). The real totals were about 72,000 (`r_U0v-RRql`, logged 121,042) and 168,000 (`r_iT8DRJB6`, logged 217,334).
3. **The heavy write step (54,923 tokens) did not carry a raw result.** It read the same ~46,000-token block from cache (`cr=46,245`), plus ~8,700 tokens of the desk's own text.

## Where the ~47,000 tokens came from

The block is not research, and not the WebSearch tool:
- It appears in **37 of 385 agent sessions** of the run, across every seat: floor turns, the referee, the chair, dossiers, research write-ups and the report. Most of those seats hold **no tools at all** (`tools: []`).
- It is a **cached prefix shared by sessions with different system prompts** (`cr=46,245` on Marcus, Arjun, Kavya, the referee and the write-up alike). The API caches tools, then system, then messages, so a prefix shared across different system prompts must sit in the **tool definitions**.
- Its size is fixed per tool set: 46,245 tokens on tool-free sessions and 47,272 on WebSearch sessions (about 1,000 more, the size of the WebSearch definition).
- It shows up **on some sessions and not others** with identical options. That fits tools fetched in the background that may or may not be ready when the first request goes out.

The app sets `settingSources: []`, which keeps settings files and CLAUDE.md out but **does not stop the CLI loading MCP servers**. The bundled CLI source has a "claude.ai MCP connectors" fetch (`tengu_claudeai_mcp_connectors`, 5,000 ms timeout) gated by `ENABLE_CLAUDEAI_MCP_SERVERS`. On a Claude sign-in, the account's claude.ai connectors (and any user-scope MCP servers) are the most likely source.

**Not proven.** The installed native CLI could not be inspected, and reproducing the block would need the live account. A live check is still owed: one research call and its `[research:tokens]` line, which now warns whenever the CLI's prefix is above 12,000 tokens.

## What changed

1. **No MCP server of the user's in any agent** (`agents/sdk.ts`): `strictMcpConfig: true`, `mcpServers: {}`, and `ENABLE_CLAUDEAI_MCP_SERVERS=false` in the child environment. This stays within the Claude Code CLI and the user's own setup. It is also a security fix: a persona described as "holding no tools" was sometimes handed the account's connector tools. Under `dontAsk` those calls would have been denied, but the definitions were still in its context. The security test and the doors selftest now check this.
2. **The envelope measures what research adds** (`research/meter.ts`, `research/claude.ts`):
   - Each session is calibrated on its first request: baseline = that request less the desk's own text (system + prompt at 3 characters a token, an overestimate). Only growth above the baseline, plus output, counts.
   - A first request never stops a session, and nothing stops a session before its search has been let through. The gate never refuses a call's first search.
   - The 30,000 trigger is now one request's growth over its session's first request. The 60,000 tripwire, the gap reserve and the 80,000 budget all apply to tokens research added.
   - The baseline is never hidden. It is logged per step (`base=`), and the total line reads `research added X of 80,000 tokens (total Y, fixed baseline Z)`. A warning fires when the CLI prefix is above 12,000 tokens.
   - A request is counted once: `requestStart` records it as billed, and `requestEnd` replaces that record.
3. **Never a silent empty** (`research/claude.ts`, `engine/transcript.ts`):
   - When a call has no search result, it now says so: "Research incomplete: no search result came back (why). Nothing was found, so this question is still open." It has status `partial`. The room adds "Treat any figure offered for it as assumed."
   - An answer the search session wrote from memory without searching is no longer passed on as the summary.
   - The report writer sees such briefs marked "research incomplete … any figure for it is assumed".
   - "The search returned no sources" is now said only when a search ran and came back empty.
4. **Write-up cap** (`writeInput` in `research/claude.ts`): the write-up's own text is held to 36,000 characters (~10,000 tokens). Excerpts shrink first, then any draft, then the notes, then the last-ranked sources. A raw search result is ~145,000 characters.
5. **The recall step** is calibrated the same way.

## Tests

`research/cost.selftest.ts` section [9] uses the 1 Nov log lines as fixtures. The simulator puts the measured block (46,880 tokens, from the stopped first requests less the small ones) on every session, the worst case. Its first search request is 48,908 tokens, against 49,285 real.

**Run on the previous code** (old `meter.ts`, `claude.ts`, `index.ts`, `sdk.ts`), it fails as the live run did:
- every call stopped at "a search request started at 48,809 tokens" and answered "The search returned no sources";
- a stopped request was metered as 3 requests against 2 billed;
- an unsearched call returned a summary written from memory;
- the run then crashed on the new meter API.

**Now** all 87 checks pass:
- every call searches and answers, inside its envelope (research added 3,657-8,075 tokens);
- the gap round still runs;
- a stopped request is counted once;
- the unsearched call says "Research incomplete";
- every write-up is at most 36,000 characters, including a hostile case: a 145,000-character draft plus 16 full pages comes out at 26,089.

Sections [0]-[8] are unchanged and pass.

| Check | Result |
|---|---|
| npm run typecheck | pass |
| npm run build | pass |
| npm run qa | pass (cost selftest 87/0, contract 96/0, doors 116/0, all suites) |
| npx tsx scripts/doctor.selftest.ts | ok |
| npm run security-test | 254 passed, 0 failed (253 before, plus the new MCP check) |
| E2E_PORT=8922 npm run e2e | **not run**: the command needed a permission approval that this autonomous session could not give. No web code changed, and the mock engine does not use the changed CLI options; still, run it before merging. |

## Expected cost per research call, restated

All figures are list-price equivalents from the simulator's fitted Sonnet rates (cache write $7.0/M, cache read $0.56/M, output $27/M).

| Case | Tokens (total) | Research added | Cost |
|---|---|---|---|
| Plain call, CLI prefix ~1,700 (no block) | ~7,000 | ~3,700 | **$0.12** (unchanged) |
| Call with the gap round, no block | ~14,000 | ~8,000 | **$0.24** |
| Plain call, block on every session, cache warm | ~100,000 | ~3,700 | **$0.17** |
| Gap call, block on every session, cache warm | ~200,000 | ~8,000 | **$0.34** |
| Each time the block is written to a cold cache | +46,900 | 0 | **+$0.30** |

The earlier "$0.12 a call" was too low as a general figure:
- On 1 Nov, 2 of the 4 calls that searched used the gap round and cost $0.23 and $0.28 for real. Those calls had no block, which matches the $0.24 above.
- With the block, every request also pays about $0.026 to read it from cache. It pays about $0.30 more when it has to be written, for example on the first research call after a quiet five minutes.
- A realistic average is **about $0.15-0.25 a call** if the MCP fix removes the block, and **about $0.20-0.40** if it does not.
- The 80,000 envelope now holds research only, so the block can no longer stop a call. Its cost still counts in the total and the spend meter.

## Not done / open

- **Live proof** that `strictMcpConfig` and `ENABLE_CLAUDEAI_MCP_SERVERS=false` remove the block on the installed CLI. Check that `base=` drops to ~1,400 and the prefix warning stops. The same block cost the rest of the debate too: the chair's and experts' turns carried it on about 10% of sessions.
- A call stopped with no result still counts toward the session's research allowance (`researchCap`). On 1 Nov two of the six counted requests came back empty (the other two empty calls were the architect's landscape and a gap round), and the allowance then refused seven later questions. This is left unchanged here.
- `E2E_PORT=8922 npm run e2e` was not run (see the table above).
- The OpenAI and Codex paths are unchanged: no baseline is measured there, and every token counts as added, as before.
