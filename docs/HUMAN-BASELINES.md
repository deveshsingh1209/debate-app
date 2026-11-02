# Human baselines for the realism index

**Date:** 2026-10-26
**Replaces:** the "what a real room looks like" column of `docs/PHASE2-PLAN.md` section 1.1, which came from memory.
**Applies to:** every metric in `scripts/transcript-metrics.ts` that the realism index scores (`REALISM_TARGETS`, in the same file). The comments on that table cite the keys used here.
**Superseded in part (2b-6):** the rhythm metrics now use the bands measured on the AMI and ICSI corpora (`docs/HUMAN-CALIBRATION.md`), reconciled as recorded in `docs/ENGINE-REPORT.md`. The lexicon metrics keep the bands below. The "New" column is therefore no longer the live band for every row.

## How to read this

- **Units do not match.** Human corpora count dialogue acts (DAs), "spurts", speaker changes, utterances or coded "thoughts". This script counts *expert turns*: one speaker's contribution between other speakers, chair excluded. Most bands below are conversions, and each says how it was converted.
- **Backchannels matter.** In human corpora, "mm-hm" often counts as a turn. In CANDOR the median turn is 2 words if it does and 9 words if it doesn't [CANDOR]. The simulator's turns are deliberate contributions, so the comparisons below use figures with backchannels absorbed or excluded wherever the source allows.
- **Setting matters.** The closest human analogue to this app is a moderated expert deliberation of 3-6 people. Casual phone calls (Switchboard, CANDOR) have shorter turns. Formal committees and televised debates have longer ones. Where they differ, the band leans toward meetings, deliberation and committees.
- **Confidence:**
  - *High*: the number was read in the source.
  - *Medium*: a sourced number, with a simple conversion.
  - *Low*: a model-based conversion, a small sample, or a different construct.
  - *Assumption*: no human source was found. The band is a design choice and is labelled as one.
- **Verification.** Four research passes collected sources. I then reopened the key ones and checked these numbers myself: MRDA Tables 3-4, Smith-Lovin & Brody pp. 429-430, CANDOR Table 1, the Stromer-Galley 2007 results, and Fay et al. Fig. 1. Anything seen only in a search snippet is marked as such and is not used for a band.

## Summary table

"Old" is the band from `PHASE2-PLAN.md` 1.1. "New" is the band now in `REALISM_TARGETS`.

| Metric | Old | New | Confidence | Main sources |
|---|---|---|---|---|
| wordsCv | ≥ 0.8 | **1.0-1.7** | medium | THRELKELD22, ROBINSON22, STROMER07 |
| wordsP10 | ≤ 12 | ≤ 12 (unchanged) | low | CANDOR, ROBINSON22 |
| wordsP90 | ≥ 120 | **≥ 40** | low | CANDOR (fit), STROMER07, QMSUM, FAME |
| shortTurnShare (< 40 words) | 30-50% | **40-90%** | low-medium | ISL02, STROMER07, QMSUM, FAME |
| memoTurnShare (> 150 words) | ≤ 15% | ≤ 15% (now sourced) | low | ISL02, STROMER07, QMSUM |
| multiParagraphShare | ≤ 15% | ≤ 15% (unchanged) | assumption | proxy: THRELKELD22, ROBINSON22 |
| interruptionRate /100 | 8-20 | **3-11** | medium | SMITHLOVIN89, OKAMOTO02, MRDA |
| overlapRate /100 | 5-12 | **5-29** | upper medium; lower assumption | WANG25, LIBERMAN14, HELDNER10, CETIN06 |
| pingPongRate | 15-35% | **20-50%** | assumption (chance reference) | PARKER88 (qualitative) |
| questionShare | ≥ 25% | **8-25%** | medium-low | STROMER07, MRDA, AMI07, SWBD00 |
| addressesChairShare | ≤ 10% | ≤ 10% (now sourced) | low | STROMER07, MCCARTHY03 |
| concessionPer100 | 5-12 | **0.5-12** | low | MRDA, BACHTIGER16, GERMESIN09 |
| positionChangePer100 | 3-8 | **0-2** | low-medium | TAN16, GASTIL07, MEADE05 |
| fillerTurnShare | ≤ 1% | **≤ 5%** | medium-low | MRDA, SWBD00, MAYOR25 |
| emDashPer1k | ≤ 0.5 | ≤ 0.5 (unchanged) | assumption | FREEBURG26 (written prose only) |
| summaryEndingShare | ≤ 5% | **≤ 2%** | low | SWBD00, MRDA, STROMER07 |
| openerRepeatShare | ≤ 5% | ≤ 5% (unchanged) | assumption | SWBD00 (counter-evidence) |
| recycled4gramShare | ≤ 3% | ≤ 3% (unchanged) | assumption | HEALEY14, MAYOR25 |
| giniTurns | 0.25-0.45 | **0.15-0.45** | medium-low | FAY00, CHOI26, ARCHIBEQUE17, ROSE20 |
| chairWordShare | 5-12% | **8-20%** | medium-low | SMARTPOLITICS, STROMER07 |
| tic.* (5 tics) | ≤ 1-5 /100 | unchanged | assumption | none: these are engine artefacts |

