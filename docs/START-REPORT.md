# Start report: non-coder install and README

Date: 2026-10-26. Branch `wt/start` from `main` at `b9dfe5d`. Nothing pushed. No model calls; servers only on port 8844 and stopped afterwards.

## Delivered

| Item | File | Notes |
|---|---|---|
| Mac launcher | `Start on Mac.command` | Checks Node (adds Homebrew, Volta, nvm paths because Finder has a bare PATH), explains how to install it and offers to open nodejs.org, then runs `scripts/start.mjs`. Plain text, no colour, no stack traces; waits for Enter only when something failed. |
| Windows launcher | `Start on Windows.bat` + `scripts/start-windows.ps1` | The .bat calls the PowerShell helper (`-ExecutionPolicy Bypass` for that one process only, no global change). Same checks and wording. Also looks in `Program Files\nodejs` for a just-installed Node. |
| Linux launcher | `Start on Linux.sh` | Same logic; `xdg-open` offered only if present. |
| One start script | `scripts/start.mjs` | All logic lives here, so the three launchers stay thin and behave alike: installs when `node_modules` is missing or `package-lock.json` is newer than the last install, builds when sources are newer than the output, skips both on repeat runs. Picks the next free port (up to +50) if the default is taken and says so. If the busy port is already this app, prints its link and opens it instead of starting a second copy. Prints a boxed `Open this link: ...` line. `--check` verifies Node, install, build and port, starts nothing and changes nothing. |
| Self-test | `scripts/start.selftest.mjs`, added to root `npm run qa` | `--check` exits 0 and starts nothing; busy port is reported with its replacement; a real MOCK start on 8844 answers `/api/health` and prints the link. Port 8845 is probed only, never served on. |
| README | `README.md` | Rewritten as a START HERE guide: 2-line pitch, two small screenshots, 3-step install per OS with every click, connect-your-AI (four setups, links `docs/CONNECT-YOUR-AI.md`), first debate walk-through, FAQ, troubleshooting, plain-language safety, contributor section last. |
| Reference | `docs/REFERENCE.md` | The old README's depth/cost, settings table, Telegram and developer-command sections, moved verbatim so nothing was lost. |
| How it works | `docs/HOW-IT-WORKS.md` | Plain-language page. |
| Misc | `.gitattributes` | `.bat` and `.ps1` keep CRLF, `.sh` and `.command` keep LF, so a ZIP or clone works on every OS. `docs/README.md` index updated. |

Only `package.json` was touched outside launchers, `scripts/`, `README.md` and `docs/` (the `qa` script gained the start self-test). No `server/` or `web/` source changed.

## Gates

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run build` | clean |
| `npm run qa` (no Chrome on this machine, so PDF was skipped as before) | all passed, including the new start self-test (3 passed) |
| `npm run security-test` | 109 passed, 0 failed |
| MOCK=1 debate (via `start.mjs --mock` on 8844, `MOCK_SPEED=10`, answered the clarify batch, approved each gate, answered the mid-debate question) | reached `complete`, `hasReport=true`, about 18 s; the server was stopped |

## Not verified

- **The three launcher files were not executed.** The sandbox refused to run shell scripts whose names contain spaces, so I reviewed them by reading only; `bash -n`, shellcheck and PowerShell were not run. The logic they contain is small (find node, check major version, call `scripts/start.mjs`), and everything after that point is covered by `start.selftest.mjs`. Please double-click each once on its OS.
- Mac Gatekeeper and Windows SmartScreen first-run prompts are described in the README from general knowledge, not observed.
- The exec bit on the `.command` and `.sh` files is set in the working tree; confirm `git ls-files -s` shows `100755` after commit (it does if the commit preserved it).
- Auto-open on Windows and Linux (`cmd start`, `xdg-open`) is untested; on failure it prints the link.
- A first install from a clean checkout (`npm install` over the network) was not re-run end to end; `node_modules` was installed once at the start of this task and the install-skip path is what the tests exercised.

## Open questions

1. **`ANTHROPIC_API_KEY` is not implemented on this branch.** The README names it as setup 2 (per the owner decision) but `git grep ANTHROPIC_API_KEY` finds only the README. Whoever builds the provider must land it, and `npm run doctor` and the New debate screen must show it, or the README line is untrue until then.
2. **`docs/CONNECT-YOUR-AI.md` does not exist yet** (another agent is writing it). The README links to it; the link is dead until that merges.
3. **Screenshots are stale.** `docs/screenshots` still shows the old per-depth dollar caps ("never more than $6") and "floor bids". The README says so in one line. Fresh screenshots of the New debate and room screens would be better; I could not take them without a browser.
4. **Default port.** It is 8794 (the brief mentioned 8787). I kept 8794 so existing docs, Docker and tests stay valid.
5. **Mac without a signed app.** Double-clicking an unsigned `.command` always triggers a Gatekeeper prompt for ZIP downloads (cloned repos do not). The README explains right-click then Open. Signing or notarising is out of scope for a script.
6. The old README's "Credentials" section (provider table with model names) was dropped in favour of the four-setup summary; the model table remains in `docs/ARCHITECTURE.md`.
