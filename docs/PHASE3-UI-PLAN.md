# Phase 3 UI plan: design system, motion and sound

**Date:** 2026-10-26 · **Branch:** `wt/ui` · **Scope:** `web/` only (plus one line in the root `package.json` so `npm run qa` runs the web checks).

This plan was reviewed with gstack's `/plan-design-review` method. The Skill tool returned an error for that skill (as it did for `/review` in Phases 2a and 2b), so its seven passes were applied by hand from `~/.claude/skills/gstack/plan-design-review/SKILL.md`. The brief says not to ask questions, so every decision the skill would have put to the owner was decided here, with the reason, and is listed in Pass 7 for the owner to overturn.

## The screen and its one question

The war room is an app screen (taste-skill: "an app screen is worked in"), read in sessions of 20 to 90 minutes. Its one question: **"Who has the floor, and where is the argument going?"** Its one finding at any moment: the line being spoken, and whether the room is heating up or settling.

Taste-skill app draw (`draw.mjs --app --kind markets --theme dark --keep palette,type`, seed 1395801092) dealt `true-black-flat` and `data-terminal`. **Chosen: `data-terminal`**: a monitoring screen read in long sessions; tabular digits; signs instead of colour on numbers; every selection marked by one 1px accent line. Its icon-rail shell is **not** adopted: the war room has no destinations to navigate between, and its three-column room (seats, transcript, record) is the product's existing, working layout. Recorded as a deliberate redraw.

**Its face:** the brand's brass, re-cut as the "chair's lamp", is the one accent and the only selection mark. **Signature element:** the table strip: the seats as avatars that show who is speaking, who is composing, who is irritated (heat), who has a hand up, plus the room's tension and the meeting clock. It is the one element only this product has.

## Design system (tokens)

All in `web/src/design/tokens.css`. Everything else references tokens; the legacy variable names of the two older sheets (`--bg0`, `--sea-*`, `--brass`, `--bone-*`, `--cyan`, ...) are remapped onto them so every screen inherits the system without a rewrite.

| Group | Tokens |
|---|---|
| Colour roles | `--ground --surface --raised --sunken --active --border --rule --control --text --muted --faint --accent --accent-ink --accent-line --positive --negative --warning --info` plus pale pill pairs and a heat ramp `--heat-cool --heat-warm --heat-hot` |
| Themes | `:root[data-theme="dark"]` (default) and `:root[data-theme="light"]`; "system" follows `prefers-color-scheme`. Stored in `localStorage['debate.theme']`, applied before first paint by the module that imports the CSS. |
| Type | Two faces, self-hosted from `@fontsource` (OFL): IBM Plex Sans for everything, Source Serif 4 only for motion statements and rulings (the minutes of the meeting). No monospace web font; `pre` uses the system mono. Scale 12 / 13 / 14 / 16 / 20 / 26 px; tabular figures on every number. |
| Space | 4px base: `--s1 4 · --s2 8 · --s3 12 · --s4 16 · --s5 24 · --s6 32 · --s7 48` |
| Radius | Tight: `--r-1 4px` (chips, controls), `--r-2 6px` (cards), `--r-round 999px` (avatars, dots) |
| Elevation | Lightness steps only (`sunken < ground < surface < raised`). One shadow token, `--shadow-float`, for what floats (popovers, the dock). No glows. |
| Motion | `--dur-1 120ms · --dur-2 200ms · --dur-3 320ms · --ease-out cubic-bezier(.2,.7,.2,1) · --ease-in-out cubic-bezier(.6,0,.3,1)`; framer-motion springs `stiffness 380 damping 34` for UI. `prefers-reduced-motion: reduce` drops all travel and loops; colour and opacity state changes stay. |

**Contrast:** every text role reaches 4.5:1 on every surface it sits on, in both themes; the accent reaches 3:1 as a non-text mark and 4.5:1 where it is text. A self-test computes it (`web/src/design/design.selftest.ts`, run by `npm run qa`).

## Pass 1. Information architecture — 5/10 → 8/10

Before: every layer shouts (uppercase tracked mono labels, glows, gradient plates, brass corner ticks); the eye has no first stop. Transcript is right, but the seats' state lives only in the left rail, which is hidden below 1100px.

Decided:
```
HUD (48px): back · title · phase track ·········· clock · budget meter · sound · pause · end
MOTION BAR: Motion 2 of 4 · title (serif) · rung ladder · tension · meeting clock
TABLE STRIP: seat avatars (speaking / composing / irritated / hand up)   ← shown at every width
TRANSCRIPT (the biggest thing): turns, overlaps side by side, cut-offs, pauses, concessions, rulings
LEFT RAIL (≥1100): seats with role and stance · RIGHT RAIL (≥1100): rulings, agenda, research
DOCK (when the founder is needed)
```
First: the line being spoken. Second: who holds the floor and how hot the room is. Third: where the motion stands (rung, budget).
Remaining gap (why not 10): the right rail still stacks three unrelated lists; a later phase could tab them.

## Pass 2. Interaction states — 4/10 → 8/10

