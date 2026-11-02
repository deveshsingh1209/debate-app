# COST-REPORT (plan P3: research cost)

Branch `wt/cost` from `d38cf0b`. Offline only; no live model calls. Research still runs on the setup the user chose.

## Problem
In the real run of 2026-10-28, research calls cost about $1.3-1.4 each (list-price equivalent) and carried 161k-304k tokens, because a raw web-search result (one result was 145,176 characters) was fed straight into the model, often more than once.

## What changed
- The search step runs on Sonnet 5.5 with WebSearch only, one search by default, no thinking, at most three turns. One extra search is allowed only on an explicitly named gap, and never again after that.
- Search results reach the write-up step trimmed to 1,500 characters and fenced; at most three pages, only from the search's own results.
- A separate write-up step works from the trimmed notes; there is no extra verify pass.
- A token envelope stops the call as an oversized request begins, and the desk answers from what it already has.
- Reuse: an identical question is answered from the earlier answer (0 tokens); related questions draw on research the debate already has.
- Every call logs tokens and cost per step, plus the running debate total.

## Expected cost (offline simulator calibrated on the real run: reproduces all six real search steps within 10%)
- A typical research call: about 7,000 tokens and $0.12, against $1.44 per call on 28 Oct (about 12x less).
- With the one allowed gap search: about 14,000 tokens and $0.24.
- A repeated question: 0 tokens.
- Worst case when the CLI ignores a stop: about 45,000 tokens, still inside the 80,000 envelope.

## Tests (run independently by the maintainer)
- typecheck, build: pass
- npm run qa: pass (incl. the rewritten cost selftest)
- npm run security-test: 253 passed, 0 failed
- npm run e2e (E2E_PORT=8915): 31 passed. The browser-test origin fix from wt/evidence was applied here too; without it, the suite fails on any non-default port on main as well.

## Not yet verified
- Real cost in a live debate (plan P5). The figures above are simulated.
- The OpenAI and Codex research paths were not changed in this branch beyond shared plumbing.

## Note
The build agent exited without committing or writing this report; the maintainer ran the browser suite, wrote this report and committed the work.

## Also fixed
- scripts/doctor.selftest.ts expected the old non-isolated `claude auth status` probe and had been failing on main since de0fcc2; it is not part of `npm run qa`, so the failure went unnoticed. It now matches the isolated check and passes.
