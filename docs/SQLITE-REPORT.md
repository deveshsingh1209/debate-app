# Built-in SQLite report (branch `fix/builtin-sqlite`, 2026-11-02)

The first public CI run showed `npm ci` failing on Windows: `better-sqlite3` 13.0.3 publishes no prebuilt binaries (its GitHub release has no assets), so npm compiled it with node-gyp. That needs Visual Studio Build Tools on Windows, Xcode Command Line Tools on a Mac and build-essential on Linux. Installing has to work for non-coders with no compiler, so the app now uses Node's own SQLite.

## Outcome

| | Before | After |
|---|---|---|
| SQLite | `better-sqlite3` 13.0.3, compiled at install | `node:sqlite` (`DatabaseSync`), part of Node |
| Compiler needed to install | Yes, on every OS | No (checked in CI on every OS) |
| Node | `>=22` | `^22.13.0 \|\| >=23.4.0` |
| `npm audit` | 3 moderate (glob/minimatch) | 0 |
| Docker build stage | installs python3, make, g++ | nothing extra; Node 24 LTS |

The database file (`data/debate.db`), its schema, WAL mode and `synchronous=NORMAL` are unchanged. An existing `data/` folder opens as it is.

## Which Node version

The rule was: the lowest Node where `node:sqlite` works without a flag, and the user never sees an experimental warning.

Only Node 26.12.1 runs on this Mac (arm64, no Rosetta, Docker not running). Older versions were checked from the official `node-darwin-x64` builds on the npm registry by reading two things in each: the `lib/sqlite.js` source that Node embeds in its binary, and the release CHANGELOG shipped in the tarball.