Effect on the committed fixtures: the baseline-like fixture moves from 30.4 to 39.3 and the target-like one from 79.0 to 86.4. The self-test's "target well above baseline" check still passes. The imported corpus was not re-scored: it lives in the main checkout, which this task does not touch.

The two biggest corrections are these. First, real rooms have **far more short turns** than the old band said (meetings run 80-94% under 30-40 words). Second, real experts **rarely state a change of position** (under 1 per 100 turns even on a forum built to change minds), so the old 3-8 band asked for theatrical mind-changes. Interruptions and questions were also set too high. The chair's share of talk was set too low.

---

## 1. Turn length

### wordsCv: coefficient of variation of words per turn

| Finding | Setting | Source | Conf. |
|---|---|---|---|
| Turn word count mean 15.3, SD 23.4, so **CV 1.53**. Gamma fit shape 0.718 implies CV ≈ 1.18; the authors note the real tail is heavier. | Switchboard, 75 calls, 5,857 turns | THRELKELD22, App. A.5 | high |
| Single-unit turns 67% (mean 4.5 words, SD 3.4); multi-unit turns 33% (mean 19.9, SD 22.6). Mixture SD ≈ 15.1 on mean 9.6, so **CV ≈ 1.58** (derived). | BNC conversation, 475,509 turns | ROBINSON22 | high / derived |
| Words per coded thought mean 83.77, SD 85.71, so **CV 1.02** | 23 moderated online voice deliberations, 5-12 people, N = 6,310 thoughts | STROMER07, p. 15 | high (read) |
| Mean exceeds median everywhere (CANDOR median 9 vs mean 17.8), so the distribution is right-skewed | CANDOR | CANDOR, Table 1 | high (read) |

**Band 1.0-1.7.** No human source falls below 1.0; deliberation is the low end. The upper bound stops the score from rewarding a room made only of one-word reactions and monologues. Confidence: medium.

### wordsP10 and wordsP90

No source publishes percentiles for meetings.
- **p10.** CANDOR's median turn is 9 words with backchannels absorbed and 2 words without. Two thirds of BNC turns are a single unit averaging 4.5 words [ROBINSON22]. A lognormal fit to CANDOR (median 9, mean 17.81, σ ≈ 1.17) gives p10 ≈ 2. The old band, **p10 ≤ 12**, is consistent with all of this and is kept. Confidence: low.
- **p90.** The same fit gives p90 ≈ 40 for conversation. Deliberation and committees run longer (see the means below).
- **p90 band: ≥ 40, lowered from ≥ 120.** The old floor of 120 demanded long set pieces at a rate no meeting source supports. Confidence: low.

Mean words per turn, for context (not scored):
- CANDOR: 17.8 (backchannels absorbed) [CANDOR].
- Switchboard: 15.3 [THRELKELD22].
- AMI: about 9.6-11.2 per transcript turn; ICSI about 13-16 [QMSUM], [FAME] (derived from per-meeting totals).
- Fay et al.: 16.8 words per turn in 5-person discussions [FAY00]. This is quoted by a research pass; I did not see it on the pages I checked.
- Parliamentary committees: about 34-66 [QMSUM], [FAME]. The two papers' turn splits disagree.
- Broadcast interviews: NPR about 37, CNN about 53 [MEDIASUM].
- Moderated deliberation: 84 words per thought [STROMER07].
- US presidential debates: medians 16-370 words per turn by candidate, 1960-2024 [SAVOY26]. This is a speech format, not a meeting.

### shortTurnShare: share of turns under 40 words

- **ISL meetings** [ISL02]: turns over 30 words or 10 s are only 6.3-12.8% of turns, depending on meeting type. So 87-94% of turns are 30 words or fewer, and at least that share is under 40. One-word turns are 28-40% of all turns. Dropping them as a rough backchannel proxy leaves about 79-91% under 30 words. These bounds pair figures from different meeting types.
- **BNC conversation** [RUHLEMANN24]: 61% of turns are 3-25 words.
- **Deliberation and committees, my assumption.** If their turn lengths are roughly exponential on the published means (84 words [STROMER07]; 34-66 [QMSUM], [FAME]), then P(< 40 words) = 1 − e^(−40/mean) ≈ 0.38-0.69. The exponential shape is an assumption, chosen because it matches the CV ≈ 1.0 measured in STROMER07.

