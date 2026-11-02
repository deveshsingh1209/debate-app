# Human calibration of the realism metrics (AMI and ICSI)

**Date:** 2026-10-26
**Script:** `scripts/calibrate-human.ts` (tests: `scripts/calibrate-human.selftest.ts`, in `npm run qa`)
**Proposed bands:** `docs/calibration-proposed-bands.json`. **Applied in 2b-6, with reconciliations** (see `docs/ENGINE-REPORT.md`, "Band decisions"). The text below is the calibration as it was run; where it says the bands are unchanged, that was true when it was written.

## Summary

`docs/HUMAN-BASELINES.md` (on the `wt/baselines` branch) built its bands from published figures, converted from dialogue acts, spurts and "thoughts" into turns. Its last section named the fix: run the script's own metric code over an open meeting corpus. This document does that. Each AMI and ICSI meeting is rebuilt as the same `Turn[]` the debate loader produces, and the same `computeMetrics()` is run over it. The human numbers below are therefore in the script's own units, with no conversion.

What the data says:

1. **Real meetings score only 63-77 on the current realism index** (p10-p90 over 40-turn windows). Real people would fail a test built to measure how real a room sounds.
2. **Four bands fail essentially every human meeting.** Short-turn share is 85-98% (band 30-50%). Overlap is 8-50 per 100 turns (band 5-12). p90 turn length is 12-69 words (floor 120). The AMI chair holds 11-55% of words (band 5-12%).
3. **The interruption band (8-20) is about right.** The detector is checked against ICSI's hand-coded interruptions. It gives 5-25 per 100 turns in 40-turn windows (median 10-15).
4. **Lexicon metrics read about 0 in humans.** These are concessions, position changes and filler. People concede with "yeah" and "true", which the lexicons don't count. The data supports dropping the concession floor of 5 per 100, not setting a new floor.
5. **The proposed bands score humans 89-99** (p10-p90) and still separate the committed fixtures. The baseline-like fixture moves from 30.4 to 35.4, the target-like one from 79.0 to 89.8.

The biggest caveat: **neither corpus is an expert panel debate.** AMI is mostly role-played design meetings, and ICSI is weekly research-group meetings. See "Where the data is a poor analogue" before relying on any band.

---

## 1. Data and licences

Only annotations and transcripts were downloaded: no audio, no video. They were stored outside the repo in a sibling `_corpora/` folder and are never committed (`.gitignore` has `_corpora/` and the NXT file patterns). Only aggregate statistics appear in this repo.

| Corpus | What was downloaded | Size | Licence (checked 2026-10-26) |
|---|---|---|---|
| **AMI Meeting Corpus** | `ami_public_manual_1.6.2.zip` from https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ (words, dialogue acts, segments, meeting metadata with roles) | 22.9 MB | **CC BY 4.0**, per https://groups.inf.ed.ac.uk/ami/corpus/license.shtml and `LICENCE.txt` in the zip |
| **ICSI Meeting Corpus** | `ICSI_core_NXT.zip` from https://groups.inf.ed.ac.uk/ami/icsi/download/ (words, MRDA dialogue acts, segments, speakers) | 19.5 MB | **CC BY 4.0**, per https://groups.inf.ed.ac.uk/ami/icsi/license.shtml and `LICENCE.txt` in the zip |

The site's `robots.txt` disallows only `/nbtest/` and `/links/examples/`. No login was needed.

The ICSI transcripts are also sold by the LDC (LDC2004T04) under the LDC's own licence. The Edinburgh NXT release used here is the CC BY 4.0 one. It is the one to cite and to re-download.

**Attribution.** CC BY 4.0 requires credit, a link to the licence and a note of changes. Any figure from this document that is republished should carry the lines below. "Changes" means: the annotations were converted to speaker turns and summarised as statistics, and no corpus text is reproduced.

