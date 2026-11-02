# Phase 2 plan: the realism engine

**Date:** 2026-10-26
**Status:** plan only (Phase 2a). No feature code. The one piece of code is the offline metrics script, `scripts/transcript-metrics.ts`.
**Inputs read:** `docs/PHASE1-REPORT.md`, `ARCHITECTURE.md`, `CONTRACT.md`, `ROADMAP.md`, `shared/*.ts`, `server/src/engine/{runner,motions,transcript,mock}.ts`, `server/src/agents/{prompts,sdk,openai,codex}.ts`, and the 8 imported debates in `./data`. Three transcripts were read end to end (a 7-turn go-to-market session, a 78-turn fundraising-memo session, a 162-turn personal career session); the other two long ones were read through the metrics script and spot checks.
**Method:** gstack `/office-hours` (forcing questions) then `/plan-eng-review` on the draft. Both ran in **degraded mode**: the Skill tool returned an error for both skills, so their `SKILL.md` files were followed by hand. Every step that would contact an outside service (Aside web research, the Codex second opinion, telemetry) was skipped, as the brief forbids it. The outside-voice step used a local Claude subagent instead. Questions the skills would have asked the owner were answered from the owner decisions in the brief; the answers are recorded in Appendix A and in the review report at the end.

**Privacy note.** The imported transcripts contain personal and commercial material. This document is going into an open-source repository, so every quote below has names replaced by roles (`[investor]`, `[buyer]`, `[the company]`) and figures that identify a business removed. The metrics script prints debate ids, not titles, unless `--titles` is passed. `data/` is never committed.

---

## Contents

1. Diagnosis: what reads as artificial, with evidence and baseline numbers
2. Design
   - 2a Persona dossiers
   - 2b Floor dynamics
   - 2c Belief ledger and concessions
   - 2d Boardroom stakes
   - 2e Realism linting
   - 2f The evidence loop
3. Provider-neutral research tool
4. Cost and quota budget
5. Evaluation harness and mock engine
6. Notifications and Remotion removal
7. Implementation order (2b-0 … 2b-9), acceptance tests, and the real runs that need approval
8. Risks, unknowns, and what was cut
9. Top-10 decisions

Appendix A: office-hours record. Appendix B: metric definitions. Appendix C: data model summary. Final section: GSTACK REVIEW REPORT.

---

## 1. Diagnosis

### 1.1 Baseline numbers

Computed with `npx tsx scripts/transcript-metrics.ts` over the imported database (read-only). The pooled baseline covers the four debates with at least 20 expert turns (716 expert turns), weighted by turns. Definitions are in Appendix B and next to the code.

| Metric | Baseline | What a real room looks like (initial target band, to calibrate) |
|---|---|---|
| Words per expert turn, mean | **160** | heavy-tailed: many 3-15 word turns, a few 150-word set pieces |
| Words per turn, coefficient of variation | **0.21** | ≥ 0.8 |
| Words per turn, p10 / p90 | **125 / 199** | p10 ≤ 12, p90 ≥ 120 |
| Turns under 40 words | **0%** | 30-50% |
| Turns over 150 words | **65%** | ≤ 15% |
| Multi-paragraph turns | **69%** | ≤ 15% |
| Interruptions per 100 expert turns | **5.5** (0 in three of four debates; 24 in one) | 8-20 |
| True overlap (talking over) | **0, not representable in the event log** | 5-12 per 100 |
| A-B-A exchanges (same two people trading turns) | **2.5%** of turn triples | 15-35% |
| Turns containing a question | **1-3%** in the three sessions without the founder in the hot seat (30% in the one with him) | ≥ 25% |
| Turns addressing the chair by name | **25%** | ≤ 10% |
| Concession markers per 100 turns | **21** (84% of experts concede at least once) | 5-12 |
| Explicit position changes per 100 turns | **3.6** | 3-8, with ≥ 80% traceable to a cause |
| Praise/agreement filler | **0.3%** of turns | ≤ 1% (already fine) |
| Em-dashes per 1k words | **0.02** | ≤ 0.5 (already fine: the prompt ban works) |
| Turns ending on a summary line | **7%** | ≤ 5% |
| Turns sharing a 3-word opener with 2+ others | **14%** | ≤ 5% |
| 4-grams recycled from earlier turns | **3.8%** | ≤ 3% |
| Speaker balance Gini (turns / words) | **0.22 / 0.23** | 0.25-0.45 |
| Chair share of spoken words | **17%** | 5-12% |
| Tic: "X is not A, it is B" | **22 per 100 turns** | ≤ 5 |
| Tic: spoken evidence label "(observed, from …)" | **31 per 100 turns** | ≤ 3 |
| Tic: "[Name] is closer to right" | **6 per 100** (19 openers in one debate) | ≤ 1 |
| Tic: speech about one's own speech ("I'll say it plainly", "out loud", "I'll name the cost") | **8 per 100** | ≤ 2 |
| Tic: position-card jargon spoken aloud ("my falsifier has not fired") | **6 per 100** (11 in one debate) | ≤ 1 |

Other measured facts used below:

- All 39 interjections in the corpus are complete, grammatical turns of 45-100 words (median 66), and every one ends on sentence punctuation. The prompt asks for "one or two sentences".
- All 31 closing statements contain "would change my mind" or an equivalent, because the closing prompt asks for exactly that.
- Research lands as a message with a median of 320 words, inserted between turns.
- The founder answered 57 questions across the corpus; `transcript.md` contains none of them, because `DebateRun.answer()` publishes the event and never calls `appendTranscriptFile`. The readable record shows experts reacting to answers that are not there.
- The 170-word "too long" retry fired on 49 of 120 floor turns in one session, each an extra flagship call.
- Past spend: 147-445 agent turns and $13-$53 (CLI-reported, API-equivalent) per completed or near-completed session; 0.27M-0.85M output tokens; 1.7M-6.9M cache-write tokens; 6.6M-29M cache-read tokens.

The human reference bands are from memory of published meeting-corpus work (multi-party meetings have many short turns, frequent overlap at contested moments, unequal participation). They were not verified in this phase (no web access allowed) and are labelled as starting targets to calibrate, not facts.

### 1.2 What reads as artificial, with evidence

**1. Every turn is a memo.** Zero turns under 40 words; two thirds over 150; most are two or three paragraphs. A typical turn opens with a name, grants the other side, attacks, attaches a credential, and hands a request to the chair:

> "[Investor] is closer to right, and [engineer]'s own proposal is why. [Engineer], you want CPVO measured on real production traffic, but production traffic is not an engineering purchase, it is a procurement event. To touch a bank's live inference you clear a DPA, a security questionnaire, a subprocessor disclosure, and … (observed, from eleven agent pilots I sat on the buying side of: median time from handshake to production traffic was two to three quarters …)"

Nobody in 716 turns says "No." or "Which base?" or "Hang on." Engine cause: every floor turn is one flagship call with 24K thinking, briefed "you have the floor"; the only length control is an upper bound (the 170-word retry); nothing ever asks for a five-word turn.

**2. Interruptions are scheduled and polite.** In three of the four long debates there are none. In the fourth, the chair picks the interrupter *before* the round (`cut_in` in the steer JSON), the cut-in fires after its target has finished, and it is a full paragraph. Nothing is ever cut off mid-sentence, and the event log cannot express overlap at all (`message` has no notion of it, and `Hub` keeps one partial message per debate).

**3. The prompts' own words became the room's dialect.** This was the biggest surprise. Phrases in the prompts reappear as tics in every voice:

| Prompt text (file) | What the room says |
|---|---|
| Opening floor direction: "Say which one is closer to right and why" (`motions.ts` `openingFloor`) | "[Name] is closer to right, and …" opens 19 turns in one debate, 8 in another |
| "label every claim … Say the word out loud" (`MEETING_RULES`) | "(observed, from nine years of …)" in 31 of every 100 turns |
| "name which one it was, out loud, say what broke it, and say what that costs you" (`positionCardBlock`) | "I'll name the cost", "my own claim just broke", "that costs me …", "my falsifier has not fired" |
| "Your biases (own them…)" (`positionCardPrompt`, `expertSystem`) | "I'll own my bias out loud", "I'll say it against my own book" |
| Closing prompt: "the ONE thing that would change your mind" | 31 of 31 closings use it; "would change my mind" is a top 4-gram (16 turns) |

Cloning across voices is visible turn by turn. Three consecutive speakers in one session, three different personas:

> "What everyone is missing is that the wall is not a legal artefact, it is a headcount artefact …"
> "What everyone is missing is what desk one now measures …"
> "What everyone is missing is that [the other expert]'s clause is the whole thesis …"

And the dominant construction, the antithesis, in 22 of every 100 turns: "Fourteen percent is not a reserve, it's a hope." "Production traffic is not an engineering purchase, it is a procurement event." "That's not a hypothetical, that's the exact seam [name] just cut along." One mind with one style guide is speaking through every seat. Filler praise and em-dashes, the usual tells, are already near zero; the tells moved to structure.

**4. Concession is a ritual, not a cost.** Concessions are not missing; they are everywhere (21 per 100 turns, 84% of experts) and free:

> "Concession first, Marcus, because you earned it: my two-to-three quarters is a bank number and I have been pricing the whole world off it."
> "[Name], I'll take your case at its strongest and it still breaks on my side of the wall."
> "Withdrawn as pricing."

Nobody gets defensive, nobody digs in past reason, nobody loses face, nobody is irritated at being wrong, and nobody's position costs them anything. Thesis-level changes are rare (3.6 per 100) and, when they happen, they are announced in the position-card's own vocabulary rather than lived.

**5. Everyone talks to the chair, and the chair runs a queue.** A quarter of expert turns address Marcus by name, often to route a request ("Marcus, get the desk to pull …"; in one session three experts in a row ended this way and the chair replied "Three of you have now asked me to pull data [the company] does not appear to have instrumented"). Two people almost never go back and forth (A-B-A 2.5%). The chair speaks every round with a near-fixed rhetoric: "I want" opens or appears in 55 of 191 chair turns, "you go first" 12, "I am putting it to you in writing" 13 in one session, "rather than admired" 4. Chair share of words is 17%; a good chair in a real room speaks much less.

**6. Almost no questions.** In the three sessions without the founder in the hot seat, 1-3% of expert turns contain a question mark. The one session where experts interrogated the founder (30% questions, 24 interruptions per 100) is the one that reads most like a real room. Pressure on a person with something at stake produced the realism; the engine did not.