**Band 40-90%**, raised from 30-50%. The lower bound is the deliberation end, the upper bound the meeting end. Confidence: low-medium.

### memoTurnShare: share of turns over 150 words

No direct measurement exists.
- **Meetings.** 150 words takes about 45-56 s at 2.7-3.3 words/s [YUAN06], [CANDOR]. In ISL meetings only 5-10% of turns pass 10 s [ISL02], so the share past 150 words must be far lower.
- **Deliberation and committees, same exponential assumption as above.** e^(−150/84) ≈ 17%, e^(−150/66) ≈ 10%, e^(−150/34) ≈ 1%.

**Band ≤ 15%** (unchanged, now derived). Above it the transcript reads as prepared statements, which in the sources happens only in presidential debates. Confidence: low.

### multiParagraphShare

**No human analogue**, since speech has no paragraphs. The nearest proxy is units per turn: mean 1.99 TCUs (turn-construction units, roughly a clause or sentence) per Switchboard turn [THRELKELD22], and 67% of BNC turns are a single unit [ROBINSON22]. The band stays at **≤ 15%** as an **assumption**. A better metric would count sentences per turn against those figures.

### Not scored, recorded for later use

- **Speaking rate**, for converting seconds to words: Switchboard 196 wpm overall, Fisher 193, CallHome 214 [YUAN06]; CANDOR 3.3 words/s [CANDOR].
- **Sentence length**, for sentenceWordsCv: Switchboard TCUs mean 7.7 words, SD 7.62, CV ≈ 0.99 [THRELKELD22]. Presidential debates: mean 10.0-23.9 tokens per sentence [SAVOY26].
- **Backchannels as a share of units**: Switchboard 19% of utterances [SWBD00]; ICSI 13.4% of general tags [MRDA]; AMI 17.6% of DAs [AMI07].

---

## 2. Floor: interruption, overlap, exchange

### interruptionRate: interjections plus cut-offs, per 100 expert turns

| Finding | Setting | Source | Conf. |
|---|---|---|---|
| "540 interruptions compared to 4,576 noninterrupted transitions": 540 / 5,116 = **10.6 per 100 transitions**, all kinds (supportive, neutral, negative). "approximately 17.4 interruption attempts per quarter hour". Negative interruptions "only 1.79 percent of the observed speaker turns". | 31 six-person task groups, about 15 min each | SMITHLOVIN89, pp. 429-430 | high (read) |
| 254 interruptions in 8,888 utterances by syntactic coding = **2.9 per 100**. A single coder's perceptual judgement gives 2,368 = 26.6 per 100, a ceiling. | 86 mock-jury groups of 2-4 people | OKAMOTO02 | high |
| Interrupted DAs `%-` 3.33% and abandoned `%--` 4.39% of 180,218 tags, about 5.3 and 7.0 per 100 DAs; floor grabbers 2.74% of general tags | ICSI MRDA, 75 meetings, about 6 speakers | MRDA, Tables 3-4 | high (read) |
| Televised debate: 90 interruptions in 90 min (Washington Post) or 212 (Fox), with no turn count published | Trump-Biden 2020 | press, via the research pass | medium; not usable per turn |

**Band 3-11 per 100**, lowered from 8-20. The low end is strict competitive cut-offs; the high end is every interjection attempt. Heated stretches can run higher: overlap rises from 16% to 25% in ICSI "hot spots" [CETIN06]. The director's per-motion `interruptCap` (3/4/6 by profile in `shared/budget.ts`) lands inside this band only if a motion runs about 30-55 expert turns; at that cap a 20-turn motion would read 15-30 per 100. Confidence: medium.

### overlapRate: turns spoken over another turn, per 100 expert turns