> AMI Meeting Corpus, manual annotations release 1.6.2, University of Edinburgh and the AMI Consortium, licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Statistics derived by the debate project; no corpus text reproduced.
> Carletta, J., Ashby, S., Bourban, S., Flynn, M., Guillemot, M., Hain, T., Kadlec, J., Karaiskos, V., Kraaij, W., Kronenthal, M., Lathoud, G., Lincoln, M., Lisowska, A., McCowan, I., Post, W., Reidsma, D., Wellner, P. (2005). The AMI Meeting Corpus: A Pre-Announcement. *Machine Learning for Multimodal Interaction (MLMI 2005)*, LNCS 3869, Springer.

> ICSI Meeting Corpus, NXT annotations public release 1.0, International Computer Science Institute and the University of Edinburgh, licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Statistics derived by the debate project; no corpus text reproduced.
> Janin, A., Baron, D., Edwards, J., Ellis, D., Gelbart, D., Morgan, N., Peskin, B., Pfau, T., Shriberg, E., Stolcke, A., Wooters, C. (2003). The ICSI Meeting Corpus. *Proc. IEEE ICASSP 2003*, Hong Kong.
> Shriberg, E., Dhillon, R., Bhagat, S., Ang, J., Carvey, H. (2004). The ICSI Meeting Recorder Dialog Act (MRDA) Corpus. *Proc. 5th SIGdial Workshop on Discourse and Dialogue*, pp. 97-100. https://aclanthology.org/W04-2319/

**What was used:**
- **AMI:** the 139 meetings with dialogue-act annotation, out of 171 in the release. That is 138 scenario meetings and 1 non-scenario meeting, about 70 hours, and 34,669 non-chair turns.
- **ICSI:** all 75 meetings. That is about 70 hours and 45,860 turns. By series: Bmr 29, Bro 23, Bed 15, Bns 3, Btr 2, and Bdb, Bsr, Buw 1 each.

---

## 2. Method

### From annotations to turns

| Step | Rule | Why |
|---|---|---|
| Unit | One dialogue act (DA): speaker, start, end, words, DA label. AMI times come from the act's words (forced-aligned); ICSI acts carry their own times. Acts with no words, such as a laugh on its own, are dropped. | DAs are the finest unit both corpora label consistently. |
| Words | `<w>` tokens that are not punctuation. AMI marks punctuation with `punc="true"`; ICSI uses `c=` classes. Clitics (`'s`, `'re`) attach to the word before, and ICSI's split hyphen (`Mm - hmm`) is rejoined. Filled pauses ("um", "uh") count as words because the transcribers wrote them as words. | So `text.split(/\s+/)` in `computeMetrics()` counts the same words. |
| Backchannel | AMI DA `bck`; ICSI general tag `b`. **Not a turn** by default (`--with-backchannels` makes them turns). | The simulator's turns are contributions, and "mm-hm" is not one. HUMAN-BASELINES makes the same choice. |
| Turn | A maximal run of one speaker's non-backchannel acts, in start-time order. Another speaker's backchannel does not end a turn; another speaker's contribution does. | "A turn is one speaker's contribution between other speakers", as in the debate loader. |
| Chair | AMI: the Project Manager (`role="PM"` in `meetings.xml`). Their turns become `kind: 'marcus'`, so, as in a debate, they are excluded from expert-turn metrics and counted in `chairWordShare`. ICSI has no annotated chair, so every speaker is an expert. | The only chair the data identifies. |
| Overlap (`overlapRate`) | A turn whose first act starts at least **0.5 s** before another speaker's act ends. 0 s and 1 s are also reported. | The engine's `overlap` means one turn spoken over another. 0.5 s drops the 200-300 ms overlaps at turn changes, which are timing noise rather than talking over someone. |
| Cut-off (`interruptionRate`) | The overlapped turn, when its speaker then stops **mid-sentence** (no terminal `. ? !` in the transcript) while the newcomer is still talking. One per interrupted turn, as with the engine's `cutOff`, which counts the person cut off, not the interrupter. | Checked against ICSI's hand-coded interruptions (see the next table). |
| Everything else | `computeMetrics()` unchanged: questions are turns containing `?`; A-B-A runs over expert turns; Gini covers the experts who spoke; the lexicons come from `shared/lexicon.ts`. | Same units, same code. |

### Checking the interruption detector against ICSI's hand labels