**7. No stakes, no clock, no owner.** The room has nothing to lose. Rulings default to "Owner: Founder". No expert has an incentive that a ruling would hurt. Money and people at risk are never stated unless the founder's files happen to state them. A short session ends with "We are at time" when no clock exists, and with a ruling that reads "Undecidable in session: the ruling could not be recorded."

**8. Symmetry everywhere.** Every motion opens FOR, AGAINST, "which is closer". Every round is three slots, then the referee, then the chair. Every closing is "My position … The one thing that would change my mind is …". Every expert is roughly equally present (Gini 0.22).

**9. Personas are a costume over one voice.** A persona is a 2-4 sentence bio, a one-line bias and a one-line style. Summoned experts arrive generic and already using the house tic: "I've bought infrastructure from startups and killed plenty of deals too. The bottleneck isn't the eval harness, it's team credibility."

**10. Evidence is real but arrives as a dump.** Research is a 320-word brief between turns; experts then cite "the desk" as an authority ("Not fundable today, and the desk already settled it"). Only the quant desk has a live loop (a request, a wait, a number, the requester answering it). OpenAI and Codex debates have no research at all.

What already works and must not be lost: the shared byte-identical cache prefix, position cards written blind, the referee's depth ladder, the adversary desk, the quant desk's live loop, the numbers audit, and the ruthless honesty of rulings. The realism engine is built on top of these, not instead of them.

---

## 2. Design

### 2.0 Shape of the change

The current engine decides speech content and floor order in the same expensive calls. The plan separates them:

```
                 ┌───────────────────────── referee checkpoint (Opus/Astra, every 6-8 spoken turns) ──┐
                 │  rung, dodges, unresolved, herd moves, unsupported numbers, drift                  │
                 ▼                                                                                     │
 FloorDirector (pure TS, seeded) ── picks next speaker + turn shape + word budget ──┐                  │
   state: heat, owed answers, duel, clock, tic budgets, belief ledger              │                  │
                 ▲                                                                  ▼                  │
                 │                                   generate (flagship for set pieces and replies,   │
                 │                                   fast tier for reactions) ── trailer stripped ──┐  │
                 │                                                                                  ▼  │
                 │                         lint (rules, then fast-tier rewrite if needed, verified)    │
                 │                                                                                  │  │
                 │                         reaction call (fast tier): listeners' intensity per sentence│
                 │                                                                                  ▼  │
                 └──────── perform: paced deltas, cut-offs, overlap, pauses ── persist events ───────────┘
```

Three tiers do three jobs: flagship models think and argue; fast models react, rewrite and classify; plain TypeScript decides who speaks and when, deterministically, so it can be tested without a model.

### 2a. Persona dossiers

**Problem it fixes:** items 3, 8, 9 (one voice in many costumes; no incentives; generic summoned experts).

**Data model** (new `shared/realism.ts`, re-exported from `types.ts`):

```ts
export interface Dossier {
  personaId: string;
  /** What the room knows. Goes in the shared, cached roster. */
  publicReputation: string;              // one or two sentences
  /** Everything below is PRIVATE: only in this expert's own per-turn suffix. */
  history: { when: string; what: string; lesson: string; kind: 'failure' | 'win' }[]; // 2 failures, 1-2 wins
  incentives: string[];                  // what they personally gain or lose under each outcome
  priorPublicStance?: string;            // something they said in public they would have to walk back
  biases: { name: string; showsUpAs: string }[];
  blindSpots: string[];
  stubbornness: number;                  // 0..1, a trait (see 2c)
  temperament: { heatGain: number; heatDecay: number; interruptThreshold: number; dominance: number };
  speech: {
    register: 'clipped' | 'plain' | 'technical' | 'storyteller' | 'socratic' | 'combative' | 'dry';
    typicalWords: number;                // their natural set-piece length, 40-160
    vocabulary: string[];                // 5-8 words they actually use
    tics: { text: string; maxPerMotion: number }[]; // 1-2, budgeted
    neverSay: string[];                  // includes the global banned list automatically
  };
  underPressure: string;                 // "gets more technical", "goes quiet then comes back hard", ...
  relationships: { with: string; kind: 'ally' | 'rival' | 'history' | 'respect'; note: string }[];
}
```

`Persona` stays as it is (the UI contract does not move); dossiers live in `meta.dossiers` keyed by persona id. Old debates have none and run exactly as today.

**Engine and prompt changes**

1. After panel approval and before position cards, one call per expert on the balanced tier (new seat `persona`, Sonnet 5.5 / GPT-6.1 Sol), in parallel, writes the dossier from the persona, goal, topic and (fenced) dossier brief. Then one balanced-tier `relationships` call reads all public reputations and adds two or three relationships per expert (who has history with whom). The relationship pass sees only public parts, so private convictions stay independent.
2. A deterministic **diversity check** runs on the result: registers distinct across at least 70% of the panel; `typicalWords` max/min ≥ 3; pairwise vocabulary overlap (Jaccard) ≤ 0.2; at least one expert with stubbornness ≤ 0.35 and one ≥ 0.7; at least two pairs whose incentives point opposite ways on the goal. Offenders are regenerated once. No ethnic or national speech caricature: register and tics come from profession and temperament, and the generation prompt says so.
3. The cached roster in `buildRoomBlocks` gains each expert's `publicReputation` (constant all session, so cache-safe). The private parts ride in the speaker's suffix as a compact **voice card** of about 250 tokens: register, vocabulary, the tic and whether it is spent this motion, `neverSay`, under-pressure behaviour, the two incentives most relevant to the current motion, and their current belief (2c).
4. Position cards are written from the dossier (incentives and history now drive the thesis), unchanged otherwise.
5. Summoned experts get a dossier from the same call shape (one balanced call) before their entrance line.
6. Prompt de-seeding: no prompt may contain a phrase the room is not supposed to say. The rewritten prompts describe behaviour ("answer the person, not the chair") instead of scripting words ("say which one is closer to right"). A selftest asserts that the banned-phrase list does not appear in any prompt builder's output.

**Failure modes and guards**

- *Caricature* (a tic every turn): tic budgets per motion, counted by the linter (2e).
- *Dossiers converge* (same generator): the diversity check; metrics show opener and 4-gram sharing per persona.
- *Invented history is taken as real*: personas are fictional by rule, the report says so, and no real living person may be named as a persona.
- *Private incentive leaks into the shared prefix and breaks the cache*: a unit test asserts the system prompt is byte-identical for every caller within a checkpoint, with dossiers present.
- *Cost*: N + 1 balanced calls once per session; about $0.15-0.30 for five experts (estimate).

### 2b. Floor dynamics

**Problem it fixes:** items 1, 2, 5, 6, 8.

**The core idea: generate, then perform.** A flagship turn is generated in full (streamed into a buffer, not to the screen), linted, run past the listeners, and then *performed* to the room: deltas emitted at speaking pace (about 2.5 words a second, compressible), with cut-offs, overlap and pauses placed on that timeline. Because the whole turn exists before it is heard, the engine can stop it mid-sentence, have someone talk over it, and later let the speaker resume with the words they were actually going to say, at no extra model cost. While turn *k* is performed, turn *k+1* is generated, so wall time per turn is roughly max(generation, performance) instead of their sum.

Two rules make this safe with the event log as the source of truth (review findings 3 and 4):

- **Publish when performed, not when generated.** `Hub.publish` broadcasts the full `message` immediately and the web reducer puts it straight into the feed, so a turn's `message` event is persisted only when its performance ends, and it carries only the words actually spoken. Turn *k+1* is generated against an **in-memory projection**: the persisted events plus the performed-so-far text of pending turns, passed to `buildRoomBlocks` instead of `Events.since(id, 0)`. A test asserts that the prompt for *k+1* contains exactly the performed text of *k*, and nothing of its unsaid remainder.
- **The unsaid remainder never enters an event.** A cut turn's remaining text lives only in the server-side pending-turn record in `meta` (field `unspoken`). If the speaker resumes, the resumed words are a new `message`. Nothing that reads events (the shared prefix, `numericClaims`, the report material, `transcript.md`, the PDF, the metrics script) can see words nobody said.

**Turn shapes.** The `FloorDirector` picks a shape and a word budget before each call:

| Shape | Words | Model | Thinking | When |
|---|---|---|---|---|
| set piece | 60-160 (persona's `typicalWords`) | flagship | 6-12K by profile | new mechanism or evidence, opening a motion, answering a defeater |
| reply | 12-60 | flagship | 1-2K | answering a direct question or attack, pressing a dodge |
| reaction | 2-15 | fast, **produced by the reaction call itself** (no separate call) | none | cut-ins, backchannel ("On what base?", "No."), short pushback |
| chair | 10-50 | flagship | 2K | only on a trigger (below) |

Target mix: about 25% set pieces, 40% replies, 35% reactions. That alone moves the length CV from 0.21 toward 1.

**Director state** (persisted in the motion checkpoint so a restart resumes it):

```ts
interface FloorState {
  motionId: string;
  clock: { elapsedSec: number; slotSec: number };        // the meeting clock (2d)
  heat: Record<string, number>;                           // 0..1 per expert
  lastSpoke: Record<string, number>;                      // spoken-turn index
  owed: { from: string; to: string; question: string; messageId: string; presses: number }[];
  duel: { a: string; b: string; exchanges: number } | null;
  ticUse: Record<string, Record<string, number>>;
  interruptions: number;
  pending: PendingTurn[];                                 // pre-generated, not yet performed (survives restart; never re-paid)
}
```

**Speaker selection** is a scored, seeded choice over experts: owed an answer (very high), addressed in the last turn, heat, a crux of theirs at stake (from the belief ledger and the reaction call's `wantsFloor`), silence bonus for someone quiet whose crux is on the table, minus recency and minus "already holds the floor too much". Duels are allowed for up to four exchanges when both parties have heat above 0.5 and an open disagreement in the ledger; then the director brings in a third voice or the chair. This replaces the per-round chair slate.

**The reaction call** (fast tier, one per set piece, plus one per reply the director marks contested; never per reaction). It runs **after** the lint step on the final text, never in parallel with it, so its sentence indices point at the words that will actually be performed. Input: the utterance split into numbered sentences, plus a short listener card per expert (stance, crux, red line, heat, temperament, voice card). Output, strict JSON:

```json
{"reactions":[{"listener":"ana","intensity":0,"atSentence":2,"cutIn":"Inside month two? On what base?","backchannel":null,"wantsFloor":true,"why":"disputes the payback base"}]}
```

The director, not the model, decides what happens. A listener interrupts when `heat + 0.25 * intensity ≥ interruptThreshold`, the speaker has finished at least one sentence, the speaker is not the founder (the founder is never interrupted), and the motion is under its interruption cap (3-6 by profile). The cut is placed 60-80% of the way through the target sentence, so the partial utterance is visibly mid-thought ("The payback lands inside month—"). The cut-in is performed overlapping the last few words. Then a floor fight resolves by `dominance` and heat: the speaker either takes it back ("Let me finish.") and resumes the pre-generated remainder, or yields and the interrupter gets a reply turn that must address the point. A cut turn's unsaid claims are never lost: the remainder is either performed later or listed as "unspoken" for the referee.

**Heat.** Rises when a listener is named in an attack, when a number they dispute is repeated, when their red line is approached, when they are cut off; decays per turn by temperament. Above 0.85 the chair intervenes ("Enough. [Name], finish your point.").

**Pauses and silence.** A `pause` event (1-6 seconds on the performance timeline) after a hard concession, after a direct question that goes unanswered, and after a chair intervention. An unanswered question becomes an `owed` entry; the next speaker selection strongly favours the person who owes it, and after two presses the chair names the dodge.

**Side whispers.** A rare `aside` (at most one per motion, deep profile only by default) between two allies, generated by the reaction call. It is its **own event type**, not a `message`, because `formatEvents` renders every `message` into the shared prefix (`SPOKEN_TYPES` in `transcript.ts`). The founder sees it (rendered as a whisper); the shared record, `numericClaims` and the report material never contain it; only the recipient's suffix does. A test asserts no aside text appears in `room.system` or `roundSoFar` for any other seat.

**Chair on trigger.** Marcus no longer speaks every round. He speaks when: the referee flags a dodge pressed twice; heat crosses 0.85; the ledger shows a herd move without new evidence; the clock hits a milestone; a quiet expert's crux is at stake; the argument drifts off the motion; a ruling is due. Target chair word share 5-12%.

**Event contract** (additive; old clients and old debates unaffected; the web reducer already ignores unknown types):

```ts
// on the existing 'message' event, all optional:
shape?: 'set_piece' | 'reply' | 'reaction' | 'chair';
to?: string[];                                   // addressees
cutOff?: { atChar: number; by: string; resumedBy?: string /* message id */ };
overlap?: { with: string /* message id */; fromChar: number };
lint?: { score: number; rewrote: boolean; rules: string[] };   // for the eval harness, not shown
claims?: { text: string; grade: EvidenceGrade }[];             // evidence labels, moved out of speech (2e)
// kind gains 'reaction'; text is always the spoken words only
// new events:
| (Ev<'aside'> & { id: string; from: string; to: string; text: string })   // never rendered into any shared record
| (Ev<'pause'> & { ms: number; reason: 'after_concession' | 'unanswered' | 'tension' | 'chair' })
| (Ev<'floor'> & { motionId: string; heat: Record<string, number>; handsUp: string[]; clock: { elapsedSec: number; slotSec: number } }) // checkpointed, not per turn
```

The SSE `Hub` changes from one partial message per debate to a map of partials per message id, and so does the web client: `web/src/lib/stream.ts` holds a single `streaming` message and replaces it when a delta with another id arrives, so it gets a per-id map too, plus explicit handling of `reaction` messages and `aside` events (a `message` of an unknown kind is not ignored by the reducer; it is added to the feed). Both are needed for two overlapping streams to survive a browser refresh. `formatEvents` renders a cut turn as "… inside month— [cut off by ANA]" and an overlap as "ANA (over KABIR): …", so the room's own record reads like a real one.

**Failure modes and guards**

- *Theatre over substance* (interruptions eat arguments): unsaid remainders are kept; caps per motion; decision-quality guards in the eval harness (rung reached, defeaters, dissents) must not fall.
- *Reaction model picks silly cut points*: the director clamps (never before sentence one, never the founder, cap per motion, minimum gap of three turns between interruptions by the same person).
- *Performance feels slower than raw streaming*: pipelining; a "skip ahead" control in Phase 3; profile-level pace factor.
- *Restart mid-performance*: pending turns are persisted before performance and re-performed, never regenerated.
- *Two streams break the partial buffer*: the per-message partial map, with a refresh test.

### 2c. Belief ledger and concessions

**Problem it fixes:** item 4 (concession as ritual), plus a new report section "how minds changed".

**How beliefs are captured, at no extra call.** Floor turns already carry an optional hidden final line (`COMPUTE: …`, stripped by `splitDeskCall` before anyone reads the turn). This generalises into a **turn trailer**: a block of trailing lines with known keys, stripped before lint, performance and persistence of the spoken text:

```
STANCE: for+1 | confidence: medium | crux: first-cohort churn under 3%
CLAIMS: [observed] eleven pilots ran two to three quarters to production; [assumed] the AI-native buyers move faster
ASK: kabir | Which base is that payback on?
COMPUTE: …
RESEARCH: …
```

Stance is a five-point scale (`against-2 … for+2`) with three confidence levels; coarse on purpose, because finer numbers would be noise. While streaming (before the director exists, in 2b-3), a stream filter holds back any line that starts with a trailer key so it never flashes on screen; today a `COMPUTE:` line does briefly appear and then vanish.

**Data model:**

```ts
export interface Belief {
  expert: string; motionId: string;
  stance: -2 | -1 | 0 | 1 | 2; confidence: 'low' | 'medium' | 'high';
  crux: string; reasons: string[]; sinceSeq: number;
}
export interface Concession {
  motionId: string; expert: string;
  from: { stance: number; confidence: string }; to: { stance: number; confidence: string };
  kind: 'full' | 'partial' | 'conditional' | 'tactical';
  movedBy: { kind: 'evidence' | 'computation' | 'argument' | 'falsifier' | 'founder' | 'social' | 'unexplained'; ref?: string; who?: string };
  cost: string;            // what they gave up: a red line, a prior public stance, a budget line, face
  messageId: string;
}
// new persisted events: 'belief' (on motion open, the starting stances) and 'concession'
```

At motion open, each expert's starting stance comes from their first turn's trailer; before they speak, it is derived from the position card by one fast-tier "clerk" call for the whole panel (classification, not argument). A `concession` event is emitted when an expert's stance moves by one or more points; `movedBy` is filled from the trailer's references or by the referee at the next checkpoint. The referee also audits stated against revealed belief ("says against, argues for").

**Stubbornness** is a trait from the dossier. It is enforced socially, not by clamping text after the fact: the voice card states it ("you need a computed number or your falsifier before you move on your thesis"), and when an expert with high stubbornness moves without a recorded cause, the move is logged as `movedBy: unexplained` and becomes a chair trigger ("You folded quickly, [name]. What moved you?"). That is what a real room does.

**Courtesy concessions** (concession language with no stance change, the "you're right that …" reflex) are flagged by the linter and rewritten out unless the trailer shows a real move. Target: concession markers 5-12 per 100 turns, of which at least 80% are backed by a ledger move with a cause.

**Herding**: if three or more experts move toward the same side within one checkpoint with no evidence or computation event in between, the referee flags it and the chair attacks the consensus. This replaces part of the old contrarian logic with a measured trigger.

**Failure modes:** experts forget the trailer (carry forward the last stance; the referee fills gaps); stances become arbitrary numbers (coarse scale; referee audit); everyone drifts to the middle (polarisation over time is a tracked metric and a chair trigger); the ledger leaks into the shared prefix (it never does; each expert sees only their own belief, and the room sees only spoken words).

### 2d. Boardroom stakes

**Problem it fixes:** item 7.

**Data model:**

```ts
export interface Stakes {
  decisionOwner: { name: string; role: string };     // default: FOUNDER_NAME / "the founder"
  decideBy: string;                                  // a date or an occasion ("board meeting on 12 Nov")
  atRisk: { money?: string; people?: string; time?: string; reputation?: string };
  ifWrong: { yes: string; no: string };              // cost of a wrong yes, cost of a wrong no
  reversibility: 'one-way' | 'two-way';
  source: 'founder' | 'dossier' | 'assumed';         // stakes are never invented silently
}
```

**Engine and prompt changes**

1. **Intake extracts stakes.** The intake JSON gains a `stakes` object; missing pieces become clarify questions ("What is at risk if this goes wrong: money, people, or time?"), or in autonomous mode an `assumption` event. Stakes appear beside the goal at approval.
2. **A STAKES block in the cached constants** of the shared prefix (constant per session, so the cache holds).
3. **The meeting clock.** Each motion gets a time slot of fictional meeting time. Speech advances it by words at speaking pace, pauses by their length, research waits by a fixed amount. The clock rides in each speaker's suffix ("fourteen minutes into a twenty-minute slot"), never the prefix. The chair announces milestones; when the slot runs out the motion goes to ruling with close reason `time` (a new value next to `merits`, `stuck`, `ceiling`, `ended`). **The slot is derived from the profile's turn cap**, not chosen separately: slot = (turn cap ÷ motions) × the mix's average words per turn (about 42) ÷ 2.5 words a second, plus pauses. With that rule the clock and the turn cap bind at the same moment, so "we are out of time" is literally true and the meeting ends for a reason the room can say aloud. (The first draft fixed slots at 10/15/30 minutes, which the turn cap would always have beaten.)
4. **A reality-check seat.** The panel architect must seat one implementer (the person who has to make it happen on Monday: operations, finance or delivery, chosen by topic) whose incentive is not to be handed an impossible plan. No new engine role; a rule in the architect prompt and a check after panel design.
5. **Dissent with teeth.** Each dissent in a ruling must carry a tripwire ("what would prove me right, and by when") and a cost-of-ignoring line. The report's minority report is built from them.
6. **Personal stakes.** Dossier incentives put something on the line for each expert ("if this passes, my team loses the pilot budget"). The voice card surfaces the incentive relevant to the motion.
7. **Rulings** state the expected cost of being wrong using `ifWrong`, and the owner is the stakes' decision owner unless the room names someone else.

**Failure modes:** invented stakes (source is recorded; `assumed` is printed as assumed); melodrama ("this could destroy everything") is a lint rule; the clock cuts a live argument (the ruling says so, as it already does for `ceiling`).

### 2e. Realism linting

**Problem it fixes:** item 3 directly, and it keeps every other fix honest.

**Pipeline per utterance**, after the trailer is stripped and before performance:

1. **Rules (free).** Each rule has an id and a weight:
   - banned phrases (the corpus tics: "closer to right", "the strongest version of your case", "what everyone is missing", "own my bias", "say it out loud", "I'll name the cost", "my falsifier"), plus the speaker's `neverSay`;
   - spoken evidence labels ("(observed, …)") — evidence grades now travel in the `CLAIMS` trailer and show as chips in the UI, so the requirement survives and the tic dies. The grades must still reach the seats that judge evidence: `formatEvents` gains a judge view that appends each turn's graded claims (`[observed] …`) for the referee, the ruling, the numbers audit and the adversary desk, but not for the experts' shared prefix. The referee's rung-2 wording changes from "labelled measured/observed/assumed" to "graded in the claims record", and a guard test asserts rung 2 is still reachable on a fixture round whose speech carries no spoken labels (otherwise `minRungToClose: 3` would push every motion to the ceiling). The floor rule "if you catch a colleague stating an assumption as fact, call it" stays, because experts can still hear a claim stated without any basis;
   - the antithesis construction more than once per turn, or above a per-motion budget across the room;
   - filler praise; em-dashes; markdown or lists; summary endings ("So the answer is …");
   - an opener shared with any of the last 30 turns; a 4-gram the same speaker used in the last 5 turns;
   - length outside the shape's word budget;
   - addressing the chair when the turn is a reply to a colleague;
   - the template "name + concession + attack + label + request to chair";
   - courtesy concession without a stance move (2c); a tic over its per-motion budget.
2. **Score.** Sum of weights. Below threshold: ship as is.
3. **Rewrite (fast tier, new seat `lint`).** Instructions: keep every claim, number, name and citation id; change only form; obey the voice card; stay inside the word budget. Then **verify** deterministically: the multiset of numbers is unchanged, named entities are unchanged, citation markers are unchanged, length is inside budget, and the score went down. If verification fails, one retry; if it fails again, ship the original with the lint record. The rewrite never runs on the founder's words, research or quant desk output, or rulings.
4. **Record** `message.lint = { score, rewrote, rules }` so the eval harness can measure precision and the rewrite rate.

This replaces the flagship "too long, re-run short" retry, which cost an extra flagship call on up to 40% of floor turns.

**Failure modes:** rewrite changes meaning (verifier; manual check of 20 rewrites in the first real run); everyone gets bland (lint only removes listed patterns; voice cards add texture); a new tic appears (the metrics script prints the top shared openers and 4-grams on every run; the lexicon is data, updated from that output); latency (fast tier, and only above the score threshold; it runs before the reaction call, in sequence, so cut positions refer to the final text); cost (target rewrite rate ≤ 25% of turns).

### 2f. The evidence loop

**Problem it fixes:** item 10, and research parity across providers (section 3).

1. **Experts can ask for research themselves**, like they can already ask the quant desk: a `RESEARCH:` trailer line. Capped per motion by profile; the chair can also send research on a trigger.
2. **Experts demand numbers from each other.** The linter marks a figure with no source and no grade as unsupported; the reaction call is told which listeners dispute it, which raises the chance of a "Source?" cut-in; the referee lists unsupported load-bearing figures and the chair can send them to research or the desk.
3. **Research runs in the background** (provider-neutral tool, section 3) while the room keeps arguing. A motion may not go to ruling while research on one of its cruxes is in flight, unless the clock runs out, in which case the ruling says the evidence was pending.
4. **Research lands as a moment, not a document.** The result carries a `spoken` line (≤ 60 words, with citation markers) that the research desk says in the room; the full summary and sources go to the side panel and the report. A fast-tier clerk call matches each finding against the belief ledger's cruxes ("supports ana's crux, undermines bo's"), and the director gives the next turn to the requester or to the expert whose crux it hits: "The desk says the median is 41 days. That's your number, Bo."
5. **Evidence that moves someone is recorded**: the concession's `movedBy` points at the citation id or compute task, and the report shows "the evidence that changed the room".
6. **Prompt-injection hygiene** stays as today: fetched text is fenced with `fenceUntrusted`; the room only ever sees the research desk's structured findings, never raw page text; research prompts never contain uploaded file content.

---

## 3. Provider-neutral research tool

**Owner decision:** research must work identically for Claude and OpenAI debates from day one, with one interface and one citation schema. Claude uses the CLI's WebSearch/WebFetch; OpenAI uses the Responses API `web_search` tool.

### 3.1 Interface

```ts
// shared/research.ts (used by server, web and the report)
export interface Citation {
  id: string;                         // 'c_' + short hash of the normalised URL; stable across the session
  url: string; title: string;
  publisher?: string; publishedAt?: string;
  retrievedAt: number;
  quote?: string;                     // ≤ 300 chars, verbatim, when the provider exposes source text
  provenance: 'fetched' | 'search_result' | 'model_reported';
  provider: Provider;
}
export interface Finding {
  claim: string;
  figure?: { value: string; unit?: string; asOf?: string };
  citationIds: string[];              // at least one, or the finding is dropped
  confidence: 'high' | 'medium' | 'low';
}
export interface ResearchResult {
  requestId: string;
  status: 'ok' | 'partial' | 'failed' | 'unavailable';
  summary: string;                    // ≤ 220 words, citation markers like [c_ab12]
  spoken: string;                     // ≤ 60 words, what the desk says aloud
  findings: Finding[];
  citations: Citation[];
  searches: number; durationMs: number; costUsd: number;
  provider: Provider; model: string;
}

// server/src/research/types.ts
export interface ResearchRequest {
  id: string; debateId: string; question: string;
  askedBy: string;                    // persona id, 'marcus', or 'architect'
  motionId?: string;
  purpose: 'pre_session' | 'crux' | 'number' | 'fact_check';
  maxSources: number; recencyDays?: number;
  budget: { maxSearches: number; timeoutMs: number };
}
export interface ResearchProvider {
  id: Provider;
  available(debateId: string): boolean;
  run(req: ResearchRequest, ctx: { signal: AbortSignal; onProgress?: (note: string) => void }): Promise<ResearchResult>;
}
```

### 3.2 Adapters

- **Claude** (`research/claude.ts`): `runAgent` with `web: true` on the research seat, prompted to return strict JSON in the shape above. `sdk.ts` `runOnce` today only records assistant `tool_use` blocks and ignores `user` messages, so it is extended to also read `tool_result` blocks for WebSearch and WebFetch and keep each call's input (query or URL) and a bounded copy of its result. Provenance: a cited URL that appeared in a WebSearch result is `search_result`; one that was also fetched without error is `fetched` (note that Claude Code's WebFetch returns a small-model summary of the page, not the page, so `fetched` attests the URL was read, not the wording); anything else is `model_reported` and is dropped from findings on this door (kept in the brief as "uncorroborated"). `quote` is taken only from WebSearch result snippets, never from the model's own text. A `wireClaude({ queryImpl })` seam is added beside `wireOpenAI` and `wireCodex` so the adapter can be driven by a recorded SDK message stream; `sdk.ts` currently imports `query` and `config.ts` directly, which leaves no test seam.
- **OpenAI API** (`research/openai.ts`): a Responses request with `tools: [{ type: 'web_search' }]`, asking for a prose brief, then parsing `url_citation` annotations (url, title, character span) off the output text into citations with provenance `search_result`. A second, tool-free fast-tier call (Luna) turns the brief into the JSON findings shape, referencing citations by index. Two steps because I could not verify offline whether structured outputs and web-search annotations combine cleanly in one response; the first owner-approved probe settles it and may collapse this to one call. `include` of the search action's source list is requested so citations can be cross-checked. Web-search call charges are recorded in `costUsd` once the probe shows where the API reports them.
- **Codex** (`research/codex.ts`): a dedicated research thread with `webSearchMode: 'live'` and an output schema. Today every Codex turn runs with `webSearchMode: 'disabled'` (`codexThreadOptions`), so this is a deliberate change to the Codex sandbox profile for the research thread only, with its own selftest. The Codex SDK's `web_search` item carries the query only, not result URLs, so citations from this door are `model_reported`, and on this door they are **kept** (labelled), because dropping them would leave Codex research empty. The UX and schema are identical; the report labels these sources "reported by the model, not attested by the tool". Codex is exempt from golden equivalence (3.4) and runs the invariants only. This is best-effort parity and an open question for the owner (the decision named Claude and OpenAI). Codex turns are serialised per credential, so on this door research blocks the floor while it runs; standard and quick profiles therefore cap Codex research at the pre-session briefs plus one per motion.
- **Fake** (`research/fake.ts`): deterministic results from fixtures, used by MOCK=1, the contract tests and the eval harness.

`sdk.ts`'s `debateProvider()` collapses OpenAI and Codex into one capability family; research needs the real door, which the runner already has (`DebateRun.provider`), so it is passed into `Research.run` rather than re-derived.

### 3.3 Where it plugs in

- `Research.run(debateId, req)` picks the adapter from the debate's door and replaces `DebateRun.researchTask`, including the "research desk is offline for OpenAI sessions" branch, the architect's pre-session questions, the chair's research, and the new expert `RESEARCH:` trailer.
- `research_done` gains an optional `result: ResearchResult` (old events keep `summary` only and still render).
- `meta.researchBriefs` gains `citations`; `reportMaterial` includes them; `ReportData` gains `sources?: Citation[]` and decision trails can cite ids; the renderer gets a Sources section.
- Security: research prompts contain the question and goal only, never uploaded file text. Fetched page text enters the CLI's own context, which the app cannot fence, so the fence is applied where the app does control the text: the research desk's `summary`, `spoken` and finding claims are fenced with `fenceUntrusted` whenever they enter the room's record or a prompt. The Claude research seat keeps `dontAsk` with only WebSearch/WebFetch, and WebFetch goes through a `canUseTool` check that resolves the host and refuses loopback, link-local and private ranges (a pattern rule cannot catch redirects or rebinding; the resolved-address check narrows that, and the residual risk is recorded). This is the roadmap's fetch-allowlist item, narrowed to what can be enforced without breaking research.

### 3.4 Parity tested without live keys

1. **One contract suite**, run against every adapter (`server/src/research/contract.selftest.ts`, added to `npm run qa`). Each adapter is driven by a recorded transport fixture: a Claude SDK message stream (assistant tool_use blocks, user tool_result blocks, result message); an OpenAI Responses SSE stream through the existing `wireOpenAI({ fetchImpl })` seam; a Codex event stream through the existing `wireCodex` mock factory (the same pattern the current selftests use).
2. **Invariants** every adapter must satisfy: schema-valid; every finding cites at least one citation; every citation id resolves; the door's provenance rules applied; no URL in `summary` or `spoken` that is not a citation; `spoken` ≤ 60 words; research text fenced when it enters the room; abort honoured; timeout produces `partial`, not a throw; a provider error produces `failed` with the room told.
3. **Golden equivalence** (Claude, OpenAI and fake): the same underlying sources expressed in each provider's transport format must normalise to the same `ResearchResult` (ignoring `provider`, `model`, cost and timing). This is the parity test the owner decision asks for. Codex runs the invariants only, for the provenance reason in 3.2.
4. **Fixtures**: hand-written now; the owner-approved probes (section 7, R2) record one real fixture per door, scrubbed of keys and personal data, which then join the suite.

---

## 4. Cost and quota budget

> **Superseded (Oct 2026, owner decision "quality over cost").** The hard caps, the 80% wind-down and the 100% close described in this section are gone. Profiles now describe process depth only, `auto` sends hard calls to deep, the meter is information, an optional founder ceiling asks to extend rather than cutting, guards target waste, and a spent quota pauses and resumes. See [BUDGET-REPORT.md](BUDGET-REPORT.md) and the Budget section of [ARCHITECTURE.md](ARCHITECTURE.md).

### 4.1 Profiles

The user picks a **profile** at setup (default **standard**). The profile is a budget envelope stored on `DebateConfig.profile`. It is separate from the intake's `Depth` (`quick | standard | exhaustive` on `ComplexityRead` and `SessionScope`), which stays what it is: the analyst's read of how hard the ask must be pushed. The rule is simple: the depth read sizes the session, and the profile caps it; the session is the smaller of the two. Debates created before profiles exist get no caps (they keep today's behaviour). `scope.ts` `projectTurns`, which is round-based today, is updated in 2b-2 for the caps and again in 2b-7 for the director's turn mix.

The table is built from the turn mix in 2b (about 25% set pieces, 40% replies, 35% reactions, where reactions come free inside reaction calls) and priced with the **floors** of the measured bands in `scope.ts` (`TURN_COST`: flagship $0.07 low, because context dominates a call's price, not its output), so it is deliberately not optimistic.

| | quick | standard | deep |
|---|---|---|---|
| Experts / motions | 3 / 1 | 4 / 2 (3 at most) | 5-8 / 3-6 |
| Spoken turns, whole session | ≤ 40 | ≤ 80 | ≤ 320 |
| of which set pieces / replies / reactions | 10 / 16 / 14 | 20 / 32 / 28 | 80 / 128 / 112 |
| Flagship calls (floor, referee, chair, rulings, adversary, cards, closings, setup, report) | ≈ 48 (cap 55) | ≈ 90 (cap 100) | ≈ 340 (cap 380) |
| Fast-tier calls (reaction, lint, clerk) | ≈ 26 | ≈ 55 | ≈ 210 |
| Balanced-tier calls (dossiers, research) | ≈ 6 | ≈ 11 | ≈ 35 |
| All agent calls | ≈ 80 (cap 95) | ≈ 155 (cap 180) | ≈ 585 (cap 650) |
| Output tokens incl. thinking | ≤ 120K | ≤ 300K | ≤ 1.1M |
| Claude, API-equivalent spend (CLI `total_cost_usd`), estimate / cap | ≈ $5.6 / $6 | ≈ $10.5 / $12 | ≈ $38 / $45 |
| OpenAI API spend (from `models.ts` prices), estimate / cap | ≈ $8 / $9 | ≈ $15 / $16 | ≈ $55 / $60 |
| Codex | no per-token charge; same call and token caps | | |
| Meeting clock per motion | derived from the turn cap (2d): about 11 min | about 11 min | about 18 min |
| Wall time | ≤ 25 min | ≤ 50 min | ≤ 3.5 h |
| Research requests | ≤ 2 | ≤ 6 | ≤ 25 |
| Adversary desk | off | 1 seat per ruling | 3 seats (today's) |
| Referee thinking | 8K | 16K | 32K (today's) |
| Set-piece / reply thinking | 6K / 1K | 8K / 2K | 12K / 2K |
| Asides | off | off | on |

Bottom-up for standard on Claude: 20 set pieces × $0.10, 32 replies × $0.07, 11 referee checkpoints × $0.08, 8 chair interventions × $0.07, 3 rulings × $0.25, 2 adversary seats × $0.15, 8 cards and closings × $0.07, 4 setup calls × $0.15, report and its revision $0.90, about 55 fast-tier calls × $0.01, 5 persona calls × $0.06, 6 research × $0.15 ≈ **$10.5**. The first draft of this plan claimed $8.5 against an $8 cap with a turn mix that did not add up (review finding 1); this table replaces it.

Baseline for comparison: past sessions ran 147-445 calls and $13-$53 (median about $25). **Standard is about two to two and a half times cheaper than a typical past session, quick about four to five times**, and both make far fewer calls. The owner's rule that a debate must not eat a whole 5-hour Claude window by default is met by these caps plus the quota guard (4.4); deep is the deliberate exception and says so before it starts.

These are estimates. The per-call figures are carried from the old models' measured per-seat spend (`meta.spendByRole`), recorded under heavier thinking budgets than the profiles set, and not calibrated on Opus 5.5 (Phase 1 could not verify its price). Lower thinking budgets may bring flagship calls under the old floor; the first real run (R1) settles it, and the caps are then adjusted in one place (`scope.ts`).

### 4.2 What runs where

| Tier | Claude | OpenAI / Codex | Jobs |
|---|---|---|---|
| flagship | Opus 5.5 | GPT-6 Astra | chair (on trigger), **referee (owner decision: stays flagship)**, set pieces and replies, position cards, rulings, adversary desk, report, quant desk, audit, summon |
| balanced | Sonnet 5.5 | GPT-6.1 Sol | persona dossiers (new seat `persona`), relationships pass, research synthesis, dossier analyst (uploaded files), report repair |
| fast | Haiku 4.5 | GPT-6 Luna | reaction call (new seat `react`), reactions and backchannels, lint rewrite (new seat `lint`), clerk classifications (new seat `clerk`: starting stances, research-to-crux matching) |

The free-for-all bidding path (`marcusMove`, `bidRound`, `pickWinner`, never called by the motion engine) is removed in 2b-0. The `bid` seat goes in 2b-3, when `react` replaces it as the fast-tier seat: until then it is the only fast-tier seat, and `codex.selftest.ts` and `mock.ts` use it. The note in `motions.ts` about the steer running on the floor model to share its cache applies to anything that reads the shared prefix. The referee does **not** read it today (it has its own `refereeSystem()` prompt and is handed the round text); in 2b-7 it moves onto the shared prefix, on the floor's model, so a checkpoint judges the whole motion record from cache instead of a pasted excerpt.

### 4.3 Caching and concurrency

- The shared prefix stays byte-identical within a **checkpoint** (every 6-8 spoken turns) instead of within a three-speaker round. Fewer boundaries means fewer cache writes, which were 1.7M-6.9M tokens per past session. Between checkpoints, the turns so far ride in the suffix (bounded at about 1,500 tokens; a checkpoint is forced earlier if it grows past that).
- New constant blocks (stakes, public reputations) live in the session-constant layer. Private dossiers, voice cards, beliefs and the clock live in the suffix.
- Fast-tier calls never read the full room. They get the utterance and short listener cards, so they are small and cheap without caching.
- Concurrency. `MAX_AGENTS` is one process-wide semaphore (default 3), and two long research calls would leave one slot for everything on the critical path. The semaphore gains per-job reservations: one slot is reserved for research and can never be taken by the floor, the rest serve generation, the reaction call and lint, and the default rises to 4. Order on the critical path: generate *k+1* while *k* is performed; then lint; then the reaction call on the final text (in sequence, see 2b). On Claude every fast-tier call spawns a CLI subprocess, so a few seconds of start-up latency per call is budgeted: only the reaction call is on the critical path, and lint rewrites run only above the score threshold. Codex calls stay serialised per credential, so on that door research blocks the floor (3.2).

### 4.4 Budget meter and quota guard

- New live frame `budget` after every agent call, and a persisted `budget` checkpoint per motion: `{ profile, spentUsd, capUsd, outputTokens, flagshipCalls, calls, turns, clock, projectedUsd, quota?: { windowPct: number; resetsAt?: number } }`.
- The UI shows a meter (spend against cap, projected final, flagship calls) on the war-room header; Phase 3 designs it.
- Enforcement: at 80% of any cap the chair moves the current motion to ruling and skips motions the agenda marked optional; at 100% the session goes to closing statements and the report (the report itself is reserved in the cap: it is never the thing that gets cut). The meter and the clock agree, so the room says why it is stopping.
- **Quota guard for Claude subscriptions.** If the Claude CLI exposes rate-limit or window usage to the SDK, the meter shows "% of your 5-hour window" and a standard session pauses before using more than 60% of it (configurable). I could not confirm offline whether the SDK version in use surfaces this; if it does not, the meter shows spend only and the profile caps are the guard. The existing limit-park-and-resume logic stays.

---

## 5. Evaluation harness and mock engine

### 5.1 Offline realism scorer

Layer 1 exists: `scripts/transcript-metrics.ts` computes every metric in 1.1 from a database, an events JSON file or a `transcript.md`, with a self-test (`--self-test`, added to `npm run qa` in 2b-1).

Layer 2 (2b-1): a **realism index** in the same script. Each metric maps to 0..1 by its distance from the target band in 1.1; the index is a weighted mean, reported with the per-metric breakdown so nobody optimises a single number blind. Next to it, **decision-quality guards** that realism must not degrade: highest rung reached per motion, fresh arguments per checkpoint, adversary defeaters landed and answered, dissents recorded, share of rulings with an evidence grade above `assumed`, unsupported load-bearing figures left standing. A change ships only if the index rises and no guard falls by more than 10%.

Layer 3 (optional, costs quota, never in CI): `--judge` sends a blind pair of excerpts (old engine against new, same topic) to a fast or balanced model with a short rubric ("which reads like a real boardroom; which reaches a better decision") and reports win rates over a small sample. Off by default; only with the owner's go-ahead.

Fixtures: a synthetic "baseline-like" transcript and a synthetic "target-like" one (written by hand, no private data) are committed as test fixtures. The self-test asserts the index ranks them correctly and that each guard is computed.

### 5.2 Mock engine upgrade

`MOCK=1` (`engine/mock.ts`) is rewritten as **mock v2** in 2b-1, still with zero model calls: a scripted session that emits dossiers (public parts), a stakes frame, starting beliefs, a set piece cut off mid-sentence with an overlapping cut-in and a resume, reactions and backchannels, a pause after a concession, an unanswered question pressed twice, one aside, a research request answered by the fake provider with citations and a crux match, concession events with causes, lint records, budget frames, the meeting clock and a time-out ruling, and notification triggers. It runs through the real `FloorDirector` with scripted reaction JSON, so the mock exercises the same code the real engine will.

The mock grows feature by feature: each 2b step adds the mock events for what it built, not all of them up front.

**What the mock does not prove.** `MockRun` is its own scripted class; it never touches `runner.ts`, `motions.ts` or `buildRoomBlocks`, and today `npm run qa` has no test of the real engine at all. A hand-scripted log landing in the target bands would be self-fulfilling. So the mock is used for the UI, for refresh and replay, and for the contract; it is **not** a realism gate. Two other things are:

1. **An offline integration test of the real engine** (added in 2b-1, extended in every later step): a fake `runAgent`/`runJsonAgent` seam (scripted model replies keyed by call label, via a `wireAgents({ run, runJson })` hook in `sdk.ts`) drives a real `DebateRun` from `intake` to `complete` against a throwaway `DATA_DIR`, in `qa`. It checks the event sequence, the trailer and lint wiring, the director, the in-memory projection rule, asides and unsaid text never reaching another seat's prompt, resume after a simulated restart, and the budget caps.
2. **Realism is gated on real transcripts only**: the R1-R4 runs (section 7), scored by the metrics script against this baseline.

Mock acceptance: a browser refresh at any point reconstructs the room (two partial streams included), and old debates still render.

---

## 6. Notifications and Remotion removal

### 6.1 Notifications

**What triggers one** (an "attention event"): a clarify batch, an approval gate, a mid-debate question, a pause for a usage limit or a missing credential, an error, and the report being ready. Nothing else; the user must not be nagged per motion.

**Browser (default).**
- `DebateSummary` gains `attention?: 'question' | 'approval' | 'paused' | 'error' | 'report'`. The deck polls `/api/debates` every 15 seconds while the tab is hidden; the war room already has SSE. A notification fires only on a transition into an attention state.
- Web Notifications, permission requested only from a user gesture (a toggle on the setup screen and on the first gate), never on page load. Clicking focuses the tab on that debate.
- Title and favicon badge always: "(1) Needs you · The Debate App" and a dot drawn on the favicon with a canvas. This works everywhere, including where notifications are blocked.
- `http://127.0.0.1` and `http://localhost` are secure contexts, so the Notification API works there. On a LAN host over plain HTTP it is unavailable; the app then shows title and favicon badges only and says so in settings. No service worker: notifications need an open tab, which is exactly the gap Telegram fills.

**Telegram (optional, off unless configured).**
- Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`; optional `TELEGRAM_NOTIFY` (default `question,approval,paused,error,report`), `TELEGRAM_DETAIL` (`minimal` default, or `title`), `PUBLIC_URL` (link base, for a phone that cannot open 127.0.0.1).
- Outbound only: `POST https://api.telegram.org/bot<token>/sendMessage`. No polling, no webhook, no inbound commands, no login, no files. The app never controls anything from Telegram.
- Privacy by default: a `minimal` message is "The Debate App: a debate needs your answer. <link>", with no title, topic or content. `title` adds the debate title, which the user opts into knowingly.
- The token is read once and deleted from `process.env` (the Phase-1 credential pattern), never logged (a redaction helper covers error messages), never returned by any route. At most one message per debate per 30 seconds, coalesced. A failed send logs once and never affects the debate.
- `npm run notify:test` sends a test message; `npm run notify:chat-id` (optional helper, run by the user) calls `getUpdates` once and prints the chat id.
- **README, step by step:** (1) in Telegram, open @BotFather, send `/newbot`, pick a name and username, copy the token; (2) open your new bot and send it any message, for example `/start`; (3) run `TELEGRAM_BOT_TOKEN=… npm run notify:chat-id` (or open `https://api.telegram.org/bot<token>/getUpdates` in a browser and read `message.chat.id`); (4) add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to `.env`; (5) run `npm run notify:test` and check your phone; (6) restart the app. Plus a note on what the message contains and on `TELEGRAM_DETAIL`.
- Security test additions: with the env unset, no request to Telegram is ever made (fetch is stubbed and asserted); the token never appears in any API response or log line; egress goes only to `api.telegram.org`; minimal mode sends no debate text. Phase 1's "telegram returns only historical notes" grep becomes obsolete and is noted as such in the 2b report.

### 6.2 Remotion removal

Owner decision: drop `motion/`, rebuild animation with CSS and framer-motion in Phase 3.

- Delete `motion/` (the Remotion project, about 1 MB, with its own lockfile).
- Delete the rendered `web/public/motion/*.webm` clips as well, and the `<video>` element in `web/src/components/Cinematic.tsx`. The component already falls back to a CSS scanner when the clip fails, so the waiting bay keeps working with no new design work, and no artefact made with Remotion stays in the tree.
- Remove the README line, the `.gitignore` entry for `motion/out/`, and the "Remotion" comments in `Cinematic.tsx` and `theme.css`.
- Acceptance: `git grep -i remotion` matches only the Phase 1 report and this plan; `npm run build` passes; MOCK run shows the CSS scanner during waits.

---

## 7. Implementation order

Every step must leave `npm run typecheck`, `npm run build`, `npm run qa` and `npm run security-test` green, and a `MOCK=1` debate must run to `complete`. Each step is one or two commits. No step needs a live model except the four marked **REAL**, each of which needs the owner's approval before it runs.

**2b-0. Groundwork (no behaviour change).**
Remove Remotion (6.2). Remove the dead bidding path (`marcusMove`, `bidRound`, `pickWinner`, `sinceMarcus`, `lastBids`); the `bid` seat itself stays until 2b-3. Fix `transcript.md` missing founder answers. Add `npm run metrics` and put `--self-test` into `qa`.
*Acceptance:* gates green; `transcript.md` of a mock run contains the founder's answers; `git grep -i remotion` as in 6.2; the 8 imported debates still list and open.

**2b-1. Event contract, real-engine test seam, director skeleton.**
`shared/realism.ts` and `shared/research.ts` types; optional fields on `message`; `aside`, `pause`, `floor`, `belief`, `concession`, `budget` events; `Hub` partials per message id and the matching per-id `streaming` map in `web/src/lib/stream.ts`; explicit reducer handling of `reaction` messages and `aside` events; `formatEvents` renders cut-offs and overlap and never renders asides; minimal text rendering in the current UI (an em-rule where a turn was cut, "(over [name])", a pause line, a concession chip). The `wireAgents` fake seam and the offline `DebateRun` integration test (5.2) in `qa`. `FloorDirector` as a pure module with seeded randomness, not yet wired. The metrics script counts `reaction` messages as expert turns and measures only spoken text, and gains the realism index and guards.
*Acceptance:* director unit tests (owed answers win, duel cap, founder never interrupted, cut never before sentence one, interruption cap, heat decay); the integration test drives today's engine to `complete` through the fake seam; refresh with two overlapping streams reconstructs both (scripted in the mock); old debates render unchanged; a test that no `aside` text reaches `buildRoomBlocks` output for another seat.

**2b-2. Budget profiles, meter, hard caps.** (Before any real run, on purpose.)
`profile` on `DebateConfig` (default standard), kept separate from the intake's `Depth`; scope sizing inside the envelope; `projectTurns` rewritten for the round engine now and for the director's mix in 2b-7; per-profile thinking budgets (referee stays flagship); `budget` frames; 80% and 100% behaviour; quota guard if the SDK exposes window usage; per-job semaphore reservations (4.3).
*Acceptance:* unit tests on the cap arithmetic and the 80/100% transitions with a fake usage ledger; the integration test hits a cap and still writes the report; mock shows the meter; the pre-debate estimate shows the profile's caps.

**2b-3. Turn trailer, prompt de-seeding, rules lint, fast-tier rewrite.**
`splitTrailer` generalising `splitDeskCall` (STANCE, CLAIMS, ASK, COMPUTE, RESEARCH) with the streaming hold-back filter; evidence labels move from speech to `claims`, with the judge view of `formatEvents` and the referee's rung-2 wording (2e); prompts rewritten so no banned phrase appears in any builder's output; set-piece and reply word budgets inside today's round engine (no director yet); rules lint; rewrite with verifier; the 170-word flagship retry removed; the `bid` seat replaced by `react` as the fast-tier seat (updating `codex.selftest.ts` and `mock.ts`).
*Acceptance:* trailer parser tests (malformed lines, bold markers, a trailer-looking line in the middle of a turn stays speech); a selftest that no prompt contains a banned phrase; lint rules tested on synthetic turns; verifier tests with a fake rewriter (a changed number, a dropped name, a lost citation id each rejected); the rung-2 guard test; the integration test still reaches `complete`.
**REAL R1 (needs approval).** Claude door, quick profile, no files. Topic: *"Should a four-person neighbourhood bakery open on Sundays when two of the staff already work six days?"* Three experts, one motion, about 20-25 spoken turns. This still runs on today's round engine (the director arrives in 2b-7), so every floor turn is a flagship call and each round adds a referee and a steer: about 25 floor + 8 referee + 7 steer + 3 position cards + 3 closings + 1 ruling + 4 setup + 1 report ≈ **50-55 flagship calls**, plus about 15 fast-tier lint calls, about 70 calls in all. Expected about **$4-5** API-equivalent (within the quick cap of $6), about 0.15M output tokens, ≤ 25 minutes. Proves: the prompt and lint changes cut the tics (antithesis ≤ 8/100, spoken labels ≤ 5/100, opener repeat ≤ 8%), rewrite rate ≤ 30%, zero meaning drift in a manual read of every rewrite, rung 2 still reached, and calibrates the per-seat costs behind section 4. (The first draft promised ≤ 15 flagship calls and ≤ $2.50, which the round engine cannot do.)

**2b-4. Provider-neutral research.**
Section 3 in full: adapters, fake, contract suite, golden equivalence, `research_done.result`, sources in the report, `RESEARCH:` trailer, spoken landing, crux matching, the fetch rule.
Includes the `wireClaude({ queryImpl })` seam, `tool_result` capture in `runOnce`, the Codex research thread's web-search setting, the `canUseTool` fetch check, and persisting in-flight research requests in `meta` so a restart re-issues them instead of losing them (today `researchInflight` is in memory only).
*Acceptance:* contract suite passes for the Claude, OpenAI, Codex and fake adapters, golden equivalence for Claude, OpenAI and fake; an OpenAI-door MOCK session shows research with citations; the integration test covers research landing and a restart with research in flight; security test: research prompts carry no uploaded text, research text is fenced when it enters the room, the fetch check refuses loopback and private addresses.
**REAL R2 (needs approval).** One research request per door, Claude and OpenAI (Codex if the owner wants it): *"What is Ireland's standard VAT rate in 2026, and when did it last change?"* (stable, easy to check). Expected ≤ $0.25 per door, a few thousand tokens. Proves: the real tool-result and annotation shapes match the fixtures, where web-search charges are reported, and whether OpenAI can return citations and JSON in one call. Records scrubbed fixtures.

**2b-5. Persona dossiers and stakes.**
`persona` and `relationships` calls; diversity check; voice cards; public reputations in the roster; reality-check seat rule; stakes at intake with clarify questions; STAKES block; dissents with tripwires; report sections for stakes and the minority report.
*Acceptance:* diversity check tests on synthetic panels (a converged panel fails, a varied one passes); a debate without dossiers or stakes (old row) still runs; the cache test (system prompt byte-identical for every seat within a round, with dossiers and stakes present) passes.

**2b-6. Belief ledger and concessions.**
Ledger reducer (pure, tested); starting stances (clerk call); `belief` and `concession` events; referee audit fields; herding and unexplained-move triggers; report section "how minds changed".
*Acceptance:* reducer tests (stance move emits a concession, carry-forward on a missing trailer, unexplained move flagged, herd detection); mock v2 shows a caused and an unexplained concession.

**2b-7. The floor director, live.**
Generate-then-perform with pipelining and the in-memory projection; publish on performance; reaction call after lint; interruptions, overlap, resumes, pauses, duels, asides (deep only); chair on trigger; referee checkpoints every 6-8 spoken turns, moved onto the shared prefix; meeting clock and the `time` close reason; pending turns persisted. This is the largest step and it rewrites round-shaped interfaces, which are listed so none is missed: the `MotionHost` contract (`speakOnMotion(…, round, …, roundStartSeq)`, `interject`); the dry-round close (`dryRoundsToClose`, the referee's per-round `momentum`), which becomes per checkpoint; `floor_set` slates, which become director decisions (the event is kept for old debates and still emitted at each checkpoint as "why these voices"); `roundStartSeq` prefix boundaries, which become checkpoint boundaries; the desk-call limit keyed `${motion}:${round}`, which becomes per checkpoint; the motion checkpoint shape in `meta`; and `projectTurns`.
*Acceptance:* deterministic replay test (same seed, same scripted reactions, same event sequence); the projection test (the prompt for turn *k+1* contains exactly the performed text of *k*); restart mid-performance re-performs without a new model call; a ruling is produced on every close reason, including `time`; the cache test (byte-identical prefix within a checkpoint); the integration test reaches `complete` through the director.
**REAL R3 (needs approval).** Claude door, standard profile, no files. Topic: *"Should a 12-person B2B SaaS company move new customers from monthly to annual-only billing next quarter?"* Four experts, two motions, about 70-80 spoken turns, about 90 flagship and 155 agent calls in all (cap 180), expected about **$10.5** API-equivalent (cap $12), about 0.3M output tokens, ≤ 50 minutes. Proves: realism index inside the bands; guards not worse than the baseline sessions (rung ≥ 3 on both motions, at least one landed defeater or dissent); budget meter within ±20% of actual; the share of a 5-hour window used, if visible.
**REAL R4 (needs approval, after R3 passes).** The same topic and profile on the OpenAI API door. Expected about $15 (cap $16). Proves research parity (citations present, same report sections) and realism parity (index within ±25% of R3).

**2b-8. Notifications.** Section 6.1. Independent of everything above after 2b-1; can be built in parallel at any point.
*Acceptance:* unit tests on attention transitions and coalescing; security tests listed in 6.1; `notify:test` is the user's own manual check (it sends a message, so it is never run by CI).

**2b-9. Regression gate and docs.**
The integration test and the metrics self-test (including the committed synthetic fixtures) run in `qa`; the realism index of R3 and R4 is recorded as the new baseline that later changes are scored against; `ARCHITECTURE.md`, `CONTRACT.md`, `ROADMAP.md` and the README updated; a Phase 2b report with R1-R4 numbers against this baseline.

**Stretch, not scheduled: cross-provider cross-examination.** When both Claude and OpenAI credentials exist, an opt-in mode seats some experts on the other family. Design: per-seat provider binding (`modelFor(seat, personaId) → { provider, model }`), dispatch by an explicit provider instead of the debate-wide binding in `AgentAuth`; chair and referee stay on the session's primary flagship; the other family's seats take the adversary-desk role against each ruling, which is where model-specific blind spots should surface; research stays on the primary door so citations stay uniform; the casting sheet and every bubble label which family is speaking; the estimate shows both bills. Costs: two cache prefixes per checkpoint (one per family), so roughly 1.3-1.6x a single-family session; Codex stays serialised per credential. Risks: a model recognising the other's style and playing to it; double quota use. Belongs with the roadmap's Phase 4.

---

## 8. Risks, unknowns, and cuts

**Risks**

1. **Realism turns into theatre and decisions get worse.** Guard: decision-quality guards in the harness; unsaid claims never lost; a feature that drops a guard by more than 10% is reverted.
2. **Cost estimates are wrong.** Per-call figures are carried from older models. Guard: hard caps from 2b-2 before any real run; R1 calibrates.
3. **The fast-tier rewrite changes meaning.** Guard: deterministic verifier, manual read in R1, never applied to rulings, research or the founder.
4. **Experts do not emit the trailer reliably**, or emit stances that do not match their speech. Guard: carry-forward, referee audit, coarse scale.
5. **Performance pacing feels slower than raw token streaming.** Guard: pipelining, pace factor, Phase 3 skip control.
6. **The event contract grows and the web reducer gets harder.** Guard: all fields optional, unknown types already ignored, minimal rendering now, real design in Phase 3.
7. **Prompt injection through research.** Guard: fencing, structured findings only reach the room, no uploaded text in research prompts.
8. **Telegram leaks content or the token.** Guard: minimal default, redaction, outbound only, tests.
9. **Personal data in this repository.** Guard: anonymised quotes, ids-only metrics output, `data/` never committed.

**What I am unsure of**

- The human reference bands in 1.1 come from memory of meeting-corpus research and were not verified (no web access in this phase).
- Whether the SDK in use exposes 5-hour window usage to the app.
- Whether OpenAI's web search can return annotations and strict JSON in one call, and how web-search calls are billed and reported.
- Opus 5.5 per-token pricing (Phase 1 could not verify it).
- Whether a fast-tier reaction call picks believable cut points, or whether cut points need more rules.
- Whether the owner wants a less balanced room (Gini 0.25-0.45 means some experts speak much more than others).
- Whether Codex research with model-reported sources counts as parity.

**Deliberately cut**

- Voice and audio (text-to-speech): Phase 3 sound design at the earliest.
- Truly simultaneous generation of two speakers: overlap is performed, not generated concurrently.
- An LLM judge in CI: optional and owner-approved only.
- Embedding-based repetition metrics: lexical metrics are enough to start and need no model.
- Going back to private per-persona agent sessions: the shared cache is the cost model and stays.
- Reviving free-for-all bidding: removed, replaced by the director.
- Side whispers in quick and standard: deep only.
- Emotion rendering (faces, colours by mood) beyond the heat number: Phase 3.
- Non-English debates.

---

## 9. Top-10 decisions

1. **Separate deciding who speaks from deciding what is said.** A pure, seeded `FloorDirector` picks speakers, turn shapes and word budgets; flagship models argue, fast models react and rewrite.
2. **Generate, then perform.** Turns are generated whole, then performed at speaking pace, which makes cut-offs, overlap, resumes and pauses explicit events and lets the next turn generate during the current one.
3. **Three turn shapes with word budgets** (set piece, reply, reaction) replace the single memo-shaped turn and the flagship "too long" retry.
4. **Stop the prompts from seeding the room's dialect.** Prompts describe behaviour, never script phrases; a selftest bans the corpus tics from prompt output; evidence labels move from speech to a hidden trailer and show as UI chips.
5. **One hidden turn trailer** (STANCE, CLAIMS, ASK, COMPUTE, RESEARCH), generalising the existing COMPUTE line, carries beliefs, evidence grades and requests at no extra call.
6. **A belief ledger with caused concessions**; stubbornness enforced socially (unexplained moves become chair triggers), not by editing what someone said.
7. **Stakes are real or labelled assumed**, gathered at intake, cached in the prefix; a meeting clock doubles as the budget, so the room ends for a reason it can say.
8. **One research interface and citation schema** for every door, verified by provenance, tested by one contract suite and a golden-equivalence test against recorded transports, with a fake provider for MOCK and CI.
9. **Budget profiles with hard caps land before any real run**; standard is estimated at about $10.5 against a past median of about $25 (quick about $5.6), priced from measured floors rather than hoped-for costs; the referee stays flagship (owner), with its thinking sized by profile.
10. **Measure before and after.** The offline metrics script is the baseline and the gate; four small real runs, each approved first, prove each layer.

---

## Appendix A. Office-hours record (degraded mode)

The skill could not be loaded through the Skill tool; its `SKILL.md` and `sections/phase-2a-startup-diagnostic.md` were read and followed by hand. Mode chosen: builder mode by the open-source rule, but the six forcing questions from startup mode were used as the brief asked. No web research, no Codex second opinion, no telemetry. Answers come from the owner decisions in the brief and from the transcripts.

**Q1. Demand reality: who would be upset if realism never improved?** The only user is the owner, and the code holds his verdicts in its own comments: "should not be one long message by each but heated debate"; the room was "okay, not great". The session where he sat in the hot seat (43 answers) produced the most real-feeling transcript. Position: the demand is real but it is one person's taste, so the plan measures it instead of trusting it. Evidence that would change this: R1 and R3 transcripts that score better and that he still finds artificial.

**Q2. Status quo: what does he do without this?** Asks a single model in a chat, or pays $13-$53 for an app session that reads as a sequence of memos. The workaround cost is reading 40,000 words of uniform paragraphs or skipping to the report and trusting it blind. That second cost is the dangerous one.

**Q3. Desperate specificity: who exactly, and what is the consequence?** A founder preparing a decision he will defend in front of a board or investors. If the transcript is unreadable he does not read it, so he cannot see which ruling rested on a weak exchange. Realism is a readability and trust feature, not decoration.

**Q4. Narrowest wedge: the smallest change that makes it feel real this week.** Stop the prompts seeding tics, give turns shapes and budgets, and lint the rest (2b-3). It needs no new UI and is the first thing measured on a real run (R1). Everything else is ordered after it.

**Q5. Observation and surprise.** Two surprises from the transcripts. The room's tics are quotations from its own prompts. And concessions are not missing at all; they are too frequent and too free.

**Q6. Future fit.** As models get more fluent, AI-ness moves from words (filler, em-dashes, already near zero here) to structure (symmetry, chair-centred turn taking, uniform length, costless concession). A measured structural-realism harness gets more valuable over time, and cross-provider seats become a natural extension.

**Premises (agreed from the owner decisions):**
1. Realism must serve the decision; a realism feature that lowers decision quality is reverted. Agreed.
2. The main artificiality is structural, not lexical. Agreed on the evidence (filler 0.3%, em-dashes 0.02 per 1k, length CV 0.21, A-B-A 2.5%).
3. A default session must be several times cheaper than past ones and must not take a whole 5-hour window. Agreed (owner decision).
4. Measurement comes before building. Agreed.

**Alternatives considered:**
- *A, minimal:* prompt de-seeding, turn budgets and rules lint only, no new events. Effort S, risk low. Fixes tics and memos; no overlap, stakes or ledger. This is 2b-3, shipped first inside B.
- *B, ideal:* the full plan above. Effort L-XL, risk medium.
- *C, lateral:* a "screenplay" call where one model writes a whole multi-speaker exchange per beat. Cheap and naturally interleaved, but it is one mind voicing everyone, which breaks the architecture's "genuinely separate agent minds". Its good part is kept: the fast-tier reaction call voices all listeners' short reactions in one call.

**Recommendation and decision:** B, sequenced so A ships and is measured first. Decided on the owner's delegation of the design.

**Assignment (the concrete next action):** approve R1 once 2b-0 to 2b-3 are green.

## Appendix B. Metric definitions

All computed by `scripts/transcript-metrics.ts` from the event log (or a `transcript.md`, which lacks founder answers). Expert turns are `message` events of kind `floor`, `interjection` or `closing`. Proxies are labelled as such in the code.

- **Words per turn**: whitespace tokens; CV = sd / mean; p10/p50/p90 by linear interpolation.
- **Short / memo turns**: under 40 / over 150 words. **Multi-paragraph**: more than one blank-line-separated block.
- **Interruption rate**: interjections per 100 expert turns. **Overlap**: not representable before 2b-1; reported as 0.
- **Addresses chair / colleague / founder**: the turn contains that first name (titles and quoted nicknames handled; the founder's name is inferred from the chair's vocatives when not configured).
- **A-B-A rate**: share of consecutive expert-turn triples where turns 1 and 3 have the same speaker and turn 2 a different one.
- **Concession markers / explicit position changes**: regex lexicons (`CONCESSION`, `POSITION_CHANGE`), one hit per turn. Proxy for voiced concession, not sincere change.
- **Filler**: praise and agreement phrases (`FILLER`), one hit per turn.
- **Tics**: `TICS` patterns, per 100 expert turns.
- **Summary ending**: last sentence of a three-plus-sentence turn starts with a wrap-up phrase.
- **Opener repeat**: first three normalised tokens (seated first names replaced by NAME) shared by three or more turns.
- **Recycled 4-grams**: mean share of a turn's 4-grams (excluding all-stopword grams) already used earlier in the debate, overall and by the same speaker.
- **Gini**: over seated experts who spoke, by turn count and by words.
- **Chair word share**: chair words over chair plus expert words.

## Appendix C. Data model summary

| Where | Change | Compatibility |
|---|---|---|
| `shared/realism.ts` (new) | `Dossier`, `Belief`, `Concession`, `Stakes`, `FloorState` (server-side), turn shapes | new types only |
| `shared/research.ts` (new) | `Citation`, `Finding`, `ResearchResult` | new types only |
| `shared/types.ts` `message` | optional `shape`, `to`, `cutOff`, `overlap`, `lint`, `claims`; kind `reaction`; `text` is spoken words only | optional; old events valid; the web reducer gets explicit `reaction` handling |
| `shared/types.ts` events | `aside`, `pause`, `floor`, `belief`, `concession`, `budget`; `research_done.result?` | web reducer ignores unknown event types; `aside` is never rendered into a shared record |
| `shared/types.ts` config | `DebateConfig.profile?: 'quick' \| 'standard' \| 'deep'` (default standard for new debates; none for old rows) | optional; separate from the intake's `Depth` |
| `shared/types.ts` summary | `DebateSummary.attention?` | optional |
| `shared/models.ts` seats | add `persona`, `react`, `lint`, `clerk`; remove `bid` | stored casting sheets of old rows still render |
| `shared/report-types.ts` | `sources?`, stakes and minority-report sections, `mindChanges?` | optional |
| `meta` (DB) | `dossiers`, `stakes`, `beliefs`, motion checkpoint gains `floor` and `pending` (pending turns hold the server-only `unspoken` remainder), `budget`, research citations, in-flight research requests | absent on old rows means "feature off" |
| `Hub` (SSE) and `web/src/lib/stream.ts` | partial / streaming messages per message id | replay unchanged for one stream |
| `sdk.ts` | `wireAgents` fake seam (tests), `wireClaude({ queryImpl })`, `tool_result` capture, per-job semaphore reservations | no behaviour change without a test hook |
| `LiveFrame` | `budget` | additive |

---

## GSTACK REVIEW REPORT

**Skill:** `/plan-eng-review`, degraded mode. The Skill tool returned an error, so `plan-eng-review/SKILL.md` and `sections/review-sections.md` were followed by hand. Skipped because they contact outside services or this machine's gstack state without need: Aside/WebSearch research ("Search unavailable — proceeding with in-distribution knowledge only"), Codex outside voice, telemetry, brain cache, `gstack-review-log`. The outside voice was a local Claude subagent with fresh context (read-only, no network, no model APIs, no debates).
**Target:** `docs/PHASE2-PLAN.md` (first draft), checked against the current code.
**Decisions:** every question the skill would have asked was auto-decided from the owner decisions in the brief (design delegated to the planner; referee stays flagship; research parity Claude/OpenAI; notifications browser + optional Telegram; Remotion removed; cross-provider mode as stretch).

**Scope challenge.** The plan touches well over 8 files and adds several modules (director, research adapters, lint, notify), so the complexity gate trips. Decision: scope accepted as-is, structure kept, because each module is independently testable and the steps land in order with gates green after each. Feature deferrals already in the plan: asides (deep only), LLM judge (optional), cross-provider mode (stretch).

**Findings and dispositions** (outside voice, verified against the code by the planner; all accepted and fixed in this revision):

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | CRITICAL (9/10) | Standard caps contradicted the plan's own turn mix and cost sum ($8.5 against an $8 cap; call counts under-counted; per-call prices below `scope.ts` floors) | Fixed: 4.1 rebuilt from the turn mix at `TURN_COST` floors; reactions folded into reaction calls; new estimates and caps |
| 2 | CRITICAL (9/10) | R1's ≤ 15 flagship calls / ≤ $2.50 impossible on the round engine it runs on | Fixed: R1 restated at ≈ 50-55 flagship, ≈ $4-5 |
| 3 | CRITICAL (8/10) | Pipelining conflicted with `Hub.publish` broadcasting full messages and prompts built only from persisted events | Fixed: publish-on-performance and an in-memory projection, with a projection test |
| 4 | CRITICAL (8/10) | Asides and unsaid remainders would leak into every consumer of `message` events | Fixed: `aside` is its own event; `text` is spoken words only; remainder server-only; leak tests |
| 5 | CRITICAL (8/10) | Moving evidence labels out of speech would make referee rung 2 unreachable | Fixed: judge view of `formatEvents`, rung-2 wording change, guard test |
| 6 | CRITICAL (8/10) | The mock never touches the real engine, so mock-based gates prove nothing | Fixed: `wireAgents` seam and an offline `DebateRun` integration test in `qa`; realism gated on real runs only |
| 7 | INFO (8/10) | Web client holds one streaming message and adds unknown message kinds to the feed | Fixed: per-id streaming map and explicit `reaction`/`aside` handling in 2b-1 |
| 8 | INFO (8/10) | Lint and reaction in parallel give wrong cut positions | Fixed: sequential, lint first |
| 9 | INFO (7/10) | One global semaphore; Codex serialised; fast-tier subprocess latency | Fixed: per-job reservations, default 4, Codex research blocking and capped, latency budgeted |
| 10 | INFO (8/10) | Provenance rules contradicted Codex parity; Codex web search disabled today; WebFetch returns summaries; fencing location; hostname rules | Fixed: Codex exempt from golden equivalence and keeps labelled citations; quotes from search snippets; fence at room entry; `canUseTool` resolved-address check |
| 11 | INFO (7/10) | No Claude test seam; `tool_result` not captured | Fixed: `wireClaude({ queryImpl })` and capture in 2b-4 |
| 12 | INFO (7/10) | Clock-as-budget numbers did not match the turn caps | Fixed: slot derived from the turn cap |
| 13 | INFO (7/10) | 2b-1 acceptance depended on later steps; metrics script did not count `reaction` | Fixed: acceptance moved per step; script updated in this commit |
| 14 | INFO (6/10) | 2b-7 rewrites round-shaped interfaces; referee does not share the prefix today; in-flight research lost on restart | Fixed: interface list in 2b-7; referee moves onto the prefix in 2b-7; research requests persisted in 2b-4 |
| 15 | INFO (6/10) | Profile vs depth conflated; `bid` removal breaks selftests; `debateDoor` duplicates `DebateRun.provider` | Fixed: profile and `Depth` separate; `bid` removed in 2b-3 with the selftests; use `DebateRun.provider` |

**Architecture:** issues 3, 4, 7, 9, 14 (all fixed). **Code quality:** issues 11, 13, 15 (fixed). **Tests:** issues 5, 6, 13 (fixed; every step now has a test that would fail on a real regression, and the integration test covers the engine end to end). **Performance/cost:** issues 1, 2, 9, 12 (fixed; estimates remain uncalibrated until R1, which is stated).

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---|---|---|
| Eng review (degraded, by hand) | brief requires `/plan-eng-review` on the draft | Skill tool failed | 1 | DONE | 15 (6 critical), all accepted and fixed |
| Outside voice | skill step; Codex not allowed | local Claude subagent | 1 | DONE | same 15 |
| Office hours (degraded, by hand) | brief requires `/office-hours` | Skill tool failed | 1 | DONE | recorded in Appendix A |

**VERDICT:** plan ready for owner review; implementation may start at 2b-0. The four REAL runs each need explicit owner approval.
**OUTSIDE COVERAGE / CROSS-MODEL:** in-host subagent only (same model family); no cross-model review.

**UNRESOLVED DECISIONS:**
- Whether Codex research with model-reported sources counts as research parity (owner decision named Claude and OpenAI only).
- Whether the owner accepts the revised standard estimate (≈ $10.5 API-equivalent, cap $12) as "not eating a 5-hour window", pending R1 calibration.
- Whether a less balanced room (Gini 0.25-0.45) is wanted.