| Finding | Setting | Source | Conf. |
|---|---|---|---|
| Overlap turn-taking 3,236 vs clean turn-taking 7,922, so **29.0 per 100 speaker changes**, backchannels excluded | 77 VR sessions with 3-4 people | WANG25 | high |
| Segments that start over someone and continue past them: 34,203 / 129,094 = **26.5 per 100** | ICSI, 75 meetings | LIBERMAN14 (expert blog, not peer-reviewed) | medium |
| About 40-42% of between-speaker intervals are overlaps | three dyadic corpora | HELDNER10, Table 5 | high |
| Overlap is 11.6% of speaking time (NIST) and 16% (ICSI). P(overlapped \| statement) = 12.4%; backchannels 69.5%. Most overlap sits "at potential turn-exchange regions". | ICSI, NIST meetings | CETIN06 | high |
| Two or more people speak in 5.3% of 100-ms frames; the most frequent overlap duration is 200-300 ms | ICSI | LASKOWSKI12 | high |
| Spurts overlapped, backchannels excluded: 46.4% (open meetings) vs 21.0% (meetings led by one speaker) | ICSI | SHRIBERG01, Table 2 | high |

**Band 5-29 per 100**, widened from 5-12.
- The **upper bound is sourced** (medium confidence): turn-onset overlap in small groups with backchannels excluded is about 26-29 per 100, and led meetings run lower.
- Most human overlap is brief and cooperative. The engine produces overlap only on cut-ins, so in practice it will sit well under the ceiling.
- The **lower bound of 5 is an assumption**: no source puts deliberate visible overlap that low, but a room with none is the artefact this metric exists to catch.

### pingPongRate: share of turn triples that are A-B-A

**No human rate was found.**
- Parker (1988), as summarised in ML-SPEAK (arXiv 2411.15405), found that a second-order model (the last two speakers) predicts the next speaker best. In-progress two-person "floors" tend to continue, and an interrupted floor tends to be re-established. That points to A-B-A **above chance**. Stasser & Taylor (1991) and Laskowski's speaker-transition models probably hold the numbers but were not readable.
- The only arithmetic available is a chance reference. With N experts and no self-transitions, P(A-B-A) = 1/(N−1): 0.50 for 3, 0.33 for 4, 0.25 for 5, 0.20 for 6.

**Band 20-50%, an assumption** anchored to chance for 3-6 experts. The old 15-35% band sat below chance for small panels, which would have rewarded a queue. The engine's 2.5% baseline is far below any of these.

---

## 3. Questions and address

### questionShare: share of expert turns containing a question

| Finding | Setting | Source | Conf. |
|---|---|---|---|
| "Eight percent of thoughts (N=424) were genuine questions". Rhetorical questions excluded; about one thought per turn. | Moderated deliberation | STROMER07 | high |
| qy 4.91 + qw 1.82 + qh 0.36 + qrr 0.35 + qr 0.20 + qo 0.17 = **7.8% of general tags**; 10.3% of statements plus questions | ICSI MRDA | MRDA, Table 4 | high (read) |
| Elicit-* acts = **5.8% of DAs**; 9.1% of substantive DAs | AMI | AMI07, Table 1 | high |
| Questions of all types ≈ 5.8% of utterances | Switchboard | SWBD00, Table 2 | high |

**Conversion.** ICSI has about 7 words per DA, and turns run about 16.8 words [FAY00], so about 2.4 DAs per turn. If questions fall independently across DAs, P(turn contains a question) = 1 − (1 − p)^2.4, which is about 18% at p = 0.078 and 23% at p = 0.103. Questions cluster, so these are upper estimates.

**Band 8-25%**, previously ≥ 25% with no ceiling. A session where the experts interrogate the founder (the plan measured 30%) scores 0.67 on this part, which is fair: that is a cross-examination, not a meeting. If the owner wants hot-seat sessions to score as real, this is the band to revisit. Confidence: medium-low.

### addressesChairShare: share of expert turns naming the chair

- Participants "responded to the moderator in 10% of the turns (N=547)" [STROMER07, p. 15]. That is responding, not naming, so it is an upper bound.
- Vocatives run at 232 in about 55,000 words of radio phone-ins, or 4.2 per 1k words, a name-heavy genre [MCCARTHY03]. At about 17 words per turn that is at most about 7% of turns naming *anyone*.
- Addressing one individual by any means (gaze, content) is far more common: 31-60% of DAs in AMI and M4 meetings [JOVANOVIC06], [FUKUDA26]. The script counts names only.

**Band ≤ 10%** (unchanged, now sourced). Confidence: low.

addressesColleagueShare and addressesFounderShare are reported but not scored. The vocative rate above (about 2-7% of turns) is the nearest human figure.

---

## 4. Concession and change of position

### concessionPer100: turns with a voiced concession marker, per 100