| Node | `node:sqlite` without a flag | Prints `ExperimentalWarning: SQLite is an experimental feature` |
|---|---|---|
| 22.12.0 and older | No (`--experimental-sqlite`) | — |
| 22.13.0 – 22.23.4 (all 22.x so far) | Yes ("unflag sqlite module", #55890) | Yes |
| 23.0 – 23.3 | No | — |
| 23.4.0 – 23.11 | Yes | Yes |
| 24.0.0 – 24.14.0 | Yes | Yes |
| 24.15.0 and later | Yes | No ("sqlite: mark as release candidate", #61262) |
| 25.0.0 – 25.6.1 | Yes | Yes |
| 25.7.0 and later, 26.x | Yes | No |

Builds inspected directly: 22.12.0, 22.13.0, 22.23.4, 23.4.0, 24.0.0, 24.13.0, 24.14.0, 24.15.0, 24.22.2, 25.6.1, 25.7.0, 26.0.0, plus the CHANGELOGs of 22.13.0 and 24.15.0. The ranges between them follow from where the change landed. 26.12.1 was also run: no warning.

Requiring 24.15 would have avoided the warning without a filter, but it turns away every Node 22 LTS user, which is a lot of people. The app requires **22.13.0** and drops that one warning instead:

- `server/src/sqlite.ts` loads the module with `process.getBuiltinModule('node:sqlite')`, not a static import. A static import would load the module, and print the warning, before any app code runs.
- For that one synchronous load only, `process.emitWarning` is wrapped so a warning whose message starts with "SQLite is an experimental feature" is dropped. The original is restored straight after. Every other warning still prints, and there is no `--no-warnings`. Node prints the SQLite warning once per process, so nothing can print it later.
- If the module is missing (Node too old), the error says which Node is needed and where to get it, not a stack trace.

The same rule (22.13+, or 23.4+ on the 23 line) is in `engines`, `scripts/start.mjs`, `Start on Mac.command`, `Start on Linux.sh`, `scripts/start-windows.ps1` and `npm run doctor` (`nodeSupported()` in `server/src/sqlite.ts`). Each one says, in plain words, that the LTS installer from nodejs.org updates an older Node in place.

## The port

`server/src/sqlite.ts` is the only place that opens SQLite:

- `openDb(file, { readOnly })` opens a `DatabaseSync` with `PRAGMA busy_timeout = 5000`, better-sqlite3's default timeout. `readOnly` opens without create, so a missing file is an error (better-sqlite3's `fileMustExist`).
- `transaction(db, fn)` replaces `db.transaction(fn)`: BEGIN/COMMIT, ROLLBACK on throw, and SAVEPOINTs when nested, as better-sqlite3 did. A rollback that fails because SQLite already rolled back does not hide the original error.
- Other defaults already match: foreign keys are on, and double-quoted string literals are off, in both libraries.

Callers ported: `server/src/db.ts` (WAL and synchronous pragmas through `exec`; `Events.append` through `transaction`), `server/scripts/import-backup.mts`, `scripts/transcript-metrics.ts`, `scripts/eval/eval-lib.ts` and `scripts/doctor.ts`. Statement calls (`prepare`, `run`, `get`, `all`, `exec`, `VACUUM INTO`) needed no change. Integers come back as JavaScript numbers in both libraries.

Removed: `better-sqlite3` and `@types/better-sqlite3` from `server/package.json`, those two and `node-addon-api` from the lockfile and THIRD_PARTY_NOTICES.md, and `--external:better-sqlite3` from the esbuild command (its target is now node22). The esbuild bundle contains `getBuiltinModule("node:sqlite")` and no `better-sqlite3`. The repo had no electron, rebuild or prebuild config.

## An existing database still opens

There was no database fixture in the repo, so one was made with the **old** code: 0.1.0 with better-sqlite3 built locally, 3 debates (unicode topic, personas, meta with a pending approval, a limit pause, a pending question), 7 events, WAL mode. It is committed as `server/fixtures/debate-better-sqlite3.db` (24 KB, invented data only).

- Old code against a copy, then new code against a fresh copy: every value `Debates.list()`, `Debates.get()` (3 rows), `Events.since/recent/lastSeq` returned was dumped as JSON. The two dumps are **byte-identical**.
- `server/src/sqlite.selftest.ts`, now the first suite in `npm run qa` (and in the Windows CI runner), opens a copy of the fixture with the new code and checks:
  - the reads above;
  - new writes continue the event sequence;
  - `journal_mode=wal`, `synchronous=1`, `busy_timeout=5000`;
  - commit, rollback and nested savepoints in `transaction`;
  - `VACUUM INTO` backups, which open read-only and reject writes;
  - a missing file opened read-only is not created;
  - the warning filter drops only the SQLite warning and is removed afterwards;
  - no SQLite warning reaches the process;
  - `engines` matches `nodeSupported()`.
- `npm run import-backup` imported a renamed copy of the fixture (3 debates, 7 events) through the new transaction helper.

## Native code left in the install

`scripts/ci/no-native-build.mjs` (new, runs after `npm ci` in every CI job) walks `node_modules`. It fails if any package's install scripts run node-gyp, prebuild-install, node-pre-gyp or cmake-js, or if a package carries a `binding.gyp` that npm would build. Today: 156 packages, none. A fake `prebuild-install || node-gyp rebuild` package was caught (exit 1).

Native binaries that remain, all prebuilt and downloaded per platform, none compiled:

| Package | Prod/dev | How it installs |
|---|---|---|
| `@img/sharp-*` and `@img/sharp-libvips-*` 0.33.5 / 1.0.x | prod, optional deps of `@anthropic-ai/claude-agent-sdk` | Prebuilt `.node` and libvips per OS/CPU (`os`/`cpu` fields); no install script. The SDK does not depend on `sharp` itself. There is no win32-arm64 build; it is optional, so npm skips it. |
| `@anthropic-ai/claude-agent-sdk` vendored ripgrep | prod | `ripgrep.node` files shipped inside the package for each platform |
| `esbuild` 0.28.2 (`@esbuild/<platform>`) | dev (needed for the first-start build) | Prebuilt binary; its `postinstall` only checks the binary |
| `rolldown` (`@rolldown/binding-*`), `lightningcss-*` | dev (Vite) | Prebuilt `.node` per platform |
| `fsevents` 2.3.3 | dev, macOS only | Ships a prebuilt `fsevents.node`; no build script runs at install |

A clean `npm ci --foreground-scripts` on this Mac ran exactly one install script, esbuild's `node install.js`.

## npm audit (task 2)

`@fastify/static` (10.1.7, and 10.1.8, the latest) asks for `glob ^13`. That brings in minimatch 10: GHSA-3g3m-2fjr-6pw4 (glob ≤ 14.0.1) and GHSA-g3hv-75wg-m249 (minimatch < 11.0.1). A root `"overrides": { "glob": "^14.0.3" }` resolves glob 14.0.3, minimatch 11.0.4 and path-scurry 3.0.0. glob appears once in the tree.

Why this is safe:

- `@fastify/static` calls `glob('**/**', { cwd, absolute, follow, nodir, dot, ignore })` only when `wildcard: false`. glob 14 keeps that API and its CommonJS export. The app registers `wildcard: true`, so glob is loaded but never called.
- Both modes were run against glob 14 with `fastify.inject`: files served, 404 for missing files and paths above root, and the `wildcard: false` route table built by glob.
- The browser suite (`npm run e2e`, 31 tests) serves the built app through `@fastify/static`: all passed.

`npm audit` (any level) reports 0 vulnerabilities. The CI step stays `--audit-level=moderate`. The CHANGELOG "Known issues" note is removed.

## CI (task 3)

- New "No native compile" step after `npm ci` in every job (Linux, macOS, Windows).
- New job `ubuntu-latest / Node 22.13.0`: the engines minimum, and a Node that does print the SQLite warning, so the filter is exercised for real in CI. Every dependency's `engines` accepts 22.13.0; no API newer than 22.13 is used outside the browser.
- Windows keeps `continue-on-error`: it cannot be run here. The comment now records why its first run failed (compiling better-sqlite3) and why that cannot happen now. Remove the line after its first green run, and add the Windows and 22.13.0 checks to branch protection (docs/PUBLISH-CHECKLIST.md lists 22.13.0).

## Verification on this machine (macOS arm64, Node 26.12.1, npm 11.20.0)

From an empty `node_modules`, all exit 0:

| Command | Result |
|---|---|
| `npm ci` | 158 packages; only esbuild's postinstall ran; 0 vulnerabilities |
| `node scripts/ci/no-native-build.mjs` | 156 packages, none compiles |
| `npm run typecheck` | clean |
| `npm run build` | clean (bundle uses `node:sqlite`) |
| `npm run qa` | all suites, including `sqlite selftest: ok`, `doctor selftest: ok`, `start selftest: 3 passed` |
| `npx tsx scripts/doctor.selftest.ts` | ok (now also runs the real built-in SQLite check) |
| `npm run security-test` | 254 passed, 0 failed |
| `node scripts/release/scan-secrets.mjs` | clean |
| `node scripts/release/licenses.mjs` | 98 packages; only the two known reviewed items |
| `npm audit --audit-level=moderate` | 0 vulnerabilities |
| `E2E_PORT=8942 npm run e2e` | 31 passed |

No ExperimentalWarning or SQLite error appears in the e2e or security-test server logs. No server was left listening.

## Not verified here, and other notes

- **Windows** was not run (no Windows machine). The change removes the step that failed there, and the new CI check covers installs on Windows.
- **Node 22.13–24.14** were not executed locally (the only runnable Node is 26). The filter was tested by emitting the exact warning text. The real filter runs in CI on Node 22.13.0 and the latest 22.x.
- `scripts/release/licenses.mjs --write` listed this repo's own workspaces as third-party under npm 11.20, which reports workspace paths under `node_modules`. It now also skips `resolved: file:` entries. THIRD_PARTY_NOTICES.md was regenerated: glob 14 tree in, better-sqlite3 and node-addon-api out.
- Spotted, not changed: with `wildcard: true`, `@fastify/static` served a dotfile from the root in the test above. The built `web/dist` has no dotfiles, so the app is unaffected; worth knowing if anything else is ever served from that folder.
- `npm run qa` and `npm run security-test` start their own short-lived servers on 8844 and 8841 by design. The only other server was the e2e one, on 8942.
