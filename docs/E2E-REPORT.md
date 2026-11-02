# E2E report: browser tests, visual review and accessibility

Branch `wt/e2e`, from main `ed888c6`. Date 2026-10-27.

## Result

| Check | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `npm run qa` | pass (design selftest 206/206, start selftest 3/3, server and web selftests) |
| `npm run security-test` | pass, 252/252 |
| `npm run e2e` | **31 passed, 0 failed, 0 skipped** (about 3.5 min) |
| `npm run e2e:shots` | 34 passed (the 31 plus the 3 screenshot tests) |

Every run is MOCK=1: the real engine with scripted models, in a sandbox with no AI login and no keys. No model was called and no quota was used.

## What the suite does

`npm run e2e` builds the app, then `e2e/serve.mjs` starts it on 127.0.0.1:8871 in `.scratch/e2e/`, a sandbox made to look like a fresh computer. It has an empty `.env`, its own data folder and HOME, and stub `claude` and `codex` binaries that only answer status checks. The tests change what the doors see the way a person would: they write a key into `.env`, a login file appears, and they press Re-check. Playwright stops the server at the end.

The fixture (`e2e/fixtures.ts`) runs on every test:

- **No request leaves 127.0.0.1.** Every other host, WebSockets included, is aborted, and the test fails if anything tried. That covers the app, the report iframe and redirects. Service workers are blocked so nothing can get round the guard.
- **Uncaught page errors fail the test.**
- **Probes** count AudioContexts, oscillators started, the master gain and notification permission requests. A stand-in `Notification` lets headless Chromium count the prompt.

| File | Covers |
| --- | --- |
| `01-connect` | First run opens Connect your AI. There are four cards with live statuses and their fixes. Copy buttons copy the exact text. New debate's Start is off, with the fix shown, while no door is ready. Re-check marks a wrong key as a Problem and a right key as Ready, with no restart. Start comes on per ready door. All four doors become Ready. |
| `02-doors` | A debate starts on each of the four doors, and the deck shows the door each one runs on. |
| `03-room` | A whole debate played through the browser: intake questions, the three approvals and Marcus's question mid-debate. Covers crosstalk, cut-offs, timed pauses, belief-change cards with what each change cost, the room taking intake's title, and sound off throughout (zero AudioContexts). Sound comes on only when asked, at quiet volume, and volume and mute work. Sound saved as on stays silent until the first click. The report has stakes, how minds changed, dissent and sources. |
| `04-quota` | A spent allowance shows the quota pause banner, and Resume carries on. |
| `05-ui` | Theme: dark by default, and Light and System survive a reload. The settings menu closes on Escape and on an outside click. The notification prompt only follows a click, and only once. Keyboard: the deck, New debate's radio group and Connect work with a visible focus ring, and a past debate opens with Enter. Reduced motion: no endless animation, and sound defaults to key cues only. At 390px nothing spills off the side, and the room's panel and record open as drawers. |
| `06-a11y` | axe-core (WCAG 2.0/2.1 A and AA) on the deck, settings menu, Connect, New debate, a finished room, the report (inside its frame) and a room waiting on a question. Runs in dark and light, at 1440px and 390px. Any critical or serious violation fails. |
| `07-docs-shots` | Opt-in only (`npm run e2e:shots`). Retakes `docs/screenshots/*.jpg`. |

## The five failures from the interrupted run, and what fixed them

1. **`03-room`: "Marcus asked the founder a question" never seen.** This was a test bug. `driveToEnd` clicked the first option card before calling `onTick`, so Marcus's question was answered before the test could see it. The helper now looks before it acts. The assertion is unchanged.
2. **`05-ui` keyboard: `.cx-card button` count was 0.** Also a test bug. `count()` does not wait, and the cards render only once the door check answers. The test now waits for the four cards first, and still asserts more than 8 buttons, none removed from the tab order.
3. **`06-a11y` (3 tests): `label-content-name-mismatch` on the file drop zone.** This was an app bug. The zone's `aria-label` ("Attach files…") did not contain its visible text ("Drop files or click to browse"), so a voice-control user saying what they see would not reach it. The override is removed, and the zone is now named by its own text.