ICSI's MRDA annotators marked acts as interrupted (`%-`) or abandoned (`%--`). The reference is a turn whose last act is `%-`. On ICSI that is 10.9 per 100 turns. Variants of the timing rule, scored against that reference:

| Rule | per 100 | precision | recall |
|---|---|---|---|
| any overlap + mid-sentence stop + stops first (**adopted**) | **11.2** | 0.49 | 0.50 |
| same, but the speaker must not resume during the newcomer's turn | 5.8 | 0.60 | 0.32 |
| same, with overlap >= 0.5 s | 4.2 | 0.56 | 0.22 |
| any overlap + stops first, with no mid-sentence test | 34.4 | 0.17 | 0.52 |

The adopted rule matches the hand-coded rate, which is what a band needs. It does not match individual events well (precision and recall about 0.5). Recall tops out around 0.55 for any timing rule: about half of the hand-coded interruptions have no overlap at all, because the speaker broke off and someone came in after a gap. 94% of the hand-coded interrupted acts end without terminal punctuation, which supports the mid-sentence test.

### Windows

A human meeting has 87-950 expert turns; a debate has about 20-80. Several metrics grow with length:
- `openerRepeatShare` counts openers shared by 3 or more turns.
- `recycled4gramShare` grows as the pool of earlier turns grows.
- Gini covers whoever spoke.

So every meeting was also cut into consecutive **windows of 40 expert turns**, roughly one motion, with the remainder dropped. That gives 799 AMI windows and 1,114 ICSI windows. **The windowed figures are the like-for-like ones.** Bands are proposed from them and checked against the whole-meeting figures.

### What cannot be measured here

- `addressesChairShare` (and colleague or founder address): speakers are anonymised, so there are no names.
- `multiParagraphShare` and `emDashPer1k`: speech has no paragraphs and no authored punctuation.
- The five engine tics: these are artefacts of the engine and read 0 in humans by construction.

These bands stay as they are.

---

## 3. Results

### Per metric: humans against the current band

The window columns give p10 / median / p90 over 40-turn windows. The meeting columns give the median (IQR) over whole meetings. "Human score now" is the median 0-1 part score a human window gets under the current band (AMI / ICSI).

| Metric | AMI windows | ICSI windows | AMI meetings | ICSI meetings | Current band | Human score now | **Proposed** |
|---|---|---|---|---|---|---|---|
| wordsCv | 0.86 / 1.23 / 2.29 | 1.04 / 1.42 / 2.07 | 1.78 (1.49-2.34) | 1.86 (1.67-2.05) | >= 0.8 | 1 / 1 | **0.9-2.3** |
| wordsP10 | 1 / 1 / 2 | 1 / 1 / 2 | 1 (1-1) | 1 (1-1) | <= 12 | 1 / 1 | **<= 6** (scale 30) |
| wordsP90 | 12 / 23 / 54 | 17 / 33 / 69 | 29 (21-38) | 42 (32-49) | >= 120 | 0.03 / 0.13 | **20-90** |
| shortTurnShare (< 40 w) | .85 / .98 / 1.0 | .80 / .93 / .99 | .94 (.90-.97) | .89 (.87-.92) | .30-.50 | **0 / 0** | **>= .65** |
| memoTurnShare (> 150 w) | 0 / 0 / .03 | 0 / 0 / .044 | .01 (0-.02) | .01 (0-.02) | <= .15 | 1 / 1 | **<= .08** |
| interruptionRate /100 | 5 / 15 / 25 | 5 / 10 / 20 | 13.5 (9.9-16.3) | 10.6 (9.4-12.6) | 8-20 | 1 / 1 | **5-20** |
| overlapRate /100 (>= 0.5 s) | 22.5 / 35 / 50 | 7.5 / 17.5 / 32.5 | 33.5 (29-39) | 16.3 (12-21) | 5-12 | **0 / 0.08** | **8-35** |
| pingPongRate | .26 / .42 / .58 | .37 / .55 / .79 | .40 (.35-.44) | .61 (.52-.72) | .15-.35 | 0.53 / 0 | **.25-.60** |
| questionShare | .03 / .10 / .20 | .05 / .15 / .25 | .11 (.09-.14) | .17 (.14-.20) | >= .25 | 0.4 / 0.6 | **.05-.25** |
| concessionPer100 | 0 / 0 / 0 | 0 / 0 / 0 | 0 (0-0) | 0.1 (0-.25) | 5-12 | 0.5 / 0.5 | **0-5** |
| positionChangePer100 | 0 / 0 / 0 | 0 / 0 / 0 | 0 | 0 | 3-8 | 0.4 / 0.4 | **0-2** |
| fillerTurnShare | 0 / 0 / .03 | 0 / 0 / .03 | .01 (0-.02) | .01 (.01-.01) | <= .01 | 1 / 1 (p10: 0.6) | **<= .03** |
| summaryEndingShare | 0 / 0 / .03 | 0 / 0 / .05 | .01 (0-.02) | .02 (.01-.03) | <= .05 | 1 / 1 | <= .05 (kept) |
| openerRepeatShare | 0 / .08 / .15 | 0 / 0 / .13 | .13 (.08-.16) | .15 (.14-.19) | <= .05 | 0.7 / 1 | **<= .10** (scale .15) |
| recycled4gramShare | 0 / .003 / .027 | 0 / .004 / .031 | .017 (.010-.024) | .019 (.015-.025) | <= .03 | 1 / 1 | <= .03 (kept) |
| giniTurns | .05 / .17 / .30 | .15 / .30 / .42 | .11 (.07-.16) | .36 (.26-.43) | .25-.45 | 0.6 / 1 | **.08-.42** |
| chairWordShare | .11 / .28 / .55 | (no chair) | .33 (.25-.44) | n/a | .05-.12 | **0** / n/a | **.10-.30** (scale .15) |

