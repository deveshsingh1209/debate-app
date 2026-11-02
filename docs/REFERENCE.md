# Reference

Details that the [README](../README.md) leaves out so that it stays short: how depth and cost work, every setting, Telegram notifications and the developer commands. Nothing here is needed for a first debate.

Settings go in a file named `.env` in the app folder (copy `.env.example`). Everything is optional. If the default port is busy, the launchers pick the next free one by themselves and say which.

## Depth and cost

Quality comes first. **No spending limit is applied by default.** A debate ends when its calls are settled (the key cruxes resolved, or a real stalemate recorded), never because money ran out, and the ruling, closing statements and report always happen.

You choose how deep the room argues at setup. The profile is a process shape, not a spend limit:

| Depth | Shape | Typical on Claude (plan equivalent) |
|---|---|---|
| Auto (default) | the chair picks from its read of the ask: hard or high-stakes calls get Deep, the rest Standard | as below |
| Quick | one motion, three experts, two or three rounds, one adversary on the ruling; about 40-60 messages | about $3-5 |
| Standard | up to three motions and four experts, three to five rounds each, one adversary per ruling | about $4-8 |
| Deep | up to six motions and eight experts, at least four rounds, three adversaries per ruling and on the report | about $14-27 for a five-motion session |

Auto picks Deep when the intake judges the call needs exhaustive pushing, when there are more decisions or disciplines than the standard room seats, or when the brief reads as high-stakes (an acquisition, a raise, layoffs, a lawsuit, seven-figure sums). You can switch the room when you approve the goal. Pre-debate figures are uncalibrated and are not spending limits; actual use can be much higher (see the [roadmap](ROADMAP.md)). API use is billed by the chosen provider; subscription use consumes the account's allowance.

What the app does guard against is **waste**: an identical call already in flight is shared rather than run twice, a call whose answer already exists is not re-run in a loop, and when several turns in a row only repeat what the room has said, the motion is recorded as a stalemate and ruled rather than argued again.

**Your own ceiling (optional, off by default).** Tick "ask me before spending more than $X" at setup, or set `BUDGET_CEILING_USD` for every debate. At the ceiling the room pauses at the next checkpoint (every six to eight turns) and asks: one click raises it and the room carries on at full depth, or you stop and get every open motion ruled, the closing statements and the full report. The live spend is in the meter; on a pay-per-use OpenAI key it is highlighted.

