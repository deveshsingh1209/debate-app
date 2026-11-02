# Baselines report: sourced human-conversation targets

**Date:** 2026-10-26
**Branch:** `wt/baselines`
**Brief:** replace the realism index's target bands, which were written from memory, with sourced human-conversation ranges. Document them in `docs/HUMAN-BASELINES.md`, and change the bands only in the existing constants (`REALISM_TARGETS` in `scripts/transcript-metrics.ts`), with citations in comments.

## Result

- **`docs/HUMAN-BASELINES.md`** covers every metric the realism index scores. For each one it gives the sourced range, how the published unit was converted to this script's unit, a confidence, and a plain note where the evidence is thin. It has 42 references, keyed to the code comments.
- **`REALISM_TARGETS`** has new bands for 13 of the 25 scored metrics and cited comments on all 25. No other code changed. Weights did not change. Scales changed only where a band's width changed a lot: overlap, question share, position change, filler and summary endings.
- Gates are green: typecheck pass; build pass; `npm run qa` pass, including the metrics self-test; `npm run security-test` 78/0.
- Fixtures: the baseline-like fixture scores 39.3 (was 30.4) and the target-like one 86.4 (was 79.0). The self-test's gap check still holds.

## Bands that moved, and why

| Metric | Old → new | Why |
|---|---|---|
| wordsCv | ≥ 0.8 → 1.0-1.7 | Every human source has CV ≥ 1.0: Switchboard 1.53, BNC ~1.58, deliberation 1.02. |
| wordsP90 | ≥ 120 → ≥ 40 | No meeting source supports a long-turn floor that high. |
| shortTurnShare | 30-50% → 40-90% | Meetings have 80-94% of turns under 30-40 words. |
| interruptionRate | 8-20 → 3-11 /100 | 10.6 per 100 transitions counting every attempt; 2.9 by strict coding. |
| overlapRate | 5-12 → 5-29 /100 | Turn-onset overlap in small groups is about 26-29 per 100. The low end is an assumption. |
| pingPongRate | 15-35% → 20-50% | No human data. The new band is the chance rate for 3-6 experts; the old one sat below chance. |
| questionShare | ≥ 25% → 8-25% | 8% of deliberation turns hold a genuine question; per-DA rates convert to at most 18-23% of turns. |
| concessionPer100 | 5-12 → 0.5-12 | The lower bound had no support. |
| positionChangePer100 | 3-8 → 0-2 | ChangeMyView, a forum built for it, runs about 0.8 per 100 turns. Experts rarely reverse out loud. |
| fillerTurnShare | ≤ 1% → ≤ 5% | The old band was stricter than real speech; humans thank and appreciate in about 3-5% of turns. |
| summaryEndingShare | ≤ 5% → ≤ 2% | Summaries are 0.1-0.7% of units in the corpora. |
| giniTurns | 0.25-0.45 → 0.15-0.45 | Small groups measure about 0.19-0.46. |
| chairWordShare | 5-12% → 8-20% | Moderators take 9-32% of talk time; a facilitator takes about 16% of thoughts. |

These stay **assumptions**, with no human analogue or no data found:
- multiParagraphShare, emDashPer1k, openerRepeatShare and recycled4gramShare;
- the five prompt-born tics;
- the low end of overlapRate;
- all of pingPongRate.

## Method

- Four parallel research passes used WebSearch and WebFetch, read-only, with no logins. They covered turn length, floor dynamics, participation and address, and concession and repetition.
- I then reopened the load-bearing sources and checked the numbers myself: MRDA Tables 3-4, Smith-Lovin & Brody pp. 429-430, CANDOR Table 1, Stromer-Galley 2007 pp. 12-15, and Fay et al. Fig. 1.
- Numbers seen only in search snippets are listed as unverified and set no band. That covers Kalven & Zeisel, the Opus em-dash figure, an AMI turn duration, and the Wikipedia "40-50% top talker" claim.

## Rules kept

- No live model calls, no debates and no quota use.
- No server was started, so port 8823 was not used.
- No MCP, no push and no global config changes.
- The main checkout and other worktrees were not touched. That is why the imported corpus (which lives in the main checkout's `data/`) was not re-scored under the new bands.

## Open questions for the owner

1. **Hot-seat sessions.** The question band now tops out at 25%. The session the plan judged most real (experts grilling the founder, 30% questions) scores 0.67 on that part. Is a cross-examination the target, or a meeting?
2. **Position changes.** The data says 0-2 per 100 turns, against the plan's 3-8. Accept the sourced band, which means fewer, costlier mind-changes, or keep a more theatrical target on purpose?
3. **Chair share.** The data puts a normal facilitator at 8-20%, so the engine's 17% is not an outlier. The plan's goal of a much quieter chair is now a style choice, not realism. Keep it?
4. **Interrupt caps.** At 3/4/6 per motion, short motions of about 20 turns would read 15-30 interruptions per 100, above the sourced 3-11. Scale the cap by motion length when 2b-7 wires the director?
5. **Calibrate on a real corpus.** The biggest remaining gap: running this script on the AMI or ICSI meeting transcripts (openly licensed) would replace most of the conversions and give the first real A-B-A number. It needs a corpus download and a small adapter. Approve as a follow-up task?
6. **Re-score the imported corpus** under the new bands, from the main checkout (read-only), so the plan's 35.5 baseline index can be restated.
