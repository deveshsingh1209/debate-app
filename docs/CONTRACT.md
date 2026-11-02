# Architecture contract

A local, single-user web app: you describe a decision, a multi-agent expert panel debates it live, and you get an interactive report.

**`shared/types.ts` is law.** Every payload the server emits and the web app consumes is typed there; the endpoint list is at the bottom of that file. Model ids and seat casting live in `shared/models.ts` and nowhere else. If something is missing, extend those files; never invent parallel types.

## Topology

```
web/    Vite + React 19 + TS SPA (framer-motion, react-router). Built to web/dist.
server/ Fastify (TS, esbuild bundle to dist/index.cjs). Serves API + SSE + web/dist + reports.
shared/ types.ts (the contract), models.ts (model ids), report-types.ts (report JSON).
data/   SQLite DB + per-debate workspace dirs. Never committed.
```

One Node process. The debate engine runs in-process; debates keep running while no browser is attached.

## A debate's life

1. **Setup:** you write a topic paragraph, optionally attach files, and pick a provider door (`claude` sign-in, `anthropic` Claude API key, `codex` ChatGPT via Codex, `openai` API key; `GET /api/doors` says which are ready), a depth profile (`DebateConfig.profile`: `auto`, the default, or `quick` / `standard` / `deep`; a process shape, not a spend limit), an optional dollar ceiling (`DebateConfig.ceilingUsd`, off unless set) and autonomy (`interactive` / `autonomous`). (`DebateConfig.mode` is still stored, always `directed` for new debates; since 2b-7 the floor director decides who speaks, the setup screen no longer offers it, and the engine ignores it.) You never pick a model.
2. **Intake:** a clarity check. Unclear: `clarify` events you answer. Clear: a `goal` event, a `system` event with the STAKES block (assumed fields marked; autonomous sessions also log one `assumption` per assumed field), plus a `scope` event (panel size, motions, rounds and an informational cost estimate; `estimate.profile` and `estimate.profileReason` say which room `auto` chose and why) for you to approve or revise. Until the panel is designed you may switch the room with `POST /api/debates/:id/profile {profile}`, which re-publishes `scope`. No limit is applied by default.
3. **Panel design:** an architect invents named expert personas (one of them an implementer), then each gets a dossier and the panel is checked for diversity. `panel` event (with `publicReputation` and `diversity`, flagged when the panel still fails after one redraft), approve or revise. Marcus, the moderator, is always present.
4. **Planning:** Marcus proposes the agenda of motions. `plan` event, approve or revise. Research runs meanwhile, on every provider.
5. **Meeting:** a `casting` event shows which model runs each seat. Each expert writes a private position card; when a motion opens, a `belief` event records where each stands. The motion runs on the live floor in checkpoints of six to eight written turns: the floor director picks who speaks (`message` with `shape` set_piece / reply, and `kind: 'reaction'` for short reactions), a cut turn carries `cutOff` and only its heard words, the cut-in carries `overlap`, silences are `pause` events, stance moves are `concession` events (with `movedBy` and `cost`; a later attribution arrives as another `concession` with the same `messageId`, and the latest wins). At each checkpoint the referee scores it (`round`), a `floor_set` says why those people had the floor, and a `floor` event carries heat, hands up and the meeting clock. Marcus speaks on a trigger or at a check-in, and rules (`decision`, whose dissents carry `tripwire` and `costOfIgnoring`). He can ask you questions (`question`), call research or the quant desk, and amend the plan. Autonomous mode never asks; it logs `assumption` events.
6. **Wrap-up:** closing statements.
7. **Report:** the report is written, attacked by an adversary desk, corrected, rendered to HTML and PDF (`report_ready`). The server writes its sources, what was at stake, how minds changed and the dissent record (`ReportData.sources`, `stakes`, `mindChanges`, `minority`; all optional, absent on older reports).

Speeches stream token by token as live `delta` frames over SSE, then one persisted `message` event carries the final text. `speaking` and `stage` frames drive the "who is talking / thinking" indicators.