**Pause and Resume.** Pause works at any step until the report is finished. Whatever is already being written finishes; nothing new starts, no motion is ruled or closed, and Resume carries on from exactly where the room was (in the middle of a round, the adversary's round or the closing statements included). You can still answer a question or approve a step while paused. A paused debate stays paused across a restart.

**Running out of quota pauses, it does not cut.** If your Claude five-hour or weekly window, or an OpenAI or ChatGPT rate limit, runs out, the debate pauses where it is and shows "Paused: waiting for quota, resumes ~HH:MM". It resumes by itself at the reset the provider stated (or on a backoff capped at an hour when none was stated), including after a restart. Resume tries straight away.

All of these numbers live in one file, `shared/budget.ts`.

## Configuration

Copy `.env.example` to `.env`. Everything is optional.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8794` | Server port. |
| `HOST` | `127.0.0.1` | Interface to listen on. Anything other than loopback requires `ACCESS_PASSWORD`. |
| `ACCESS_PASSWORD` | unset | Puts a sign-in screen in front of everything. |
| `ALLOWED_HOSTS` | unset | Extra host names or IPs you will open the app by (for example a LAN IP). |
| `SESSION_TTL_HOURS` | `12` | How long a password sign-in lasts. Sessions also end when the server restarts. |
| `ANTHROPIC_API_KEY` | unset | Enables the Claude: API key provider. |
| `OPENAI_API_KEY` | unset | Enables the OpenAI API provider. |
| `CODEX_HOME` | `~/.codex` | Where your Codex login lives. |
| `FOUNDER_NAME` | unset | How the panel addresses you. |
| `DATA_DIR` | `./data` | Debates, uploads, transcripts, reports and backups. |
| `MOCK` | unset | `1` runs the real engine with scripted models: no model calls, no quota. |
| `MOCK_SCENARIO` | `pricing` | With `MOCK=1`: `pricing` (3 experts) or `library` (shorter). |
| `MOCK_SPEED` | `1` | Speaking-pace multiplier, or `max` for instant (tests). |
| `MOCK_ENGINE` | unset | `scripted` plays the older fixed script instead of the real engine (then `MOCK_SCENARIO=legacy` and `MOCK_SEED` apply). |
| `SPEAKING_PACE` | `2.5` | Words a second at which turns are performed to the room; `0` plays them at once. |
| `MAX_AGENTS` | `4` | Agent turns allowed to run at once. One slot is kept free of research. |
| `BUDGET_CEILING_USD` | unset | Optional spend ceiling for every debate that does not set its own. Off when unset. At it you are asked to extend; nothing is cut. |
| `MAX_FLOOR_MESSAGES` | `120` | Read but not used by the current engine (kept so old `.env` files still load). |
| `TURN_THINKING`, `FLOOR_THINKING`, `REFEREE_THINKING`, `STEER_THINKING`, `HEAVY_THINKING` | see `server/src/config.ts` | Thinking budgets, used only by debates created before depth profiles. Newer debates use `shared/budget.ts`. |
| `TURN_TIMEOUT_MIN`, `RESEARCH_TIMEOUT_MIN`, `QUANT_TIMEOUT_MIN` | `10`, `20`, `8` | Time limits per agent turn. |
| `AGENT_CLI_PATH` | auto | Path to the `claude` executable if it is not on `PATH`. |
| `CHROME_PATH` | auto | Chrome or Chromium for PDF export. PDF export needs one of them installed; without it you still get the HTML report. `none` turns PDF export off. |
| `CHROME_NO_SANDBOX` | unset | `1` prints PDFs with Chrome's sandbox off from the start. Not needed normally: the app keeps the sandbox on and falls back by itself (with a warning in the log) only where the sandbox cannot start, such as running as root or Ubuntu 23.10+ with AppArmor. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | unset | Optional Telegram notifications. Off unless both are set. See [Notifications](#notifications). |
| `TELEGRAM_NOTIFY` | all five | Which moments send a Telegram message: any of `question,approval,paused,error,report`. |
| `TELEGRAM_DETAIL` | `minimal` | `minimal` sends no debate text at all. `title` adds the debate title. |
| `PUBLIC_URL` | `http://HOST:PORT` | The address links in Telegram messages point to, if your phone reaches the app by another address. Behind an HTTPS reverse proxy, set it to the proxy's address so the browser's requests pass the origin check. |

## Notifications

A debate stops and waits for you at a few moments: clarifying questions, an approval (goal, panel, plan), a question in the middle of the debate, a pause because your usage limit ran out, an error, and the finished report. The app tells you about those moments and nothing else.

**In the browser (on by default).** When a debate needs you, the tab title shows "(1) Needs you · The Debate App" and a dot appears on the tab icon. If you allow it, the browser also shows a notification; clicking it opens that debate. The browser only asks for permission when you click (starting a debate, your first approval, or the "Notify me" switch on the setup screen), never on page load. You can turn it off with the same switch.

Browser notifications need an open tab, and they only work on `http://localhost`, `http://127.0.0.1` or `https`. On a plain-HTTP LAN address you still get the title and icon badge, and the switch says so.

**On Telegram (optional, off unless you set it up).** The app can send a short message to your own Telegram when a debate needs you, so you hear about it with the tab closed or from your phone. It uses your own bot. It only sends: it never reads messages, you cannot control anything from Telegram, and nothing else ever goes to Telegram.

1. In Telegram, open **@BotFather**, send `/newbot`, pick a name and a username for your bot, and copy the token it gives you (it looks like `123456789:AAH...`). Keep it private: anyone with it can send messages as your bot.
2. Open your new bot in Telegram and send it any message, for example `/start`. A bot cannot message you until you have messaged it.
3. Find your chat id. Run
   ```bash
   TELEGRAM_BOT_TOKEN=123456789:AAH... npm run notify:chat-id
   ```
   and it prints `TELEGRAM_CHAT_ID=...`. (Or open `https://api.telegram.org/bot<token>/getUpdates` in your browser and read `message.chat.id`.)
4. Add both to `.env`:
   ```bash
   TELEGRAM_BOT_TOKEN=123456789:AAH...
   TELEGRAM_CHAT_ID=123456789
   ```
5. Run `npm run notify:test` and check Telegram for the test message.
6. Restart the app. The setup screen says "Telegram notifications are also on".

**What the message says.** By default only this, with no title, topic or anything from the debate: "The Debate App: a debate needs your answer." and a link to the debate. Set `TELEGRAM_DETAIL=title` to add the debate title. You get at most one message per debate every 30 seconds; anything in between is folded into one. If a link points at `127.0.0.1`, it only opens on the computer running the app; set `PUBLIC_URL` if your phone reaches it another way.

**The token** is read once when the server starts and then removed from its environment. It is never logged, never shown in the app and never returned by any API. If Telegram cannot be reached, the app logs it once and the debate carries on.

## Development

| Command | What it does |
|---|---|
| `npm run dev` | Server on :8794 (watch mode) and the web app on http://localhost:5173. |
| `npm run doctor` | First-run checklist: Node, Claude/OpenAI/Codex credentials (no model calls), port, data folder, SQLite. |
| `npm start` / `npm run demo` | Build if needed and serve; `demo` runs the real engine with scripted models, no credentials. |
| `npm run build` | Production build of the web app and the server bundle. |
| `npm run typecheck` | Type-check server and web. |
| `npm run qa` | Report renderer checks and the offline self-tests (prompts, OpenAI and Codex clients, floor director and the live floor, trailer, linter, dossier and ledger wiring, research contract, research cost budget, doors, start, human calibration, realism logic, budget, notifications, engine, the MOCK live path, web reducer, metrics, doctor). No network, no keys. |
| `npm run security-test` | Boots the server several ways (and the dev server) on port 8841 and attacks it, including the research desk, the upload and agent-tool rules, and the Telegram checks against a fake Telegram on your machine. `SECURITY_TEST_PORT` picks another port. |
| `npm run notify:test` | Sends one test message to your Telegram. Needs the two Telegram variables. Tests never run it. |
| `npm run notify:chat-id` | Prints the chat id of whoever has messaged your bot. Needs `TELEGRAM_BOT_TOKEN`. |
| `npm run import-backup -- <dir>` | Imports debates from an older data directory. Accounts and secrets are never imported. |
| `npm run metrics` | Measures a transcript (see `scripts/transcript-metrics.ts`). |

See [CONTRIBUTING.md](../CONTRIBUTING.md). The docs index is [docs/README.md](README.md).
