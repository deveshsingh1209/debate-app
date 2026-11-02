# Step 2b-8: Notifications (report)

Branch `wt/notify`, worktree `debate-wt-notify`, based on `2b58e8c`. Implements plan section 6.1. No model calls, no real debates, and nothing sent outside this machine. Every Telegram request in the tests went to a fake API on 127.0.0.1. `npm run notify:test` and `notify:chat-id` were written but never run.

## What was built

**Attention, shared (`shared/attention.ts`).** One definition that the server and the web app share:
- `attentionOf()` maps a debate to `question | approval | paused | error | report`, or null, plus a key that changes for each new thing to look at.
  - clarifying → question
  - each `*_approval` gate → approval
  - a pending mid-debate question → question (keyed by question id)
  - a usage-limit pause → paused. The founder's own pause button does not count.
  - error → error
  - complete → report
- `AttentionTracker` reports transitions only. A debate's first sighting is seeded silently, so a restart or a page load never replays old states.
- `Coalescer` allows at most one send per debate per window. Changes inside the window fold into one trailing send that carries the latest kind. It is dropped if the debate no longer needs anyone by then.

**Server.**
- `DebateSummary` gains `attention` and `attentionKey`. `Debates.list()` reads only the three meta fields it needs, via `json_extract`.
- `SessionInfo.telegram` is a boolean.
- `db.ts` gains `onDebatePatched()`, a listener fired after a status or meta write. It is wrapped so an observer can never affect a debate.
- `server/src/notify/telegram.ts` is pure, with fetch, env and clock injected:
  - Settings come from env and stay off unless both the token and chat id are set and well formed.
  - `TELEGRAM_NOTIFY`, `TELEGRAM_DETAIL` (`minimal` by default, or `title`) and `PUBLIC_URL` are supported.
  - The API base is always `https://api.telegram.org`. `TELEGRAM_API_BASE_TEST` may only point at loopback; any other value turns Telegram off.
  - `redact()` strips the exact token, anything shaped like a token, and `/bot…/` URL segments.
  - Messages are plain text, with no `parse_mode`.
- `server/src/notify/index.ts`:
  - Reads the token once at import and deletes it from `process.env`. It is imported second in `index.ts`, before anything could copy the env.
  - `createNotifier()` connects tracker → coalescer → sender. A failed send is logged once, and quietly again only after a later success.
  - `startNotifications()` is a no-op when Telegram is off: no listener and no request.
- Scripts:
  - `npm run notify:test` sends one message.
  - `npm run notify:chat-id` calls `getUpdates` once and prints the chat id. This is the plan's optional helper.

**Web.**
- `components/AttentionWatcher.tsx` is mounted once in `main.tsx`, which is a one-line diff and leaves `App.tsx` untouched.
  - It polls `/api/debates` every 15 s while the tab is hidden and every 30 s while it is visible, and refreshes immediately when the tab becomes visible.
  - Transitions go through the shared `Coalescer`. Changes that come due together become one notification, such as "2 debates need you".
  - Clicking a notification focuses the tab and opens the debate, or its report.
  - The debate on screen in a focused tab does not notify.
- `lib/notify.ts` handles:
  - the preference (on by default, in localStorage)
  - `primeNotifications()`, which asks for permission only from a click
  - the title badge, "(1) Needs you · The Debate App"
  - a favicon dot drawn on a canvas
- The badge counts questions, gates and limit pauses while they are pending. Reports and errors count only if they arrived while the tab was open and have not been viewed yet. Otherwise every finished debate would badge the tab forever.
- `components/NotifyToggle.tsx` sits on the setup screen and, in compact form, on the goal-approval card (the first gate). It says plainly whether notifications are working, blocked, waiting for permission, or unavailable because this is not a secure context (a LAN host over HTTP). It also says when Telegram is on.
- The permission prompt follows only these clicks: "Initiate debate", any Dock answer or approval, and the toggle itself. Nothing asks on page load.

