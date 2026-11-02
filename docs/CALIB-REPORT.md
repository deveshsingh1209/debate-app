# CALIB report: calibrating the realism metrics on real meetings

**Date:** 2026-10-26 · **Branch:** `wt/calib` (from `0b420f3`) · **Model calls:** none · **Network:** two public annotation downloads plus licence and citation checks

## What was done

| Step | Result |
|---|---|
| Licences checked | AMI annotations: **CC BY 4.0**. ICSI (Edinburgh NXT release): **CC BY 4.0**. The ICSI transcripts are also sold by the LDC under a separate licence; that release was not used. Citation text is in `docs/HUMAN-CALIBRATION.md` section 1. |
| Corpora downloaded | Annotations and transcripts only (about 42 MB of zips), into a `_corpora/` folder outside the repository, with a provenance `README.txt`. No audio or video. Not committed: `.gitignore` covers `_corpora/` and the NXT file patterns. |
| `scripts/calibrate-human.ts` | Converts NXT words and dialogue acts into speaker turns with times, then runs the **unchanged** `computeMetrics()` over them. Adds the overlap, cut-off, backchannel and DA-question measures, per-meeting and 40-turn-window distributions (n, p10, q1, median, q3, p90, IQR), pooled turn lengths, and `scoreWithBands()` to preview a band file. |
| Interruption detector validated | Checked against ICSI's hand-coded interruptions (`%-`): 11.2 vs 10.9 per 100 turns. Precision and recall are about 0.5, so it matches the rate, not individual events. |
| `docs/HUMAN-CALIBRATION.md` | Method, licences and citations, results, the current index against humans, a comparison with HUMAN-BASELINES, the poor-analogue caveats, and how to reproduce. |
| `docs/calibration-proposed-bands.json` | 17 proposed bands, each with the current band, the observed distributions, a confidence rating and a basis. **Not applied.** `REALISM_TARGETS` and `shared/` are unchanged. |
| Tests | `scripts/calibrate-human.selftest.ts` has 37 checks on hand-written synthetic XML (no corpus data). It covers the word and act parsers for both corpora, the turn builder, overlap and cut-off, the chair mapping, windows, quantiles, and the band file: valid keys, and the target fixture still beats the baseline fixture by 20+ points. Added to `npm run qa`. |

`npm run typecheck`, `npm run build` and `npm run qa` all pass. The worktree had no `node_modules`, so I ran `npm ci` from the lockfile first; its install scripts were blocked and none were needed. The new scripts also type-check under strict `tsc`. `scripts/` is outside the server tsconfig, as `transcript-metrics.ts` already is.

## Headline findings

1. **Real meetings score 63-77 on the current index** (40-turn windows, p10-p90), below the synthetic target fixture's 79.
2. **Four bands fail essentially every human meeting:**
   - short-turn share: humans 0.80-1.0, band 0.30-0.50;
   - overlap: humans 8-50 per 100, band 5-12;
   - p90 turn length: humans 12-69 words, floor 120;
   - AMI chair word share: 0.11-0.55, band 0.05-0.12.
3. **Interruptions:** 5-25 per 100 in windows, medians 10-15. The current band of 8-20 is about right, and HUMAN-BASELINES' ceiling of 11 is too low.
4. **Questions:** 5-25% of turns. This agrees with HUMAN-BASELINES. The `?` proxy matches the hand-coded question acts.
5. **Concession, position change and filler lexicons read about 0 in humans.** The lexicons were tuned to engine phrasing.
6. **The proposed bands score humans 89-99** and widen the fixture gap: baseline 30.4 → 35.4, target 79.0 → 89.8.

## Commits

1. `Ignore downloaded meeting corpora`
2. `Calibrate the realism metrics on AMI and ICSI meetings` (script, self-test, qa chain, proposed bands JSON)
3. `Docs: human calibration of the realism metrics on AMI and ICSI`
4. `Add the CALIB report` (this file)

## Open questions for the owner

1. **Apply the bands?** Applying them means editing `REALISM_TARGETS`. Every earlier before/after measurement would then need re-baselining under the new index. It would also collide with `wt/baselines`, which edits the same table with literature-based bands. One of the two band sets should win, or be merged metric by metric; `docs/HUMAN-CALIBRATION.md` section 4 lays them side by side.
2. **Size-aware bands for Gini and A-B-A.** Both move with panel size: chance A-B-A is 1/(N-1), and Gini rises with N. AMI (3 experts) and ICSI (4-8) differ for that reason. A band expressed relative to chance or to N would fit 3-expert and 8-expert panels alike.
3. **Meeting or panel?** The proposed short-turn floor (0.65) and p90 ceiling (90 words) are looser than the human data (0.80+ and about 70) to allow set pieces. Should the room sound like a working meeting (tighten them) or a panel (keep them)?
4. **What does the engine's `overlap` flag mean?** At 0.5 s humans run 8-50 per 100; at 1 s, 0-28. If the engine only flags real talking over someone, the band should be nearer 3-20.
5. **Chair share.** The AMI PM holds 28% of words (median), but the PM also presents. The proposal is 10-30%. Is Marcus a facilitator (10-20%) or a chair who drives the agenda (20-30%)?
6. **Concession lexicon.** It sees about 0 human concessions, because people concede with "yeah, true". Either broaden it and recalibrate, or score concessions only through the decision-quality guards and the belief ledger rather than the realism index.
7. **Opener metric.** Human openers repeat ("yeah I think", "okay so"). Excluding discourse-marker openers would let `openerRepeatShare` target engine house style without penalising human-like openers.