| Feature | Loading | Empty | Error | Live | Partial |
|---|---|---|---|---|---|
| Transcript | boot line | "The room has not started yet" | engine fault note | streaming caret per stream | two streams side by side |
| Table strip | — | hidden until panel exists | — | speaking ring, composing dots, heat | seats with no heat data render neutral |
| Budget meter | — | absent on unprofiled (old) debates: token meter only | — | bar with 80% wind-down tick | state `wind_down`/`closing` named in words |
| Tension | — | hidden without a `floor` event (old debates) | — | 0–1 bar + word (calm/tense/heated) | — |
| Sound | off until the founder turns it on (a user gesture) | — | AudioContext unavailable: control says "Sound unavailable" | cue | rate-limited: dropped, never queued |
| Concession | — | — | — | card with from → to stance | missing stance numbers render the kind only |

## Pass 3. Journey and emotional arc — 5/10 → 8/10

| Step | Founder does | Should feel | Specified |
|---|---|---|---|
| 1 | Opens the room | "Serious, and it's mine" | quiet ground, serif motion title, no splash noise |
| 2 | Watches the first exchange | Following, not decoding | sentence-case labels, one accent, seats strip |
| 3 | Someone cuts in | A jolt, then clarity | both streams visible at once; the cut line ends on a clean rule with the cutter's name; one soft interruption cue |
| 4 | Silence | Tension, not a hang | a pause beat with its reason and length, the meter ticking |
| 5 | Someone concedes | Movement, a small win | concession card with the stance moving on a 5-point scale; one chime |
| 6 | Ruling | Closure | gavel (soft), serif ruling card |
| 7 | Report ready | Done, and proud of it | one tone, the banner |
5-second: brass on graphite, one big column of speech. 5-minute: the room's state readable at a glance. Long term: nothing blinks or beeps without a reason.

## Pass 4. AI-slop risk — 3/10 → 8/10

Mode: OPERATE (app UI). Hard rejections found in the current UI: **#7 app UI made of stacked cards** (every feed item a bordered gradient card) — fixed by letting speech run as text on the ground and keeping containers only for the record (motion, ruling, quant, audit). Litmus: brand unmistakable — yes (brass lamp, serif minutes); one anchor — the transcript; scan by headings — partly; cards necessary — reduced; motion improves hierarchy — yes, only on arrival and state; premium without shadows — yes after removing glows.
Removed: grid-paper background, scanlines, glow shadows, gradient plates, brass corner ticks, uppercase letter-spaced mono labels (now sentence case at 12px), monospace for prose labels.
Kept on purpose (and why): small uppercase is gone, but **phase pips and the rung ladder** stay as dots: they are state, not ornament.

## Pass 5. Design system alignment — 3/10 → 9/10

No DESIGN.md existed; three generations of variables were layered (`index.css` v1 cyan, `theme.css` naval brass, inline colours in TSX). Decided: one token file, legacy names remapped, inline hex colours in TSX replaced by tokens where they are chrome (persona colours stay data). `docs/DESIGN.md` is not added; the token file's header is the reference.

## Pass 6. Responsive and accessibility — 5/10 → 8/10

Widths checked: 1440, 768, 390. Below 1100px the rails become drawers (unchanged) and the table strip carries the seats. Touch targets ≥ 40px on controls in the HUD at phone width. Focus: a 2px accent outline offset 2px on every control. Overlapping streams stack vertically under 720px. Every cue has a visual twin (sound is never the only signal). `aria-live="polite"` on the newest finalized turn is **not** added: a screen reader announcing every turn of an hour-long debate would be unusable; the speaking seat carries `aria-label`.

## Pass 7. Decisions register (made without asking; owner may overturn)

1. Accent stays brass (brand continuity) rather than the dealt blue.
2. Two typefaces (Plex Sans + Source Serif 4); Fraunces, Inter Tight, Azeret Mono, Rajdhani, JetBrains Mono and IBM Plex Sans-from-Google all go.
3. Default theme: dark; "system" and "light" available from the room's settings popover.
4. Sound default **off**; turning it on is the user gesture that creates the AudioContext. Speech synthesis announcements (the old "ship computer" voice) are **removed**: they were not Web Audio, and they were the loudest thing in the app. The held "thinking drone" is removed for the same reason.
5. Cues: gavel (motion open and ruling), tick (turn change, quietest), interruption, concession chime, report-ready, plus the existing "founder needed" alert re-voiced softly. Master volume default 35%. Global limit: one cue per 250ms, at most 6 per 10s; each cue has its own minimum gap.
6. Reduced motion also lowers sound to the key cues only (gavel, founder needed, report ready) unless the founder picks "all".
7. Irritated = heat ≥ 0.6 (between the director's duel threshold 0.5 and the chair's intervention threshold 0.85); heated room ≥ 0.85.
8. Entrance animation only for items that arrive while you watch; a reloaded or imported debate renders still.
9. The taste-skill app rule "nothing performs an entrance" conflicts with the brief's "subtle entrance animations"; the brief wins, kept to a 6px rise over 200ms.