**Realism engine (Phase 2b, additive).** More than one message can stream at once (someone talking over a speaker), so the hub keeps one partial per message id and replays every one on reconnect; the web state holds `streams[]`, not a single message. A `message` may carry `shape`, `to`, `cutOff` (its `text` is then only what was said before the cut; the unsaid rest never enters an event), `overlap`, `lint` and `claims`, and its `kind` may be `reaction`. New events: `aside` (a whisper the founder sees and no shared record ever contains), `pause`, `floor`, `belief`, `concession`, `budget`; `research_done` may carry a provider-neutral `result`. A `budget` live frame follows agent calls on debates that have a `profile`; it is information only (spend, the estimate, a projection, `billing` plan / payg / none, and the founder's `ceilingUsd` if any) and nothing in the engine acts on it. Snapshots from the capped era carry `capUsd`, `pressure`, `binding` and states `wind_down` / `closing`; those fields are optional and still render. If the founder set a ceiling and it is reached, the room asks a `question` with the options "Extend and carry on" / "Stop arguing and write it up" between rounds. A spent provider allowance parks the debate as `paused` with a persisted `quota` event (`pause: { resumesAt, kind, stated }`), and `quota` with `pause: null` when it comes back. Old debates carry none of this and render as before. Types: `shared/realism.ts`, `shared/research.ts`.

**The turn trailer (2b-3).** An expert turn ends with hidden key lines (`STANCE`, `CLAIMS`, `ASK`, `COMPUTE`; `RESEARCH` from 2b-4), held back while the turn streams and stripped before anything else reads it (`server/src/engine/trailer.ts`). Its graded claims become `message.claims` and render as chips. Grades are `measured`, `observed` (only a fact the founder supplied or a research finding cited by id), `assumed`, `mixed` and `persona` (a panelist's own backstory, never evidence); before publishing, `server/src/realism/evidence.ts` regrades an `observed` claim it cannot trace to the founder's input or a known citation id, and a regraded claim carries the speaker's grade in `said`. The report adds a server-written `personaClaims` list, `dependsOn` lines on decision trails that rest on one, and `origin: 'persona'` on such numbers-audit findings; the referee, the ruling, the adversary desk, the audit and the report writer read them (the "judge view"), the experts' shared prefix never does. Each turn is then linted (`server/src/engine/lint.ts`, lexicon in `shared/lexicon.ts`); above the threshold its form is rewritten on the fast `lint` seat and kept only if a deterministic verifier shows the numbers, names and citation markers unchanged. `message.lint` records what happened.

**Research (2b-4).** One interface for every door (`server/src/research/`): an adapter per provider turns its transport into a draft, and one normaliser turns every draft into a `ResearchResult` (`shared/research.ts`) with stable citation ids (`c_` plus a hash of the normalised URL) and provenance (`fetched`, `search_result`, or `model_reported` on Codex, labelled as such). `research_started` is followed by a `research` message carrying only the desk's spoken line with `[c_…]` markers, and a `research_done` whose `result` holds the summary, findings and citations for the side panel; the report gets a server-written `sources` list. Research text is fenced wherever it enters a prompt. Experts request research with a `RESEARCH:` trailer line; requests in flight are persisted in `meta.researchInflight` and re-issued after a restart.

**Notifications (Phase 2b-8).** `DebateSummary` (the deck list) carries `attention` (`question | approval | paused | error | report`, or null) and an `attentionKey` that changes for each new thing to look at; both come from `shared/attention.ts`, the one definition server and web share. The web app polls the list (15 s while hidden), notifies on a transition, and badges the tab title and favicon. Optional Telegram (`server/src/notify/`) watches the same transitions through a `Debates.patch` listener and only ever sends `sendMessage`. `SessionInfo.telegram` is a boolean.

## Commands

- `npm run dev`: server on :8794 (tsx watch) + Vite on :5173 proxying `/api`.
- `MOCK=1 npm run dev`: the real engine with scripted models (engine/mock-live.ts), no model calls; `MOCK_ENGINE=scripted` for the older fixed player.
- `npm run build`, `npm start`: production build served on :8794.
- `npm run typecheck`, `npm run qa`, `npm run security-test`.
- `npm run notify:test`, `npm run notify:chat-id`: the user's own Telegram checks. They reach api.telegram.org, so no test or CI runs them.

## Access

Local by default; optional password. See `SECURITY.md` and the endpoint notes in `shared/types.ts`.

## Screens (web/)

1. **/gate:** password sign-in, shown only when `ACCESS_PASSWORD` is set.
2. **/:** the deck: new debate, and the library of past debates. Says so, with a link, when no door is ready; on first run with none ready it opens /connect once by itself.
3. **/connect:** Connect your AI: one card per door (`GET /api/doors`) with its state, plain steps, copy buttons, the fix and Re-check. Linked from the deck and the settings menu.
4. **/new:** setup: topic, files, provider, depth (Auto by default), an optional spend ceiling (off by default), autonomy. The provider defaults to the first ready door (or `?door=`); Start stays off with the inline fix while the chosen door is not ready. (`/rehearsal` exists in dev builds only.)
5. **/debate/:id:** the war room: roster, live transcript, mission rail (motions, rulings, research), dock for approvals and questions.
6. **/debate/:id/report:** the report in a sandboxed frame, with downloads.

The UI must fully reconstruct state from `GET /api/debates/:id` plus SSE replay (`?since`), so a refresh mid-debate always works.