- ICSI: partial accept (aap) 0.15% and maybe (am) 0.21% of tags; accept / yes-answer (aa) 3.38%, which mostly means "yeah, right", not conceding [MRDA, Table 3, read].
- AMI: agreements 3.6% of DA segments, averaging 2.9 words; about 69% are assessments [GERMESIN09].
- Deliberative quality index, "explicit respect" toward counterarguments: 11.7% of speeches in four parliaments and 15.9% in a mini-public [BACHTIGER16]. This includes valuing a counterargument without yielding, so it is an upper bound.
- ChangeMyView: concessions are "almost equally likely" in winning and losing arguments [MUSI18].

**Band 0.5-12 per 100**, previously 5-12. The floor of 0.5 comes from the MRDA partial-accept rate. The ceiling is the parliamentary respect rate, and over about 16 no source supports it. The engine's 21 per 100 is well outside. Confidence: low, because the marker lists differ from the coded categories.

### positionChangePer100: explicit change of position, per 100 turns

- **ChangeMyView**, a forum whose purpose is changing a view: about 30% of threads get at least one delta, at 1.5 deltas per such thread, over a typical 54 replies. 0.30 × 1.5 / 54 × 100 ≈ **0.83 per 100 turns** [TAN16]. The 30% was read off a figure: medium.
- **Juries**: "only 1 in 10 cases results in a reversal of the initial majority's verdict preferences" [GASTIL07].
- **FOMC**: about 30% voiced disagreement against a 7.5% formal dissent rate. Members fall in line silently rather than announcing a reversal [MEADE05]. A 2017 revision lowered the disagreement rates; the revised numbers were not retrieved.
- **Deliberative Polls**: attitudes do shift (68% of indices show significant net change), but in surveys, not in speech [FARRAR10].

**Band 0-2 per 100**, previously 3-8. This is the plan's largest correction. Experts rarely state a reversal out loud. The plan's other requirement, that at least 80% of changes be traceable to a cause, is unaffected and is now more important: a change should be rare and caused, not a ritual. Confidence: low-medium.

### expertsConcedingShare

Reported, not scored. Evidence is too thin to set a band. A per-turn concession rate of 0.4-12% over 20 turns per expert implies anywhere from 8% to 92% of experts conceding, which is useless as a target.

---

## 5. Filler, summary endings, repetition, punctuation

### fillerTurnShare: praise and agreement filler

- ICSI: appreciation (ba) 1.37% and thanks (ft) 0.08% of tags [MRDA, read].
- Switchboard: appreciation 2%, agree/accept 5%, thanking under 0.1% of utterances [SWBD00].
- AMI: be-positive 1.8% of DAs [AMI08].
- At about 2.4 DAs per turn, appreciation plus thanks alone is about 3.5% of turns. The script's list ("great point", "I agree with", "thank you", "with respect", "to be fair", "building on") is narrower than "agree/accept", so it should sit nearer that figure.
- For contrast, GPT-4 opened 24% of turns with "absolutely" and another 7.5% with "I couldn't agree more" [MAYOR25].

**Band ≤ 5%**, previously ≤ 1%. The old band was stricter than humans. The engine already sits at 0.3%, so this changes nothing today; it stops the index from punishing a natural "thanks". Confidence: medium-low.

### summaryEndingShare: turns ending on a summary line

- Summarize/reformulate is 0.5% of Switchboard utterances [SWBD00] and 0.09% of ICSI tags [MRDA, read].
- Consensus meta-talk is 0.7% of deliberation thoughts [STROMER07].
- Turns that trail off on "so" are common and are not summaries [SWBD00]. The script counts only "so," and similar openers on the last of three or more sentences, which is closer to a summary.

**Band ≤ 2%**, previously ≤ 5%. Confidence: low.

### openerRepeatShare and recycled4gramShare

**No human measure** for either.
- Humans reuse formulaic openers constantly: 38% of Switchboard backchannels are "uh-huh" and 34% "yeah" [SWBD00], and floor-holders ("well", "so") are 4.65% of ICSI tags [MRDA]. So the opener band (≤ 5%, kept, **assumption**) may be stricter than a real room. Excluding discourse-marker openers from the metric would fix that.
- For repetition, adjacent-turn word reuse in conversation is about 9%, against about 6% expected by chance [HEALEY14]. Model conversations show 1.3-3.3 times human lexical alignment, and it rises over the conversation, which it does not in humans [MAYOR25].
- The 4-gram band (≤ 3%) is kept as an **assumption**.

### emDashPer1k

Spoken transcripts have no authored punctuation. Human written prose runs about 3.2 em dashes per 1,000 words (eight essays, 57k words), against 10.6 for GPT-4.1 [FREEBURG26]. A rate for Opus 5.5 of 0.015 per 1k appears in a blog quoting an analysis I could not open, so it is not used. **Band ≤ 0.5, assumption.** The written-prose figure does not apply to speech.

