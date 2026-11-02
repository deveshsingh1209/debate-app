# Phase 3 UI report: design system, motion and sound

**Date:** 2026-10-26 · **Branch:** `wt/ui` (worktree `debate-wt-ui`) · **Brief:** `_briefs/wt-ui.md`
**Result:** done and committed. Every gate is green. No model was called, no real debate was run, nothing was pushed, and no request left the machine: every browser session used here was locked to `127.0.0.1` and counted **0** outside requests.

## Commits

| Commit | What |
|---|---|
| `34d9071` | Design system: tokens (colour for dark and light, type, space, radius, elevation, motion), two self-hosted faces, theme switching, the restyle sheet, the plan (`docs/PHASE3-UI-PLAN.md`) |
| `191d0cb` | Realism rendering: overlap, cut-offs, spoken-over words, pauses, reactions, asides, concessions, seat avatars and states, table strip with tension and meeting clock, agenda pips, budget bar; `beliefs` in the reducer |
| `f506ca3` | Sound (Web Audio only) with limits, the sound-and-theme settings popover, the rehearsal bench's room-states gallery, `npm run qa` runs the web design checks |
| `b92c1ca` | Design-review fixes: gradients and stripes gone, 44px targets on touch, transform-only meters, 12px floor, typographic quotes |
| `7ab89b8` | Report and transcript PDF fonts self-hosted; headless Chrome kept off the network |
| (this commit) | Two last polish fixes, screenshots, this report |

## Method

- **Taste skill** (`_refs/taste-skill`, SKILL.md and `references/app-screens.md` read whole). This is an app screen, so its app run applies. `draw.mjs --app --kind markets --theme dark --keep palette,type` (seed 1395801092) dealt `true-black-flat` and `data-terminal`; **`data-terminal`** was chosen (a screen read in long sessions; tabular digits; every selection is one accent line). Its icon-rail shell was not adopted: the room has no destinations and its three columns work. Face: the brand's brass as the one accent and selection line. Signature element: the table strip (seats with their state, room tension, the meeting clock). `lint.mjs --app` was run and every FAIL fixed (the one left, a seat colour in the dev-only web mock, is data and carries `taste-skill-ignore`). **`inspect.mjs` was not run**: it launches Chrome without `--disable-background-networking`, so I could not guarantee it would stay on localhost. Its measurements were redone in my own Playwright script (below).
- **gstack** `/plan-design-review` and `/design-review`: the Skill tool returned an error for both (as for `/review` in 2a and 2b-A). Both were applied by hand from their SKILL.md files: the 7-pass plan review with ratings and a decisions register (`docs/PHASE3-UI-PLAN.md`), then the design-review checklist (first impression, extracted system, contrast, typography, spacing, states, responsive, motion, content, slop) on the rendered app, then fix and re-check. Steps that ask questions were decided and recorded instead, per the brief; steps that call outside services or the gstack designer were skipped.
- **Driving it:** the production build on a scratch port (`MOCK=1`, scratch `DATA_DIR`, `CHROME_PATH=none`, from a gitignored root `.env`) through a Playwright driver using the local Chrome, with `--disable-background-networking` and a route that aborts anything not on `127.0.0.1`. The `/rehearsal` bench ran on a Vite dev server with `/api` blocked outright. Scripts live in `.scratch/` (gitignored).

## What was built