**Docs.**
- README has a new "Notifications" section with the six Telegram steps in plain words, what the message contains, and `TELEGRAM_DETAIL`.
- README also gains config table rows and command rows.
- `.env.example` has a new notifications block.
- CONTRACT and ARCHITECTURE each gain a short note.

## Gates (all run in this worktree)

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run build` | passes |
| `npm run qa` | passes. New: `notify.selftest.ts` (60 checks), `attention-view.selftest.ts` (10 checks) |
| `npm run security-test` | 95 passed, 0 failed (new part E plus one sweep check) |
| MOCK=1 debate | reached `complete` with `attention: report`. Path: `intake > clarifying/question > panel_design > planning > meeting > meeting/question > wrapup > reporting > complete/report` |

Security tests added (6.1):
- **Env unset → no request ever.** The selftest stubs global `fetch` and asserts no call. The server test boots with the fake API configured but no token, drives a debate to a gate, and the fake receives nothing.
- **Token never in any API response or log line.** The fake API echoes the token back inside a 401 error, the worst case. The server log and every response body are swept for the token.
- **Egress only to `api.telegram.org`.**
  - A foreign `TELEGRAM_API_BASE_TEST` keeps Telegram off.
  - `telegram.org` appears only in `notify/telegram.ts`, and only as `https://api.telegram.org`.
  - The server contains no `getUpdates` or webhook calls.
- **Minimal mode sends no debate text.** A canary topic and title are absent from the message, which still links to the debate.
- Every security-test server now blanks the `TELEGRAM_*` env, so a developer's real `.env` can never send from a test run.

The Phase 1 "telegram returns only historical notes" grep (PHASE1-REPORT.md) is now obsolete: Telegram is back as an optional, outbound-only notifier.

## Shared files touched (small, for an easy merge)

- `shared/types.ts`: one import and three optional fields.
- `server/src/db.ts`: an import, the listener plus `rowAttention`, `list()` adds attention, and `patch()` calls listeners.
- `server/src/index.ts`: 3 lines.
- `server/src/api.ts`: 2 lines.
- `web/src/main.tsx`: 2 lines.
- `web/src/routes/NewDebate.tsx`: 5 lines.
- `web/src/components/Dock.tsx`: 4 lines.
- Also `package.json` (two scripts), `server/package.json` (two selftests in `qa`), `security-test.mts`, README, `.env.example`, CONTRACT, ARCHITECTURE.

`server/src/engine/*` and `server/src/agents/*` are untouched.

## Known gaps

1. **A missing or refused credential is not an attention state yet.** The runner parks such a debate in memory (`credentialError`) and leaves its status unchanged, so nothing in the row shows it. Fixing this needs a small engine change, for example persisting `meta.parkedCredential = true` when parking and clearing it when unparking. `attentionOf` would then map it to `paused`. I left this alone because `engine/*` belongs to the concurrent 2b-3/2b-4 work.
2. **The mock asks its mid-debate question even in autonomous mode**, and clears it 1.5 s later. With Telegram configured, a MOCK autonomous run would send one "needs your answer" message. The real runner only asks in interactive mode, so this affects the mock only.
3. **Not exercised in a real browser.** The browser parts are covered by typecheck, build and the pure-logic selftest, but nobody has clicked through them: the permission prompt, a real Notification, the favicon dot, the LAN-host note. Worth a 2-minute manual check on `npm run dev`.
4. Android Chrome refuses `new Notification()` without a service worker. The code catches this and falls back to the badge. The plan's "no service worker" decision stands.

## Open questions

- Should `index.html`'s Google Fonts links go? They are the one external request the app makes on every page load, and they predate this work. The local-first rule suggests self-hosting the two fonts.
- Should the browser poll faster than 15 s while hidden? That is the plan's number. Telegram is the instant path.
- Should credential parking (gap 1) be folded into 2b-3/2b-4, or done as a follow-up?
