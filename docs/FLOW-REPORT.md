# Flow report: session length (P2) and pause/resume (P4)

**Date:** 2026-11-01
**Branch / worktree:** `wt/flow` in `debate-wt-flow`, from `main` at `d38cf0b`.
**Brief:** make the Quick, Standard and Deep profiles real (round and message budgets per motion and per session that the floor director and referee respect; Quick about 40-60 messages for a 1-2 motion debate; Deep may still run long), and make a founder pause never close or advance a motion, with Resume returning to the exact step.
**Result:** done and proven offline. No live model call, no real debate. Every server ran on port 8903 and was stopped afterwards. Nothing was pushed.

## Commits

| Commit | What |
|---|---|
| `e9a917a` | Two stale tests fixed (below) |
| `fbb68c7` | P2 and P4 in the engine, and `engine/flow.selftest.ts` |
| (this commit) | Docs: this report, ARCHITECTURE, REFERENCE, PROGRESS, CHANGELOG |

## What the real run showed

From `_backups/real-completed-20261028/debate.db` (debate `d_R8dL2LGj`, Quick) and the server log:

- **Length.** Scope said 3 rounds a motion, but `minRounds` was only a floor. The close rule needed two dry checkpoints (or "ready") and the referee kept reporting new arguments (7, 12, 9, 7, 8, 6, 5, 5, 3), so motion 1 ran 9 checkpoints and the only real stops were the deep-sized backstops (16 rounds, 110 messages). 145 messages in the session (62 expert turns, 44 reactions, 27 chair lines, 6 desk lines, 3 closings).
- **Pause.** Pause set the status to `paused`; the motion engine reads any non-`meeting` status as "stopped". In `adversaryChallenge` a stop returned the ruling under attack as final, and `runMotion` then cleared the checkpoint, published `motion_closed` and the runner added the motion to `closedMotions` (seq 232 decision, 234 paused, 239 `motion_closed` while paused). Resume found motion 1 closed and opened motion 2.

## P2: what changed

- `shared/budget.ts`: each profile has a `length` (`LengthSpec`): round target cap, round cap, messages per motion, messages per session, a per-motion minimum, the rung needed to close on the merits, and whether one checkpoint with no new substance closes the motion.

  | | target | cap | per motion | per session | close past target |
  |---|---|---|---|---|---|
  | Quick | 2 | 3 | 34 | 60 | settled, or one checkpoint circling / exhausted / nothing new |
  | Standard | 3 | 5 | 70 | 220 | same |
  | Deep | (scope) | 16 | 110 | 900 | as before: two dry checkpoints, or settled |

- `motionAllowance`: a motion's floor budget is the smaller of its per-motion budget and its share of what is left of the session after reserving the closings and an adversary round for each open motion, never below the minimum (12 on Quick), so a motion the chair adds mid-session still gets a real floor. Counted from the event log, so restarts and pauses cannot lose track.
- Floor director (`floor.ts`): a checkpoint is asked only for the turns that fit (`checkpointTurns`) and stops at its `maxMessages`; the next turn is not prefetched past the budget.
- Referee rule (`motions.ts`): on Quick and Standard, past the target, `ready_to_decide` or no new substance closes the motion (`merits`, or `stuck` below the rung); at the round cap or with under 4 messages left it is ruled with the existing `budget` reason, which tells the ruling the argument was stopped, not finished. Deep and debates from before profiles keep the old rules and backstops exactly.
- `scope.ts`: the intake's depth read can no longer push a Quick or Standard round target past the profile's.
- Kept: the waste guards (stale-turn stalemate, identical-call guard), the founder's ceiling and the quota pause; nothing here reads money.

## P4: what changed