Notes:
- Windowed quantiles move in steps of 2.5 per 100 (1 turn in 40), which is why so many are round.
- The ICSI figures with no annotated chair include whoever leads the meeting as an expert. That inflates Gini and A-B-A relative to a chaired room.

### Supporting measurements (not scored by the index)

| Measurement | AMI | ICSI |
|---|---|---|
| Overlap at any onset, per 100 turns (windows p10 / median / p90) | 50 / 65 / 80 | 35 / 52.5 / 67.5 |
| Overlap >= 1 s, per 100 turns (windows) | 5 / 15 / 27.5 | 0 / 5 / 12.5 |
| Hand-coded interrupted acts ending a turn, per 100 (meetings, median and IQR) | n/a | 10.9 (8.2-13.0), against 10.6 (9.4-12.6) from the detector |
| Turns with a DA-coded question (AMI `el.*`, ICSI `q*`), meeting median | .106 | .17, against .11 and .17 from the `?` count |
| Backchannels per 100 expert turns (meeting median, IQR) | 37.5 (26-53) | 34.4 (24-40) |
| Backchannels as a share of all acts | .105 | .128 |
| Largest single speaker's share of all words (meeting median) | .38 | .38 |
| Expert turns per minute (meeting median) | 7.3 | 10.0 |

The `?` count agrees with the hand-coded question acts to within 0.01 in both corpora. So `questionShare` is a sound proxy, at least on transcribed speech.

### Turn lengths pooled over every expert turn

| | turns | mean words | CV | p10 | median | p90 | < 40 words | > 150 words |
|---|---|---|---|---|---|---|---|---|
| AMI, backchannels excluded | 34,669 | 13.0 | 2.52 | 1 | 5 | 26 | 94.3% | 0.8% |
| ICSI, backchannels excluded | 45,860 | 16.4 | 2.11 | 1 | 6 | 38 | 90.5% | 1.1% |
| AMI, backchannels as turns | 45,733 | 10.0 | 2.28 | 1 | 4 | 23 | 96.2% | 0.4% |
| ICSI, backchannels as turns | 64,268 | 12.0 | 1.98 | 1 | 5 | 29 | 93.7% | 0.4% |

These agree with the published means HUMAN-BASELINES used: AMI about 10-11 words per turn and ICSI about 13-16 [QMSUM], [FAME].

### The realism index on real meetings