---

## 6. Balance and chair

### giniTurns: Gini of turn counts across seated experts

| Finding | Setting | Source | Conf. |
|---|---|---|---|
| Word shares by rank in 5-person groups ≈ 0.37, 0.24, 0.17, 0.12, 0.09 (read from Fig. 1): **Gini ≈ 0.28** of words | 10 leaderless student groups, 20-min discussions | FAY00 | medium (read from the figure) |
| Inequality of participation 0.28 (turns) and 0.39 (words). If this index is a Gini normalised by n/(n−1), then for n = 3 Gini ≈ **0.19 turns** and 0.26 words. That conversion is my assumption. | 37 three-person teams | CHOI26 | medium raw / low converted |
| Speaking-time shares 15/10/24/35 → **Gini 0.25**; 12/4/38/5 → **0.46**. The authors call the second group "inequitable". | Two 4-student groups | ARCHIBEQUE17 | high, n = 2 groups |
| Gini rises with group size; compare only rooms of equal size | Jury datasets | ROSE20 (abstract only) | low |

**Band 0.15-0.45**, previously 0.25-0.45. Words are more unequal than turns [CHOI26], so a turn Gini of 0.15-0.30 is typical, and a near-zero Gini (strict rotation) is not human. The plan's open question, whether the owner wants a less balanced room, is now answered by the data: yes, mildly. The engine's 0.22 is inside the new band. The classic Bales (1951) and Stephan & Mishler (1952) rank tables were not retrievable. Confidence: medium-low.

### chairWordShare: chair's share of spoken words

| Finding | Setting | Source | Conf. |
|---|---|---|---|
| Lehrer "spoke for just 8 minutes and 10 seconds, or 9 percent of the total time"; 2011-12 primary moderators averaged 19.8% (14-27%) | 2012 presidential debate; GOP primaries | SMARTPOLITICS 2012 | high (quote) |
| Primary moderators 14.7-27.9% (2011); CNN 15.2% vs Fox 31.7% (2015) | GOP primaries | SMARTPOLITICS 2011, 2015 | medium |
| Facilitator ≈ 16% of coded thoughts (324 process thoughts = 31.6% of moderator thoughts, against 6,310 thoughts in all) | Moderated deliberation, groups of 5-12 | STROMER07 | low-medium (derived) |
| An instructor took 10-13% of talk in two 4-student groups | Classroom | ARCHIBEQUE17 | low relevance |

**Band 8-20%**, previously 5-12%. These are time and thought shares, not word shares; moderator turns are short, so the word share is probably a little lower (unverified). The plan's view that "a good chair speaks much less" than 17% is not supported: 17% is a normal facilitator share. 9% is a notably light touch. Confidence: medium-low.

---

## 7. The five tics

`antithesis`, `labelParenthetical`, `closerToRight`, `metaSpeech` and `falsifierJargon` count constructions that this engine's own prompts seeded (`PHASE2-PLAN.md` 1.2). **There is no human baseline** and none was looked for. Their bands mean "rare enough not to be a house style". They are **assumptions** and were left as they were.

---

## Where the evidence is thin

1. **A-B-A exchange rate.** No human number at all. It is the weight-2 metric with the least support.
2. **Everything per turn.** Nearly every rate is converted from DAs, spurts or thoughts, using a DAs-per-turn factor (about 2.4) that itself mixes corpora.
3. **Turn-length percentiles and shares.** No published p10, p90, or under-40 / over-150 shares for meetings; the deliberation figures depend on an assumed exponential shape.
4. **Concession markers.** The coded categories (accept, respect, partial accept) are not the script's regex list.
5. **Chair share** is time or thoughts, and from debates or online deliberation, not boardrooms. No AMI project-manager share and no board-meeting data were found.
6. **Expert panels specifically.** Apart from the FOMC and the deliberation studies, no source studied panels of domain experts arguing a decision. Earnings calls and Supreme Court arguments gave no per-turn statistics.

**The fix for all six.** Run this script's own metric code over the ICSI or AMI meeting transcripts, which are openly licensed, through a small adapter. That produces every number here in the script's own units, including A-B-A, and would replace most conversions. It needs a corpus download, which was outside this task.

---

## References

Keys match the comments in `REALISM_TARGETS`.

