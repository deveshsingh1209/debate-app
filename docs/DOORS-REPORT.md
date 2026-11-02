# Doors report: four first-class ways to connect an AI

Date: 2026-10-26. Branch `wt/doors` (worktree `debate-wt-doors`), from `main` at `b9dfe5d`. Nothing pushed. No model calls, no real debates, no outside services.

## What changed

**Four doors, one order everywhere.** `shared/models.ts` now has `Provider = 'claude' | 'anthropic' | 'codex' | 'openai'`, in that order (Claude sign-in, Claude API key, Codex sign-in, OpenAI API key). `MODEL_IDS.anthropic` casts the same Opus 5.5 / Sonnet 5.5 / Haiku 4.5 ids as `claude`. A new `claudeEngine(p)` says which doors run on the Claude engine, and `isProvider()` validates a stored or requested door. Old debates still resolve through `providerOfConfig`.

**The Claude API key door (`anthropic`).** It runs on the same engine as the sign-in door: the Agent SDK spawns the Claude CLI. The only differences are the environment and the bill.
- `config.ts` reads `ANTHROPIC_API_KEY` once and deletes it from `process.env`, as it already did for the OpenAI key.
- `sdk.ts` keeps a per-debate `AnthropicKeys` binding. `claudeChildEnv(debateId)` sets `ANTHROPIC_API_KEY` only in the environment of a Claude CLI child that runs for a debate on this door, and withholds `CLAUDE_CODE_OAUTH_TOKEN` from that child so it cannot fall back to the subscription. Login-door debates and status probes never receive the key.
- The Claude CLI's error text is now redacted (`redactClaudeSecrets`) before it is logged or published. This also closes SECURITY-AUDIT-2's note that the Claude path ran no redaction. A refused key ("invalid x-api-key", "credit balance is too low") or a signed-out login becomes a `CredentialError`. The runner then parks the debate with a door-specific fix instead of retrying.
- Billing reads as `payg` (real money), the scope estimate says it is billed to the Anthropic key, research uses the Claude adapter, and the mock engines treat it as a Claude door.

**Readiness probe, no model call** (`server/src/doors/probe.ts`, pure, shared by server and doctor):

| Door | How it is checked | States it can report |
|---|---|---|
| Claude sign-in | `CLAUDE_CODE_OAUTH_TOKEN` present, else `claude auth status` (JSON `loggedIn`, exit code) | Ready; Needs setup (not installed, signed out); Problem (timed out, a CLI too old to say) |
| Claude API key | key present and shaped `sk-ant-` (not `sk-ant-oat` sign-in token, not `sk-ant-admin`, not an OpenAI `sk-`, no whitespace), plus `claude --version` for an installed engine | Ready; Needs setup; Problem with the exact misfiling |
| Codex sign-in | `$CODEX_HOME/auth.json` through the existing `validateCodexAuth` (with its free-plan and stale warnings as notes); when missing, `codex login status` explains why | Ready; Needs setup (not installed, signed out); Problem (API-key mode, login kept in the keychain, damaged file) |
| OpenAI API key | key present and shaped `sk-` (an `sk-ant-` key is flagged as misfiled) | Ready; Needs setup; Problem |

Each status carries a title, a one-line blurb, a summary, the exact fix (null when ready), full setup steps with copyable text, an optional note and a timestamp. No key, token, account e-mail or raw CLI output is ever in it. CLIs run with the API keys stripped from their environment, with an 8 s timeout. A probe that throws becomes `problem`, never a crash.

**Server** (`server/src/doors/index.ts`, `api.ts`):
- `GET /api/doors` returns `DoorsInfo` from a 30 s cache. `?fresh=1` re-checks (at most once every 2 s), and first re-reads the two keys from `.env`, so a pasted key works after Re-check with no restart. Only a value that differs from what `.env` held at boot is taken, so a real environment variable still wins over an untouched file.
- `POST /api/debates` now refuses a door that is not ready with its fix (it re-checks once before refusing). MOCK=1 still accepts any door.
- The route sits behind the existing Host, Origin and password gates.

**Web.**
- `/connect`, the Connect your AI screen: four cards, each with a Ready / Needs setup / Problem chip, a plain blurb, what was found, the fix, numbered steps with a Copy button for every command or line, a Re-check button and a "checked N s ago" stamp. A ready card folds its steps away and offers "Start a debate with this" (`/new?door=…`). The Copy button falls back to a textarea copy where the Clipboard API is unavailable (plain-HTTP LAN).
- It opens by itself once on first run when no door is ready (a localStorage flag). It is linked from the deck header and from the settings menu (a new "AI" row in the Sound and display popover), and the deck shows a "No AI is connected yet" note while nothing is ready.
- New Debate re-checks the doors on arrival and defaults to the first ready door (or `?door=` when that door is ready). Every door stays selectable and shows a status dot. When the chosen door is not ready, Start is disabled and the fix appears inline with Re-check and a link to /connect. If the doors check itself fails, Start is not blocked, because the server checks again.
- Styles use only design tokens (the brass accent is unchanged). Sound is untouched.