- **Pause anywhere.** `pause()` works in every status before the report is done (it was meeting only; the UI already showed the button everywhere). `meta.founderPause.resumeTo` holds the step; `setStatus` records where a running step would go next instead of entering it; the driver waits on a resume gate, not on the user-signal queue (a `resume` signal could previously be swallowed by a pending question). Answers and approvals given while paused are kept. A pause survives a restart. End while paused cancels before the meeting and goes to the closings after it. A quota limit landing during a founder pause takes it over, returning to the same step.
- **The motion is a persisted step machine** (`MotionState`): `open` (a started checkpoint, with turns owed and its message budget), `pressure`, `closing`, `ruling`, `challenge` (the defeaters and the adversary round's progress) and `redTeamed`. A pause returns `null` from `runMotion` at whatever step it is on; the checkpoint is never cleared and `motion_closed` is only published once the final ruling exists and the session is running. The adversary desk is not sent in twice; the adversary round resumes with the turns it still owes, then the re-ruling.
- **In-flight turns.** A turn being written when Pause is pressed is dropped unheard. A turn already written and planned is no longer performed into a paused room: it stays in the checkpoint and plays first on Resume with no new model call (the existing restart path).
- **Wrap-up** stops between closing statements; **reporting** stops between the audit, the writer, its adversary and the correction (`meta.reportProgress`), so no part is paid for twice.

## Tests

New `server/src/engine/flow.selftest.ts` (in `npm run qa`), a real `DebateRun` on scripted models, 196 checks:

- **Length replay.** The referee replays the real run's nine judgments (fresh count, rung, circling/exhausted from the round notes); the fake room reacts at about the real run's density. Spoken messages in total, closings included:

  | Run | Messages | Real run |
  |---|---|---|
  | Quick, one motion | **52** (3 checkpoints, adversary round, re-ruling, closings, report) | 145 |
  | Quick, two motions (chair adds one at the first check-in, as in the real run) | **55**, both motions argued and ruled | |
  | Standard | 85 | |
  | Deep | 127 (9 checkpoints: still long) | |

- **Pause at every phase**, then Resume: intake, panel design, planning, position cards, a floor turn, the chair's check-in, the referee, the ruling, the adversary desk, the adversary round, the re-ruling, wrap-up, the report writer, the report's adversary. Each asserts: the room publishes nothing while paused, no motion opened or closed and no status moved while paused, Resume goes back to the step, the motion checkpoint is kept (ruling, `redTeamed` and defeaters in the adversary case), the session completes with **the same motions, checkpoints, rulings, adversary hold and closings as an unpaused session**, the statuses run once in order, no finished step (intake, architect, plan, adversary, report, closings) and no referee pass is paid for twice; mid-checkpoint the same checkpoint resumes, the turn being written is never heard, and a written turn plays first after Resume; in the adversary round all four turns are heard before the re-ruling and the motion closes after it.
- Also: pause survives a restart; End while paused writes it up; approving while paused waits for Resume; double pause and pausing a finished debate are refused.

Two stale tests were fixed, neither weakened: `scripts/doctor.selftest.ts` faked `claude auth status` but since `de0fcc2` the probe runs `claude --setting-sources= auth status` (it failed on `main`); `e2e/01-connect.spec.ts` hard-coded port 8871 for the clipboard grant and an Origin header, so it failed whenever `E2E_PORT` moved the server.

## Gates (final tree)

| Gate | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `npm run qa` | pass, exit 0 (engine test 157/157 unchanged, flow 196/196, budget 69, mock-live 24, doors 115, ...) |
| `npm run security-test` | **252 passed, 0 failed** (`SECURITY_TEST_PORT=8903`) |
| `npm run e2e` | **31 passed** (`E2E_PORT=8903`) |

The port was set through a small uncommitted wrapper in `.scratch/`. The first e2e run (16 failed, 7 did not run) was the port-8871 clipboard grant above; after the fix all 31 passed.

## Unverified and open

1. **No real model has run this.** The 40-60 figure comes from a replay with scripted speech; real turns and reactions run longer or shorter, and the per-turn estimate (1.7 messages) is a guess. P5 (one real Quick debate) is the proof.
2. **A Quick session can exceed 60** by a few messages: the closings and the adversary round are reserved as estimates, and a motion always gets its minimum floor (12), so a chair who adds several motions to a Quick room will overrun. Nothing cuts a motion to hold the number.
3. **Quick usually ends on `budget`** when the referee keeps finding new argument (as it did for checkpoints 1-3 of the real run). The ruling is told the argument was stopped, not finished. Whether founders prefer that to one more checkpoint is a product call.
4. **"Settled" still waits for the round target** (2 on Quick, 3 on Standard) so the existing "at least N rounds" promise and test hold.
5. **Pausing mid-step finishes the in-flight call**, and pre-meeting steps (intake, panel design with its dossiers, planning) run to their end before the room waits; only the planning step stops between the research briefs and the plan.
6. **A restart (not a pause) in the middle of a checkpoint** may run up to the checkpoint's full turn count again, as before: the spoken count is saved when the floor returns, not per turn.
7. The MOCK scripted player (`MOCK_ENGINE=scripted`, `mock.ts`) keeps its own old pause.
