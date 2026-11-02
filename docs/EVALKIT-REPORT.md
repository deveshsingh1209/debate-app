# Evaluation kit report (branch wt/evalkit)

Runs on any saved debate: an event-log `.json`, a `transcript.md`, or a debate id
(looked up in `data/debate.db`, then `data/debates/<id>/transcript.md`). No model
call is ever made by the kit.

## What was added (new files only, plus two one-line script entries)

| File | Purpose |
|---|---|
| `docs/RUBRIC.md` | 13 criteria in three groups (realism A1-A5, substance B1-B5, fairness C1-C3), each with anchored 1-5 descriptions, judge rules, and a table pairing each criterion with its offline proxy. |
| `scripts/eval/eval-lib.ts` | Loader, substance signals, judge prompt and JSON schema, judge-output checker, model-call gate, evaluation renderer, old-vs-new comparison. |
| `scripts/eval/eval.ts` | The CLI. |
| `scripts/eval/eval.selftest.ts` | 15 self-tests, wired into `npm run qa`. |
| `scripts/fixtures/eval-golden.json` | Golden snapshot of metrics and signals for the two committed fixtures. |
| `package.json`, `server/package.json` | `npm run eval`; the self-test appended to `qa`. |

Engine files, `runner.ts`, `prompts.ts` and `scripts/transcript-metrics.ts` are untouched. The kit imports the existing metrics and realism index from `scripts/transcript-metrics.ts` (the realism index lives there, not in `shared/realism.ts`, which holds only types).

## Usage

```
npm run eval -- <debate-id|path>                 # metrics, weakest realism parts, substance and fairness signals
npm run eval -- <ref> --json                     # same, as JSON
npm run eval -- <ref> --judge                    # prints the judge prompt (rubric, metrics, panel, rulings, transcript, schema)
npm run eval -- --schema                         # prints the judge answer JSON schema
npm run eval -- --check answer.json              # validates a judge's answer (all 13 ids, scores 1-5/null, quote above 3)
npm run eval -- --compare <old> <new> [--out f]  # markdown comparison
npm run eval -- <ref> --judge-with               # refuses (exit 3)
```

`--judge-with` exits 3 without `EVAL_ALLOW_MODEL_CALLS=1` and says it would use quota. With the variable set it still sends nothing: no model client exists in the kit, by design. Wiring one in is a separate, deliberate change.

## Comparison verdicts

`improved` (index up by more than 1, no guard fell more than 10%), `regressed`, `mixed` (index up but a decision-quality guard fell: "do not ship on the index alone"), `unchanged`. Guards come from the existing `guardFalls`.

## Substance signals (proxies, labelled as such)

Rulings with an owner and a stop/revisit cue, evidence-grade mix, dissents and whether they carry reasoning, undecidable questions, graded claims per grade, figure-bearing turns and how many sit next to a derivation cue, compute events, citation/tag count, silent seats. These are regex proxies. They cannot judge truth; B1, B2 and B3 need the model or human judge.

## Verification

- `npm run typecheck`, `npm run build`, `npm run qa` (including the 15 new tests), `npm run security-test` (78 passed): all green.
- A `MOCK=1` debate on port 8826 (temp data dir, autonomous, quick) reached `complete`. `npm run eval -- <id>` ran on it from the DB, `--judge` produced a ~16 KB prompt, and `--compare` against the baseline fixture gave a `mixed` verdict, as expected (the mock has no rulings, so the guards fall). The server was stopped and the temp data deleted.

## Known limits

- Golden numbers are for two synthetic fixtures. Re-bless with `npx tsx scripts/eval/eval.selftest.ts --update-golden` after an intentional metric change, and review the diff.
- The realism target bands are inherited from `transcript-metrics.ts` and are uncalibrated on real runs.
- The judge prompt truncates the transcript at 120,000 characters and tells the judge to use null where it cannot see.
- A `transcript.md` carries no rulings or guards, so B4/B5 and guard comparison are unavailable for it.
- Substance proxies read English only.

## Open questions

1. Which model should judge, and who sets the quota for it? The kit stops at the prompt.
2. Should judge runs be repeated (3x, median) per side before a ship decision? The rubric allows it; nothing enforces it.
3. Should a real-run calibration pass replace the inherited realism target bands once there are several real debates?