With those fixed, the a11y run went further and found more real problems:

4. **The transcript scroller and the report's wide tables could not be scrolled from the keyboard** (`scrollable-region-focusable`). Both are now focusable named regions with a visible focus ring.
5. **The "question waiting" check had never run.** It looked for a deck row saying "Needs you", but no row ever says that, so the check was silently skipped. It could also hang for the full 3-minute timeout. It now opens a "Clarifying" debate and requires the question card to appear. Once it ran, it found the next problem.
6. **The transcript faded to 45% opacity while a question was open**, which left its text at about 2:1 contrast (AA needs 4.5:1). It now stays readable. The question card is still set apart by the dock's border and position.

## Visual review: what was fixed

I looked at every screen in both themes at 1440px and 390px, using the screenshots in `.scratch/e2e-shots/`.

- **The report's section nav was cut off at 1440px.** It was a sideways scroller with its scrollbar hidden. "Open Qs" was clipped against Expand/Collapse, and Moderator and Sources could not be seen at all, with nothing to show they existed. On wide screens the nav now wraps. The page's top offset follows the header's real height (`--hud-h`), so a wrapped nav never covers content.
- **At 390px the report header ran off the right edge** (badges clipped) and Expand/Collapse squeezed the nav down to one word. The badges now wrap. The nav is a full-width row you swipe along, with the buttons underneath.
- **The quota pause said "Your 5-hour Claude: API key limit is spent".** Only the Claude sign-in has a 5-hour window. On every other door it now reads "usage limit" (`server/src/engine/runner.ts`).
- Earlier in this branch, before the interruption: the deck shows the topic instead of four rows of "UNTITLED DEBATE", and the room takes intake's title the moment it lands. "Mission plan / REV 1" now reads "Agenda", and "Desk idle" now reads "Nothing looked up yet…". The Notify toggle no longer uses the brass primary fill, and the sound settings row label stays readable when switched off.

The brass accent is unchanged.

## Screenshots

`docs/screenshots/` now holds eight fresh compressed JPEGs, 26–104 KB each: deck, Connect, New debate (light), live room with crosstalk, finished room (light), report, the question card at 390px and the room at 390px. The ten stale images were removed; only two were referenced, both from the README. The README now shows four of the new images.

## Not verified

- **Real AI calls.** No model was called (MOCK=1 only). The doors' status checks ran against stub `claude` and `codex` binaries, not the real CLIs.
- **Sound you can hear.** The tests read the Web Audio graph (contexts, oscillators, gain), not the speakers.
- **The browser's real notification prompt.** Headless Chromium denies it, so a stand-in counts the requests.
- **Browsers other than Chromium** (Firefox, Safari) and real phones. 390px is an emulated viewport.
- **Screen readers.** axe is a smoke check; nobody listened with VoiceOver or NVDA.
- **Contrast inside charts' SVG and on hover states.** axe does not check these.
- **`npm run e2e:shots` on Windows.** It sets the variable with `E2E_DOCS_SHOTS=1 …`, which `cmd.exe` does not support. `npm run e2e` itself is cross-platform.
- **The live room's interrupted line** (the speaker who is being talked over) is drawn faint on purpose while it streams. axe passed on the finished room, but nothing checks that line's contrast mid-stream.

## Open questions

1. Should the dimmed transcript have some other cue while a question waits, now that fading it is gone? I think the dock is enough, but this is a design call.
2. The report nav lists up to 15 sections. Short labels or a grouped "More" menu would keep it on one line, if wrapping to two rows is not wanted.
3. Should `e2e` run in CI on every push? It takes about 3.5 minutes and needs a Chromium download.