**Design system** (`web/src/design/tokens.css`)
- Colour roles for both themes: `ground surface raised sunken active`, `rule border control`, `text muted faint`, one `accent` (brass) with `accent-line` for selection, status (`positive negative warning info` with pale pill pairs), and a heat ramp (`heat-cool warm hot`). Seat colours are data: used as given on dark, deepened 38% in OKLab on light so they stay readable as text.
- Type: IBM Plex Sans for everything, Source Serif 4 only for the minutes (motion titles and rulings). Both bundled from `@fontsource` (OFL). No monospace web font; code uses the system mono. Plex's digits are tabular by default (measured: `1111` and `0000` the same width).
- Space on a 4px base, radius 4/6/round, elevation by lightness with one shadow token for what floats, motion tokens (120/200/320 ms, ease-out) and a `--rise` that is 0 under reduced motion.
- Theme: dark (default), light, or system; set before first paint; switch in the room's settings and on the deck.
- The two older sheets keep their layout fixes; their variable names are remapped onto the tokens, and their ornament (grid paper, scanlines, glows, 46 gradient declarations, brass corner ticks, uppercase letter-spaced mono labels) is gone.

**The room** (realism events from `shared/realism.ts`)
- **Overlap:** two live streams render side by side under "Talking over each other" (stacked under 720px); the strip says it too.
- **Cut-off:** the line ends on a short rule in the cutter's colour, then "cut off by X". The words someone was already talking over are underlined (dotted) on the cut line itself; the cut-in sits indented under it, tagged "over X".
- **Pause:** a beat with its reason and length; when it arrives live, a hairline runs for exactly the pause's duration.
- **Reaction:** a short indented turn. **Aside:** an italic overheard line, tagged.
- **Heat/tension:** seats get an outer ring when irritated (heat ≥ 0.6, between the director's duel and chair thresholds), pulsing over 0.85; the strip shows room tension (mean of the two hottest seats: Calm / Tense / Heated / Overheated) and the meeting clock. Absent on old debates rather than shown as zero.
- **Belief change:** a concession card with the stance moving on the motion's five-point scale (from, to, what moved them, what it cost); the reducer now keeps each expert's stance (`belief`, then concessions) and the seat card shows it.
- **Budget:** pressure against the closest cap with the 80% wind-down line, coloured by state, worded ("Winding down · 83% of standard, by dollars"); old unprofiled debates keep the token meter.
- **Motion/agenda:** "Motion 2 of 4 · round 3", agenda pips by status, the serif title, the rung ladder.
- **Seats:** avatars with speaking (solid ring, slow breath), composing (broken ring turning), irritated, and hand-up states, each also in the accessible name.
- **Entrances:** only rows that arrive while you watch rise 6px over 320 ms; a streamed turn does not rise a second time when it lands; reloaded and imported debates render still.

**Sound** (`web/src/lib/voice.ts`, rules in `sound-core.ts`)
- Web Audio only, synthesised at play time: gavel (twice to open a motion, once for a ruling), turn-change tick, interruption, concession chime, report-ready, and your-call.
- Off until turned on; that click creates the AudioContext. Master volume (default 35%) through a gentle compressor; "All" or "Key only" (the default under reduced motion). Each cue has its own minimum gap; any two cues ≥ 250 ms apart; at most 6 in 10 s; over a limit a cue is dropped, never queued.
- Removed: the speech-synthesis announcements (not Web Audio, and the loudest thing in the app), per-seat chimes on every message, and the held thinking drone.

**Reports (server, outside `web/`)** The report and transcript HTML linked Google Fonts, so opening a report, exporting a PDF, or running the print QA inside `npm run qa` contacted Google. `server/src/report/fonts.ts` now inlines the same three faces from `@fontsource` (falls back to system fonts, never a CDN); the two headless Chrome spawns get no-background-networking flags. This touched `report/` only, nothing in `engine/` or `agents/`.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `npm run qa` | all pass: print QA clean (5 documents), prompts 10/10, OpenAI 54/54, Codex 120/120, director 36/36, budget 28/28, engine 47/47, reducer 17/17, metrics all, **design 195/195** |
| `npm run security-test` | 78/0 |
| MOCK=1 debate through the real HTTP API and SSE, in the browser | reached `complete` (68 events) in dark and in light; report view opened; **0 outside requests, 0 page errors** |
| Design self-test (new, in `qa`) | every text role ≥ 4.5:1 on every surface in both themes; marks ≥ 3:1; 8 seat colours readable as text in both themes; no font/CDN URL in `web/` source, the built `dist`, or `server/src/report` |
| In-browser contrast audit (every visible text node against its real background) | 0 failures on deck, setup and war room, dark and light, 1440 and 390 |
| Fonts actually in use | IBM Plex Sans 400/400i/500/600 and Source Serif 4, from the bundle |
| Touch targets on a phone | every control ≥ 44px; no horizontal overflow at 390 |
| Sound, in the browser | no AudioContext before opting in (clicks and keys included); one after; after reload none until the first gesture; a whole live mock debate: 23 cues, busiest 10 s window 6, closest two 404 ms |
| Reduced motion | loops run once and stop, arrivals do not travel, the opening count is replaced by its one line (held 1.8 s), sound defaults to key cues |
| `git grep fonts.googleapis` | only the self-test's ban pattern |

Screenshots (JPEG, about 0.9 MB in all) are in `docs/screenshots/`: `before-room-1440` (the old look), `room-dark-1440`, `room-light-1440`, `overlap-dark-768`, `question-dark-390`, `room-states-dark-1440`, `room-states-light-1440`, `room-states-light-390` (the bench: heat, hand up, stance, budget at wind-down, crosstalk), `old-debate-dark-1440`, `settings-dark`, `deck-dark-1440`, `new-light-1440`.

## Deviations, and why

1. **Server files touched** (`server/src/report/{fonts,render,transcript-pdf,pdf,qa}.ts`, `server/package.json`): the brief requires zero external font requests and `npm run qa` to pass, and qa's print check fetched Google Fonts. Kept to `report/`, a new file plus one-line swaps.
2. **Root `package.json`**: `qa` now also runs `npm run qa -w web` (one line).
3. **Sound defaults off** rather than on-but-quiet: "off until user gesture" read strictly, so the gesture that enables sound is the founder choosing it.
4. **Speech announcements removed**, not just quietened (not Web Audio; the brief says Web Audio only).
5. **Data-terminal's icon-rail shell not adopted**; **taste-skill's "no entrances on app screens"** overridden by the brief's "subtle entrance animations" (6px, 320 ms, live arrivals only).
6. **`inspect.mjs` not run** (network flags, above); its measurements were reproduced locally.
7. **Imported debates were checked without the real `./data`**: that copy lives in the main checkout, which the brief says not to touch. Old-format rendering was checked through the reducer self-test (old debate folds as before), and the bench's "An old debate" view (realism fields stripped) in both themes.

## Unfinished or uncertain

- The `MOCK=1` engine emits no `floor`, `belief` or `motion_open` events and its `budget` frames stay low, so heat, stance, agenda and wind-down were seen only on the rehearsal bench (folded through the real reducer), not in a mock run. Adding them means editing `server/src/engine/mock.ts`, which belongs to the other agent's area.
- The phone HUD still takes three rows (title and phase; meter and session controls; panel and record).
- Report HTML is about 200 KB larger per file with the fonts inlined.
- The taste lint still warns (131, no fails): mostly shadows, mono and padStart in the older sheets' overridden rules and in clocks. These are warnings by its own definition; listed, not chased.
- Persona colours come from the server; a future persona hue near the ground's lightness would need the same deepening rule (it applies automatically on light, not on dark).

## Open questions for the owner

1. Sound **off by default**, or on at a low volume after the first click?
2. Keep the **brass accent**, or take the taste draw's dealt blue?
3. Should the report adopt the app's two faces (Plex Sans and Source Serif 4) instead of Rajdhani, Inter and JetBrains Mono? It would shrink each report and match the app.
4. May the mock engine (`server/src/engine/mock.ts`) emit `floor`, `belief` and a wind-down budget, so the full room can be seen in a `MOCK=1` run? (Other agent's file.)
5. Is "irritated" at heat 0.6 the right line, or should it follow each seat's own `interruptThreshold`?