- **AMI07** Dielmann, A., Renals, S. (2007). DBN based joint dialogue act recognition of multiparty meetings. ICASSP. https://www.cstr.inf.ed.ac.uk/downloads/publications/2007/dielmann-icassp07.pdf
- **AMI08** Dielmann, A., Renals, S. (2008). Recognition of dialogue acts in multiparty meetings using a switching DBN. IEEE TASLP 16(7). https://www.cstr.inf.ed.ac.uk/downloads/publications/2008/dielmann2008.pdf
- **ARCHIBEQUE17** Archibeque, B., Genz, F., Franklin, M., Franklin, S. V., Sayre, E. C. (2017). Quantitative measures of equity in small groups. PERC. https://arxiv.org/pdf/1711.00053
- **BACHTIGER16** Bächtiger, A., Lindell, M. (2016). "Benchmarking" deliberative quality across sites. Political Communication Report. https://politicalcommunication.org/article/benchmarking-deliberative-quality-across-sites/
- **CANDOR** Reece, A., et al. (2023). The CANDOR corpus: Insights from a large multimodal dataset of naturalistic conversation. Science Advances. https://pmc.ncbi.nlm.nih.gov/articles/PMC10065445
- **CETIN06** Çetin, Ö., Shriberg, E. (2006). Analysis of overlaps in meetings by dialog factors, hot spots, speakers, and collection site. Interspeech. https://www.isca-archive.org/interspeech_2006/cetin06_interspeech.pdf
- **CHOI26** Choi, J., Nixon, N. (2026). Measuring inclusion in interaction: Inclusion analytics for human-AI collaborative learning. arXiv:2602.09269. https://arxiv.org/html/2602.09269
- **FAME** Kirstein, F., et al. (2025). You need to MIMIC to get FAME. arXiv:2502.13001. https://arxiv.org/html/2502.13001
- **FARRAR10** Farrar, C., et al. (2010). Disaggregating deliberation's effects. British Journal of Political Science 40(2).
- **FAY00** Fay, N., Garrod, S., Carletta, J. (2000). Group discussion as interactive dialogue or as serial monologue. Psychological Science 11(6), 481-486. https://www.pure.ed.ac.uk/ws/files/25472528/Psychological_Science_2000_Fay_481_6.pdf
- **FREEBURG26** Freeburg, E. M. (2026). The last fingerprint: How markdown training shapes LLM prose. arXiv:2603.27006. https://arxiv.org/html/2603.27006
- **FUKUDA26** Fukuda, R., et al. (2026). Evaluating LLM abilities for addressee, turn-change, and next speaker prediction in meetings. arXiv:2606.17542. https://arxiv.org/html/2606.17542
- **GASTIL07** Gastil, J., Burkhalter, S., Black, L. W. (2007). Do juries deliberate? Small Group Research 38(3). https://jurydemocracy.la.psu.edu/files/2019/05/DoJuriesDeliberate.pdf
- **GERMESIN09** Germesin, S., Wilson, T. (2009). Agreement detection in multiparty conversation. ICMI-MLMI. https://www-live.dfki.de/fileadmin/user_upload/import/4513_germesin_agree_icmi09-7.pdf
- **HEALEY14** Healey, P. G. T., Purver, M., Howes, C. (2014). Divergence in dialogue. PLoS ONE 9(6). https://pmc.ncbi.nlm.nih.gov/articles/PMC4053332/
- **HELDNER10** Heldner, M., Edlund, J. (2010). Pauses, gaps and overlaps in conversations. Journal of Phonetics 38(4). https://www.diva-portal.org/smash/get/diva2:388247/FULLTEXT01.pdf
- **ISL02** Burger, S., MacLaren, V., Yu, H. (2002). The ISL meeting corpus: The impact of meeting type on speech style. ICSLP. https://www.isca-archive.org/icslp_2002/burger02_icslp.pdf
- **JOVANOVIC06** Jovanovic, N., op den Akker, R., Nijholt, A. (2006). Addressee identification in face-to-face meetings. EACL. https://aclanthology.org/E06-1022.pdf
- **LASKOWSKI12** Laskowski, K., Heldner, M., Edlund, J. (2012). On the dynamics of overlap in multi-party conversation. Interspeech. https://www.isca-archive.org/interspeech_2012/laskowski12_interspeech.pdf
- **LIBERMAN14** Liberman, M. (2014, July 16). More on speech overlaps in meetings. Language Log. https://languagelog.ldc.upenn.edu/nll/?p=13480
- **MAYOR25** Mayor, E., Bietti, L. M., Bangerter, A. (2025). Can large language models simulate spoken human conversations? Cognitive Science 49(9). https://pmc.ncbi.nlm.nih.gov/articles/PMC12401190/
- **MCCARTHY03** McCarthy, M., O'Keeffe, A. (2003). What's in a name? Vocatives in casual conversations and radio phone-in calls. In Corpus Analysis (Rodopi). https://dspace.mic.ul.ie/handle/10395/1693
- **MEADE05** Meade, E. E. (2005). The FOMC: Preferences, voting, and consensus. FRB St. Louis Review 87(2). https://fedinprint.org/item/fedlrv/25664
- **MEDIASUM** Zhu, C., et al. (2021). MediaSum: A large-scale media interview dataset for dialogue summarization. NAACL. https://arxiv.org/pdf/2103.06410
- **MRDA** Shriberg, E., Dhillon, R., Bhagat, S., Ang, J., Carvey, H. (2004). The ICSI Meeting Recorder Dialog Act (MRDA) corpus. SIGDIAL. https://aclanthology.org/W04-2319.pdf
- **MUSI18** Musi, E., Ghosh, D., Muresan, S. (2018). ChangeMyView through concessions. arXiv:1806.03223.
- **OKAMOTO02** Okamoto, D. G., Rashotte, L. S., Smith-Lovin, L. (2002). Measuring interruption: Syntactic and contextual methods of coding conversation. Social Psychology Quarterly 65(1). https://interruptions.net/literature/Okamoto-SPQ02.pdf
- **PARKER88** Parker, K. C. (1988). Speaking turns in small group interaction: A context-sensitive event sequence model. JPSP 54(6). Not read; summarised in O'Bryan et al., ML-SPEAK, arXiv:2411.15405.
- **QMSUM** Zhong, M., et al. (2021). QMSum: A new benchmark for query-based multi-domain meeting summarization. NAACL. https://arxiv.org/abs/2104.05938
- **ROBINSON22** Robinson, J. D., Rühlemann, C., Rodriguez, D. T. (2022). The bias toward single-unit turns in conversation. Research on Language and Social Interaction. https://pdxscholar.library.pdx.edu/comm_fac/111
- **ROSE20** Rose, M. R., Diamond, S. S., Powers, D. A. (2020). Inequality in talk and group size effects. Group Processes & Intergroup Relations. https://doi.org/10.1177/1368430219871620
- **RUHLEMANN24** Rühlemann, C., Barthel, M. (2024). Word frequency and cognitive effort in turns-at-talk. Frontiers in Psychology 15. https://pmc.ncbi.nlm.nih.gov/articles/PMC11186443/
- **SAVOY26** Savoy, J. (2026). Evolution of US oral political language. arXiv:2609.17755. https://arxiv.org/pdf/2609.17755
- **SHRIBERG01** Shriberg, E., Stolcke, A., Baron, D. (2001). Observations on overlap. Eurospeech. https://www.isca-archive.org/eurospeech_2001/shriberg01_eurospeech.pdf
- **SMARTPOLITICS** Ostermeier, E. Smart Politics, University of Minnesota: 2011-12-19, 2012-10-04, 2015-09-17. https://smartpolitics.lib.umn.edu/2012/10/04/romney-makes-the-most-of-his-4/
- **SMITHLOVIN89** Smith-Lovin, L., Brody, C. (1989). Interruptions in group discussions. American Sociological Review 54(3), 424-435. https://www.interruptions.net/literature/Smith-Lovin-AmerSocRev89.pdf
- **STROMER07** Stromer-Galley, J. (2007). Measuring deliberation's content: A coding scheme. Journal of Public Deliberation 3(1), Art. 12. https://delibdemjournal.org/article/331/galley/4742/view
- **SWBD00** Stolcke, A., et al. (2000). Dialogue act modeling for automatic tagging and recognition of conversational speech. Computational Linguistics 26(3). https://arxiv.org/abs/cs/0006023
- **TAN16** Tan, C., Niculae, V., Danescu-Niculescu-Mizil, C., Lee, L. (2016). Winning arguments. WWW. https://arxiv.org/abs/1602.01103
- **THRELKELD22** Threlkeld, C., de Ruiter, J. P. (2022). The duration of a turn cannot be used to predict when it ends. SIGDIAL. https://aclanthology.org/2022.sigdial-1.35.pdf
- **WANG25** Wang, P., et al. (2025). Predicting and understanding turn-taking behavior in open-ended group activities in virtual reality. CSCW. https://arxiv.org/abs/2407.02896
- **YUAN06** Yuan, J., Liberman, M., Cieri, C. (2006). Towards an integrated understanding of speaking rate in conversation. Interspeech. https://www.ldc.upenn.edu/sites/default/files/interspeech2006-towards-integrated-understanding.pdf