**Doctor.** It reports the four doors through the same probe, so the doctor and the app cannot disagree. The fix text tells a terminal user to re-run the doctor. "A provider to run debates" passes when any door is ready.

**Docs.** New `docs/CONNECT-YOUR-AI.md` (non-coder friendly, one section per door, how to open a terminal and edit `.env`). ARCHITECTURE, CONTRACT, `docs/README.md` and `.env.example` updated. `README.md` was not touched (another agent owns it). It still lists three providers and could link `docs/CONNECT-YOUR-AI.md`.

## Tests

- `server/src/doors/doors.selftest.ts` (112 checks, in `npm run qa`) covers the following:
  - every state of every door on fake machines
  - fake `claude` and `codex` executables on disk, run through the real `execFile` path, that log every call and flag any API key in their environment
  - the 30 s cache and Re-check
  - `.env` re-read without a restart
  - the key reaching only its own debate's Claude child, through the real `runAgent` dispatch with the SDK `query` swapped for a recorder
  - refused-key parking without retries, redaction of the key from errors
  - a key removed mid-session failing before anything spawns
  - no secret in any status
- `web/src/lib/door-view.selftest.ts`: default door choice and fix formatting.
- `scripts/doctor.selftest.ts`: rewritten for the four doors, including the API key door and misfiled keys.
- `security-test`: `/api/doors` lists four doors, carries neither canary key, is refused for a foreign Origin and needs sign-in in password mode. Neither key appears in any response or any server log.

## Gate results

| Gate | Result |
|---|---|
| `npm install` | done in the worktree |
| `npm run typecheck` | clean |
| `npm run build` | clean |
| `npm run qa` | all passed (doors 112/0, runner 102/0, design 205/0, doctor, door-view, every other suite as before). See the note on `CHROME_PATH` below |
| `npm run security-test` | 122 passed, 0 failed |
| MOCK=1 debate | Built server on port 8843, `MOCK_SPEED=10`, **on the new `anthropic` door**, driven through the clarify answers, the three approvals and the mid-debate question. It reached `complete` in 16 s with `report_ready`. The casting says "Claude API key session" with an Opus 5.5 chair. The canary key was absent from `/api/doors` and from the server log. The server was stopped and 8843 is free. |

`CHROME_PATH=none` as a command prefix was refused by this session's permission settings, so `npm run qa` ran without it. This machine has no Chrome, so PDF export was skipped the same way (`NoChromeError`), and the HTML report paths ran. The security test boots its own servers on its fixed ports (8891-8896), as before.

Not verified: the Connect and New Debate screens were not looked at in a browser (no Chrome here). They typecheck, build, and run on the same API the security test and the driver exercised.

## Open questions for the owner

1. **Claude Code as a dependency.** The API key door still needs Claude Code installed (no sign-in), because the SDK's bundled CLI (2.0.77) predates the current models. Shipping `@anthropic-ai/claude-code` as a server dependency would make that door zero-install. It would mean a large download for everyone, and its version would need managing. The probe reports this case as a Problem with the install command.
2. **An old Claude Code without `auth status`** is reported as a Problem ("probably out of date"), which blocks Start on that door. That is stricter than the old doctor's warning. It follows the "quality over cost" decision, because such a CLI cannot run the cast models.
3. **Entering keys in the app.** Keys are pasted into `.env` by hand (copy-paste of the exact line, then Re-check). A form that writes `.env` would remove the editor step for non-coders. It would also put a secret-accepting endpoint on the server. I did not build it.
4. **Codex keychain storage.** When Codex keeps its login in the OS keychain, the app cannot read it. The fix asks the user to set `cli_auth_credentials_store = "file"`. Please confirm that is the wording you want shown to non-coders.
5. **`README.md`** still describes three providers and their setup. Its owner should add the Claude API key row and link `docs/CONNECT-YOUR-AI.md`.
6. **Label wording.** Door titles are "Claude: sign in", "Claude: API key", "ChatGPT: Codex sign-in" and "OpenAI: API key". `PROVIDER_LABEL` (deck, war room, transcripts) keeps "Claude", "OpenAI API" and "ChatGPT (Codex)", and adds "Claude API key". Say if you want those unified.
