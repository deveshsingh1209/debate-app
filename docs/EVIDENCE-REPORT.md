# EVIDENCE-REPORT (plan P1: evidence honesty)

Branch `wt/evidence` from `d38cf0b`. Offline only; no live model calls.

## Problem
In the real run of 2026-10-28 (d_R8dL2LGj), fictional expert personas tagged invented personal experience as `[observed]` ("my head baker quit after eight weeks", "my busiest Bristol counter never sees 360 asks"), and the referee and report treated those claims as evidence about the founder's business.

## What changed
- A new `persona` evidence grade for a panelist's own backstory.
- `observed` is reserved for facts the founder supplied (brief, answers, uploads) or research findings cited by id. A deterministic server-side check (server/src/realism/evidence.ts) regrades any other `observed` claim before it is shown or used.
- Prompts for floor, closing, referee, ruling, report and numbers audit state that persona backstory is illustrative, never evidence.
- The realism lint flags first-person anecdote told as fact (recorded, not rewritten).
- Report: a "Panel Anecdotes, Not Evidence" section; decision trails and numbers-audit rows that rest on a persona claim are labelled as assumptions.
- Eval kit: `npm run eval -- <run> --evidence` re-grades a saved run and lists every claim moved.

## Result on the real 2026-10-28 transcript
17 claims graded `[observed]` before; 0 after (13 regraded to persona, 4 to assumed).

## Tests (run independently by the maintainer)
- typecheck, build: pass
- npm run qa: pass (incl. new evidence selftest)
- npm run security-test: 252 passed, 0 failed
- npm run e2e (E2E_PORT=8911): 31 passed (3.2m)

## Not yet verified
- Behaviour in a live debate (prompt changes need a real run; plan P5).
- Whether models comply with the new prompt wording; the server-side regrade is the safety net.

## Note
The build agent exited before finishing its browser run and this report; the maintainer completed the browser run and wrote this report. The one browser-test edit replaces a hard-coded origin with the configured base URL so the suite can run on another port; no assertion was weakened.
