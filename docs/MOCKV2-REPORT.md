# Mock engine v2 (plan 5.2)

Branch `wt/mockv2`. `MOCK=1` / `npm run demo` now plays a scripted, seeded debate that shows the Phase 2b realism behaviours with no model calls.

## What shipped

- `server/src/engine/mock-v2.ts`: `compileScenario` (pure: scenario + seed + provider gives a list of steps) and `playScenario` (sleeps, publishes events, writes the database). The real `FloorDirector` decides cut points and floor fights, so heat, hands-up and chair triggers are the engine's own, not faked.
- `server/src/engine/mock-scenarios.ts`: content.
  - `pricing` ("The Seat Price Problem"): Halyard, a $29/seat CI tool. Three voices: Priya Raman (CFO, clipped), Tomas Ferreira (growth, storyteller), Adaeze Okafor (VP Customer Success, combative). About 2 minutes at normal speed.
  - `library` ("Sundays or Makers"): shorter, about 1 minute.
  - All names, firms and sources are fictional (`.example` URLs).
- `server/src/engine/mock.ts`: minimal edit. A few fields made public and a branch at the top of `run()`. `MOCK_SCENARIO=legacy` runs the original script untouched.
- `server/src/engine/mock-v2.selftest.ts`, added to the `qa` chain.
- README: `MOCK_SCENARIO`, `MOCK_SEED`, `MOCK_SPEED`.

## Behaviours shown (pricing)

| Behaviour | Where |
| --- | --- |
| Overlapping speakers, cut-offs | Tomas cut by Adaeze (speaker resumes); Adaeze cut by Tomas (interrupter takes). Both floor-fight branches covered. |
| Short reactions, pauses | Reactions from Adaeze, Priya and Tomas; pauses after concessions and tension. |
| Asides (hidden) | Priya to Adaeze, Adaeze to Tomas. Own event type; never in messages or transcript. |
| Heat rising | `floor` events; Tomas reaches 0.91. |
| Caused concession | Priya moves on evidence from the research desk (cites the source by id). |
| Unexplained concession | Tomas folds to a hybrid; the chair asks why and he explains. |
| Budget meter, quota pause | Info-only meter (no caps or wind-down since the wt/budget merge); a simulated limit pause then resume to `meeting`. |
| Research with citations | `research_done` carries the provider-neutral result: Claude (fetched + quotes), OpenAI (search results, no quote), Codex (model-reported). |
| Stakes, dissent | Stakes block in the room at intake; decision carries Adaeze's dissent with a tripwire. |

## Determinism

Same seed gives byte-identical steps; a different seed differs (tested). Message ids are `m_<scenario>_<n>`. Default seed has no declined cuts on either scenario, any provider (checked on several seeds too).

## Verification

`npm run typecheck`, `npm run build`, `npm run qa` (includes the new selftest) and `npm run security-test` (78/78) pass. The selftest also runs both scenarios end to end through `MockEngine` to `complete` and checks the legacy script still reaches the meeting. A live `MOCK=1` server on port 8827 was driven through intake to `complete` over HTTP (109 events, report served), then stopped.

## Open questions

1. **No typed `stakes` event.** The stakes block is a `system` event starting with `STAKES`. Should realism add a `stakes` event so the UI can render it as a card?
2. **Mock is not a realism gate.** The scripted content is hand-tuned to trigger the director; it proves the UI and event plumbing, not that live models produce this behaviour.
3. **Report is a placeholder.** The mock still writes a stub `report.html`, as the legacy script did.
4. **Pacing.** About 2 minutes for `pricing` at speed 1, not 3. Longer is easy (more beats) if you want it.
5. **Coupling.** `mock.ts` now exposes several fields publicly; if `runner.ts` work reshapes the `MockHost` needs, the interface in `mock-v2.ts` is the one place to adjust.
