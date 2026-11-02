# Debate evaluation rubric

A judge (a person, or a model given the prompt from `npm run eval -- <id> --judge`)
scores one saved debate on 15 criteria in three groups. Every criterion is 1-5
with anchored descriptions. Score from the transcript and rulings only; quote the
turn that justifies each score. If the evidence is missing, score `null`, not 3.

Rules for the judge:

- Anchor on the descriptions, not on a general feeling. 3 is "competent, ordinary"; 5 is rare.
- Do not reward length, polish or agreement with your own view.
- Do not reward cost. Quality only.
- One quote per criterion, 25 words max, with the turn id or speaker. No quote, no score above 3.
- The offline metrics are given to you as context. They are proxies: a regex cannot tell a sincere concession from a voiced one. Override them when the text disagrees, and say so.

## A. Realism (does it sound like a room of people?)

### A1. Turn-shape variety
- 1: Every turn is a memo of similar length and structure; a queue of speeches.
- 2: Occasional short turn, but the pattern (long, long, long, chair) is obvious.
- 3: Mixed lengths; some one-liners and some set pieces, but shape is predictable.
- 4: Clear variety: one-word reactions, questions, set pieces, fragments; length follows what the moment needs.
- 5: Shape is never guessable from the previous turn; short turns land with weight, long ones are earned.

### A2. Interruptions and overlap
- 1: Nobody interrupts; strict turn-taking.
- 2: One or two token interjections, all polite and complete.
- 3: Interruptions exist but are gentle or always yielded to; feel scheduled.
- 4: Cut-offs and talking-over happen where the argument heats up, and the cut speaker reacts.
- 5: Interruptions are motivated by content, change what is said next, and are not evenly spaced.

### A3. Concessions with cause
- 1: Nobody ever changes ground, or everyone agrees at once with no reason.
- 2: Concessions are bare ("fair point") with no cause stated.
- 3: Some concessions name a reason, some are filler; positions rarely move.
- 4: Concessions cite the specific fact or argument that moved the speaker, and later turns reflect it.
- 5: Position changes are traceable to a cause, are partial where honest, and some experts visibly refuse to move.

### A4. Persona consistency
- 1: Experts are interchangeable voices; style and biases do not show.
- 2: Names differ but registers and priorities are the same.
- 3: Roles are visible in content; voice is mostly uniform.
- 4: Each expert's register and bias is recognisable with names covered.
- 5: Names covered, each speaker is identifiable; biases are owned out loud and drive real disagreement; no one drifts out of character.

### A5. No AI-sounding filler
- 1: Praise openers, "great point", em-dash chains, "it's not X, it's Y" antitheses, tidy summary closers throughout.
- 2: Frequent tics; several turns end on a bow-tying line.
- 3: Some tics and repeated openers; mostly clean.
- 4: Rare tics; openers and phrasings vary; nothing reads as template.
- 5: No detectable template phrasing; repetition between turns is deliberate (a person returning to their point).

## B. Substance (is the decision better for having had this debate?)

### B1. Cruxes identified
- 1: Experts talk past each other; no disagreement is named.
- 2: Disagreement exists but nobody says what it hinges on.
- 3: The chair or an expert names the crux for some motions.
- 4: Each motion's crux is named, and the debate then works on that crux.
- 5: Cruxes are named, tested, and the ruling says what evidence would flip it.

### B2. Evidence quality and citations
- 1: Assertions only; invented-sounding authority, or a panelist's own anecdote ("my head baker quit") treated as evidence about the founder's business.
- 2: Some sources named but vague ("studies show").
- 3: Claims are tagged with grade (measured, observed, assumed, persona) but sources are thin.
- 4: Load-bearing claims carry a source or a stated basis, and assumed claims are labelled assumed.
- 5: Every load-bearing claim is traceable; the room challenges weak sources and the ruling grade reflects that.

### B3. Numbers checked
- 1: Figures are stated and left unverified; some are wrong or inconsistent.
- 2: Figures are stated with no derivation.
- 3: Some figures derived on the table; others unchecked.
- 4: Load-bearing figures are computed or audited; errors found are corrected in the room.
- 5: Every figure that moves a ruling is reproducible from stated inputs, and unit or base-rate traps are caught.

### B4. Dissent preserved
- 1: Rulings show unanimity; objections vanish.
- 2: Dissent is mentioned but not recorded in the ruling.
- 3: Dissents recorded but generic.
- 4: Dissents are specific, attributed, and carry their reasoning.
- 5: The ruling states what the dissenter would do differently and what would prove them right.

### B5. Decision usefulness
- 1: No decision, or a restatement of the topic.
- 2: A direction with no owner, scope or next step.
- 3: A decision with an owner, but no condition for stopping or revisiting.
- 4: Decision, named owner, evidence grade, first action, and what is undecidable.
- 5: A founder could act tomorrow; it states the trial, the stop rule, who owns it, and what to measure.

## C. Fairness (was the outcome earned, not arranged?)

### C1. No stacked panel
- 1: Panel is all one side or one discipline; the opposing view has no seat.
- 2: A token opponent who is outmatched.
- 3: Both sides seated; one is clearly stronger or louder.
- 4: Balanced seats and balanced airtime; each side gets its best case.
- 5: The strongest objection to the eventual ruling is held by an able expert and was heard.

### C2. Balanced airtime
- 1: One or two experts hold nearly all words; seats stay silent.
- 2: Heavy skew; a seat speaks only when called.
- 3: Moderate skew that matches roles.
- 4: Airtime follows relevance, each seat contributes.
- 5: Airtime is uneven only where the topic justifies it, and silence is purposeful.

### C3. Steelmanning and chair neutrality
- 1: The chair leads the room to a conclusion; opposing views are strawmanned.
- 2: The chair favours one side's framing.
- 3: Neutral but passive.
- 4: The chair presses both sides equally and restates opposing views fairly.
- 5: Experts restate each other's case in terms the other would accept before rebutting.

## Scoring

Per group, report the mean of non-null scores. Report `overall` as the mean of
the three group means. Do not weight by cost. A debate with any criterion at 1
in group B or C is flagged `blocking`, whatever the mean.

## Pairing with offline metrics

| Rubric item | Offline proxy (scripts/transcript-metrics.ts) |
|---|---|
| A1 | words.cv, shortTurnShare, memoTurnShare, multiParagraphShare |
| A2 | interruptionRate, overlapRate, pingPongRate |
| A3 | concessionPer100, positionChangePer100, expertsConcedingShare |
| A4 | none (judge only) |
| A5 | fillerTurnShare, tics, emDashPer1k, summaryEndingShare, openerRepeatShare, recycled4gramShare |
| B1 | guards.meanTopRung, guards.freshPerCheckpoint |
| B2 | evidence grade mix in rulings, graded claims (eval substance signals) |
| B3 | figures stated vs figures near a derivation cue (eval substance signals) |
| B4 | guards.dissents, guards.defeatersLanded |
| B5 | rulings with owner, evidence grade, stop rule (eval substance signals) |
| C1 | none (judge only; panel list is in the prompt) |
| C2 | giniTurns, giniWords, silent seats, chairWordShare |
| C3 | addressesChairShare (partial), judge |