| | AMI windows | ICSI windows | AMI meetings | ICSI meetings | baseline fixture | target fixture |
|---|---|---|---|---|---|---|
| Current bands (p10 / median / p90) | 63.2 / 68.9 / 73.8 | 67.5 / 72.3 / 77.5 | 64.4 / 68.0 / 71.5 | 67.4 / 70.6 / 76.6 | 30.4 | 79.0 |
| Proposed bands | 89.1 / 94.4 / 98.9 | 89.2 / 95.3 / 97.9 | 89.8 / 95.0 / 98.5 | 89.6 / 95.0 / 97.1 | 35.4 | 89.8 |

The current index gives a real meeting about 70, below the synthetic "target" fixture's 79.0. The proposed bands put human meetings at about 95. The gap between the two fixtures widens from 48.6 to 54.4 points. The self-test checks that the gap stays above 20.

---

## 4. Against HUMAN-BASELINES

`docs/HUMAN-BASELINES.md` is on branch `wt/baselines` and was read but not merged here. It proposed literature-based bands. Where the corpus run agrees or disagrees with them:

| Metric | HUMAN-BASELINES | Corpus run | Verdict |
|---|---|---|---|
| wordsCv | 1.0-1.7 | windows p90 2.1-2.3; meeting medians 1.8-1.9 | Its ceiling is too low. Proposed: 0.9-2.3. |
| wordsP90 | >= 40 | window medians 23 (AMI) and 33 (ICSI) | A floor of 40 fails the median human window. Proposed: 20-90. |
| shortTurnShare | 40-90% | AMI median .98, ICSI .93 | Its ceiling of 90% is too low. Proposed: >= 65%, open above. |
| interruptionRate | 3-11 | windows 5-20/25, validated against ICSI `%-` | Its ceiling of 11 is too low. The current 8-20 was closer. Proposed: 5-20. |
| overlapRate | 5-29 | 8-35 at 0.5 s | Close. Proposed: 8-35. |
| pingPongRate | 20-50% | AMI .26-.58, ICSI .37-.79 | ICSI runs above it. Proposed: .25-.60. |
| questionShare | 8-25% | .03/.05-.20/.25 | **Agrees.** Proposed: 5-25%. |
| concessionPer100 | 0.5-12 | about 0 by the lexicon | The lexicon can't see human concessions. Proposed: 0-5. |
| positionChangePer100 | 0-2 | 0 | **Agrees.** |
| fillerTurnShare | <= 5% | p90 3% | Close. Proposed: <= 3%. |
| summaryEndingShare | <= 2% | p90 3-5% | Its band is tighter than humans. Proposed: <= 5% (current kept). |
| giniTurns | .15-.45 | AMI (3 speakers) .05-.30; ICSI (4-6) .15-.42 | Size-dependent. Proposed: .08-.42. |
| chairWordShare | 8-20% | AMI PM .11-.55, median .28 | The AMI PM runs well above it. Proposed: 10-30% (a judgement; see below). |

Both efforts agree on the main corrections:
- Far more short turns than the old bands allowed.
- Interruptions are not rare, but overlap was capped far too low.
- Questions under about 25%.
- Stated changes of position are close to zero.

They disagree on the ceilings for CV and interruption, and on the p90 floor. In each case the corpus shows a wider and shorter-turned room than the literature conversions implied.

---

## 5. Where the data is a poor analogue

Neither corpus records what this app simulates: a moderated panel of domain experts arguing toward a decision for a founder. Specifically:

1. **AMI is mostly role-play.** 138 of the 139 meetings used are scenario meetings: four participants, often students, play roles (Project Manager, Industrial Designer, UI Designer, Marketing) in a fictional remote-control design company, over four meetings. They are not experts in the roles they play, and nothing is at stake. The PM is assigned the chair, handed an agenda and slides, and presents. That is why `chairWordShare` reads 28-33%. It is a presenter-chair, not a moderator.
2. **ICSI is real but routine.** These are natural weekly meetings of speech and AI research groups. The participants are genuine domain experts on technical topics, which makes ICSI the better analogue. But the meetings are status updates and planning, not adversarial decisions. The groups recur, so people know each other well, and 3-10 people attend. No chair is annotated, so the ICSI rows count the de facto leader as an expert.
3. **Neither is a debate.** There are no assigned opposing positions, no motions, no founder to answer to, and almost no explicit concession or position change. The low concession and position-change figures say as much about the setting as about people. Expert panels with real stakes may concede more, and certainly argue at greater length.
4. **Turn length is the most genre-sensitive figure.** Design and status meetings are full of "yeah", "okay" and one-word answers that are not backchannels (AMI `ass`, ICSI `s^aa`). An expert panel has more set pieces. So the proposed `shortTurnShare` floor (0.65) and `wordsP90` ceiling (90) are deliberately looser than the human data: a 40-turn window of these meetings sits at 0.80-1.0 and 12-69. If the owner wants the room to sound like a meeting rather than a panel, tighten both toward the human figures.
5. **Group size moves several metrics.** Gini rises and A-B-A falls with more speakers (chance A-B-A is 1/(N-1)). AMI has 3 non-chair speakers and ICSI has 4-8. The engine seats up to 3, 4 or 8 experts by budget profile (`shared/budget.ts`), which happens to span both corpora. One band for every panel size is a compromise. A size-aware band would be better (open question 2 in the report).
6. **The lexicon metrics were built for engine output.** Concession, position change, filler, summary endings and tics are regexes tuned to the phrases the engine over-produced. Humans reading about 0 on them means "humans do not talk like that". It does not mean humans never concede.
7. **Transcription conventions.** Question marks and full stops are the transcribers' judgement of intonation and completeness. Both the question proxy and the mid-sentence test depend on them. Filled pauses count as words, which the engine never produces, so human turns look slightly longer than their content.
8. **The overlap threshold matters.** At 0 s, 35-80 per 100 turns overlap; at 0.5 s, 8-50; at 1 s, 0-28. The band depends on what the engine's `overlap` flag means. If it means talked over for more than a beat, the 1 s figures apply and the band should be nearer 3-20.

---

## 6. Proposed bands

They are in `docs/calibration-proposed-bands.json`. Each entry carries:
- `lo`, `hi`, `scale` and `weight` (the current weight; none is proposed to change);
- the current band;
- the observed p10/q1/median/q3/p90 for AMI and ICSI, for windows and for whole meetings;
- a confidence rating and a one-line basis.

`null` means an open bound. Keys left out keep their current band: `multiParagraphShare`, `addressesChairShare`, `emDashPer1k` and the five tics.

**Not applied.** Applying them would mean editing `REALISM_TARGETS`. Any engine change measured against the old index would then need re-baselining. That is the owner's call. To preview the effect on any input without changing anything:

```sh
npx tsx scripts/calibrate-human.ts --corpus icsi --dir ../_corpora/icsi/ICSI --window 40 --bands docs/calibration-proposed-bands.json
```

`scoreWithBands()` in the script applies a band file to any `Metrics` object, so the same check can run on a real debate.

---

## 7. Reproduce

```sh
# 1. Annotations only (about 42 MB), outside the repo
mkdir -p ../_corpora/ami ../_corpora/icsi
curl -fL -o ../_corpora/ami/ami_public_manual_1.6.2.zip https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip
curl -fL -o ../_corpora/icsi/ICSI_core_NXT.zip https://groups.inf.ed.ac.uk/ami/ICSICorpusAnnotations/ICSI_core_NXT.zip
unzip -q ../_corpora/ami/ami_public_manual_1.6.2.zip -d ../_corpora/ami
unzip -q ../_corpora/icsi/ICSI_core_NXT.zip -d ../_corpora/icsi

# 2. Whole meetings and 40-turn windows (about 10 s each)
npx tsx scripts/calibrate-human.ts --corpus ami  --dir ../_corpora/ami
npx tsx scripts/calibrate-human.ts --corpus ami  --dir ../_corpora/ami --window 40
npx tsx scripts/calibrate-human.ts --corpus icsi --dir ../_corpora/icsi/ICSI --window 40 --json /tmp/icsi.json
# Options: --with-backchannels, --overlap-min <sec>, --min-turns <n>, --bands <file>
```

The zips used were 22,887,865 bytes (AMI) and 19,488,722 bytes (ICSI). The release numbers (AMI 1.6.2, ICSI NXT 1.0) pin the content.
