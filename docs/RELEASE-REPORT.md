# Release report: public-release readiness (`wt/release`)

Branch `wt/release`, from `main` at `58aebba`. Nothing was pushed and there is no remote. No model calls, no real debates and no quota were used. The only network access was the npm registry (`npm install` and `npm audit`). No engine, agent or realism code was changed (`server/src/engine`, `server/src/agents`, `server/src/realism` are untouched).

## Gate results (final tree)

| Gate | Result |
|---|---|
| `npm run typecheck` | pass (server and web) |
| `npm run build` | pass |
| `npm run qa` | pass, exit 0. Print QA measured every hostile fixture clean with Chrome's sandbox **on**. |
| `npm run security-test` | **252 passed, 0 failed** (243 before; 9 new checks for the report policy and the Chrome sandbox) |
| MOCK=1 debate on port 8862 | Started through the real launcher (`scripts/start.mjs --mock --no-open`), which printed "Open this link: http://127.0.0.1:8862". `GET /` returned 200 with no outside references. A driver played the founder through the API (clarify, three approvals) and the debate reached `complete`. `/report` returned 200 with the policy in both the header and the document. The server was stopped and port 8862 is free. |
| `npm audit` | 0 vulnerabilities (`npm audit signatures`: 44 packages with verified attestations) |
| `node scripts/release/scan-secrets.mjs` | clean on the tree, with a private terms list as well |
| `node scripts/release/licenses.mjs` | exit 0: every production licence allowed or reviewed |
| Release zip | `release/debate-app-0.1.0.zip`: 236 files, the two launchers stored as Unix 0755, no `node_modules` |

## 1. Secrets and personal data

I wrote `scripts/release/scan-secrets.mjs`, an offline scanner with no dependencies. It covers tracked files, and with `--history` every commit message and diff on every ref. It looks for:
- provider keys and tokens (Anthropic, OpenAI, GitHub, Slack, AWS, Google, Telegram bot tokens, JWTs, private keys, assigned secrets)
- email addresses, phone numbers and public IP addresses
- tunnel hosts (`*.ts.net`, ngrok, trycloudflare)
- home-directory paths, and the commit authors' names outside LICENSE, CODEOWNERS, package.json and author lines
- `--terms <file>`: a private word list kept outside the repo, so the scanner itself names nothing personal

Credentials are masked in its output. The test suites' fake keys are allowed by their markers (`CANARY`, `SELFTEST`, …).

**Tree: found and fixed.** No credentials anywhere. There were four personal leftovers, all in docs, now generalised:
- the owner's home path in `CALIB-REPORT.md` and `HUMAN-CALIBRATION.md`
- the owner's home path, an old backup folder name and an old server path in `PHASE1-REPORT.md`
- that report's quoted grep, which named an old hosting provider and a personal domain

The screenshots show only the fictional mock debate. Their EXIF block is 76 bytes (dimensions only, no author, GPS or software tags).

**History: no credentials, but not fresh.** There are 98 commits from one author, `Devesh Singh <devesh@users.noreply.github.com>`. Deleted lines in older commits still carry:
- a previous personal domain and its hosting provider
- a server home directory and that server's size ("shared with 8 other services")
- local session paths
- the owner's first name in the removed hosted-era sign-in code (for example an error asking users to get the owner's approval by name)

Nothing there is a secret, but it is personal. **Recommendation: publish the final tree as one new commit.** `docs/PUBLISH-CHECKLIST.md` §3 has the exact commands. I ran the same procedure in a scratch clone (`.scratch/pubtest`, git-ignored), and `--history` on it was clean. The history also contains the deleted Remotion project (`motion/`). Remotion's licence is not OSI. That project only depended on Remotion and did not vendor it, and a fresh history removes the question anyway.

## 2. Dependency licences

`scripts/release/licenses.mjs` reads `npm ls --omit=dev --all` and each package's own `package.json` and LICENSE file, all offline. It flags anything outside MIT/ISC/BSD/Apache-2.0/MPL-2.0/CC0/0BSD/OFL-1.1/BlueOak-1.0.0/Unlicense. With `--write` it regenerates `THIRD_PARTY_NOTICES.md`: a font attribution table, the full package table, and each distinct licence text once.

There are 99 production packages:

| Licence | Packages |
|---|---|
| MIT | 73 |
| OFL-1.1 | 5 |
| ISC | 5 |
| BlueOak-1.0.0 | 5 |
| Apache-2.0 | 4 |
| BSD-3-Clause | 4 |
| 0BSD | 1 |
| LGPL-3.0-or-later | 1 |
| proprietary | 1 |

Two needed review:

- **`@anthropic-ai/claude-agent-sdk` is proprietary.** Its LICENSE reads "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements…".
  - The app depends on it and npm installs it on the user's machine, so this project does not redistribute it.
  - The release zip deliberately ships no `node_modules`.
  - A published Docker image *would* redistribute it; see open questions.
- **`@img/sharp-libvips-*` is LGPL-3.0-or-later.** It is an optional prebuilt shared library that the Agent SDK pulls in. It is loaded dynamically, not modified and not shipped, so it is fine for this project.

**Fonts** are all SIL OFL 1.1 and self-hosted through Fontsource: Source Serif 4, IBM Plex Sans, Inter, JetBrains Mono and Rajdhani. They are bundled into `web/dist` and inlined into reports, which the OFL allows as long as the notice and licence travel with them. `THIRD_PARTY_NOTICES.md` carries both. Fontsource's copy of the Source Serif licence names no holder, so the notice uses Adobe's upstream line.

## 3. Security follow-ups (audit 2, finding 6)

- **No-egress report policy.** `server/src/report/csp.ts` holds one policy. It allows nothing from anywhere: `default-src 'none'`, with only inline script and style, `data:` fonts and images, and no connect, frames, workers, forms or base. It is used in three places:
  - **In the document head.** The report (`render.ts`) and the transcript (`transcript-pdf.ts`) write it as a `<meta>`, placed before their styles. A downloaded copy opened from disk keeps it.
  - **In the served response.** `/report` sends it as a header after `sandbox …`. The route also adds the `<meta>` to any stored report that lacks it: older reports, the mock's placeholder, and the engine's plain-`<pre>` fallback.
  - **In PDF printing and print QA.** `withReportCsp()` adds it before Chrome loads the `file://` page.

  Source links still open on click, since navigation is not governed by CSP. The audit's proposal allowed Google Fonts origins; those are gone because fonts are self-hosted.
- **`--no-sandbox` removed by default.** Chrome now prints with its sandbox on (verified on macOS: a 945 KB PDF and print QA both ran with no flag). The fallback is automatic and logged once. It applies only when Chrome's stderr says the sandbox cannot start (no usable sandbox, setuid or namespace sandbox), when running as root, or when `CHROME_NO_SANDBOX=1` is set. This is the case on Ubuntu 23.10+ with AppArmor, so GitHub's Ubuntu runners will exercise it. Documented in SECURITY.md, REFERENCE.md and `.env.example`.
- **PDF export needs Chrome or Chromium.** The README already said so; REFERENCE and SECURITY now say it too, and the HTML report always works.
- **Tests.** security-test part A checks the served header and the `<meta>` on an old-style report. A new part J checks the policy in both documents, that no document names an outside origin, the fallback for older reports, and the sandbox default and its override.

## 4. CI and GitHub

- **`ci.yml`**: a matrix of `ubuntu-latest`, `macos-latest` and `windows-latest` × Node 22 and 24.
  - Each job runs typecheck, build and qa, plus security-test on Linux and macOS.
  - Windows runs `scripts/ci/qa.mjs`, which reads the suite list from the package.json files so it cannot drift. It skips two POSIX-only suites with the reason printed: doors (fake CLIs are `#!/bin/sh` scripts) and codex (0600 file modes).
  - Windows also skips security-test, which needs POSIX signals, paths and sandbox rules.
  - Windows jobs are `continue-on-error` until their first green run, because I could not run Windows here.
  - A `hygiene` job runs the secrets scan, the licence audit and `npm audit`.
- **`release.yml`**: on a `v*` tag it checks the tag against `package.json`, re-runs every gate, builds `debate-app-<version>.zip` with `scripts/release/make-zip.mjs`, and checks with `zipinfo` that both launchers are `-rwxr-xr-x`. It then uploads the artefact and opens a **draft** release with notes taken from CHANGELOG. Nothing is published without a person.
- **The zip** is the HEAD tree under `debate-app-<version>/`, with git's file modes stored as Unix attributes and no `node_modules` or build output. GitHub's "Download ZIP" drops exec bits. The README now points to Releases first and keeps the right-click / `chmod` fallback, with a line on why it may be needed.
- **Other files:**
  - `dependabot.yml`: npm weekly (minor and patch grouped), Actions monthly.
  - `CODEOWNERS`: `* @devesh`.
  - SECURITY.md now names GitHub private vulnerability reporting, with the direct link, and states the supported versions.
  - The issue templates use the four setup names and depth instead of "budget profile", and ask for the start-window text. Their security contact link is now repository-specific.

## 5. Repo hygiene

- **`.gitignore`**: added `*.pem`, `*.p12`, `.npmrc`, `Thumbs.db`, `*.tsbuildinfo`, `coverage/`, `.vscode/`, `.idea/` and `/release/`. The last one is root-anchored; a first `release/` also matched `scripts/release/`, and that was caught.
- **`.dockerignore`**: added `release` and key files.
- **`package.json`**:
  - name `debate-app`, version `0.1.0`, description, `license: MIT`, author, `engines.node >=22`
  - `repository`, `homepage` and `bugs` with the `<owner>/<repo>` token
  - workspaces at 0.1.0 with MIT
  - lockfile updated offline
- **New files.** `CHANGELOG.md` has the 0.1.0 section, which is also the draft release notes. `docs/ROADMAP.md` is rewritten as "What exists / In progress / Planned / Not planned". The old one still called Phase 1 "this release" and listed done work as planned.
- **Small doc fixes:**
  - REFERENCE: a broken roadmap link, and the missing `ANTHROPIC_API_KEY` and `CHROME_NO_SANDBOX` rows
  - `.env.example` pointed Telegram setup at README instead of REFERENCE
  - docs index: entries for the checklist, CHANGELOG and notices

## 6. Publish checklist

`docs/PUBLISH-CHECKLIST.md` covers:
- every place that needs the real URL, with a grep to confirm none is left
- pre-flight gates and manual checks
- the fresh-history publish and `gh repo create OWNER/REPO --public --source . --push`
- the repository settings: private vulnerability reporting, Dependabot alerts, secret scanning, branch protection, topics
- tagging and the draft release, and what to try on the downloaded zip
- the first-release announcement draft and post-publish checks

## Commits

| Commit | What |
|---|---|
| `90b5761` | No-load CSP in reports and transcripts; Chrome sandbox on, with fallback; security tests |
| `32590a0` | Secrets and personal-data scanner; home paths and old host names removed from docs |
| `6680420` | Licence audit script and THIRD_PARTY_NOTICES.md |
| `757a11f` | CI matrix, release workflow and zip builder, Dependabot, CODEOWNERS, package metadata, .gitignore |
| `2ab4cf4` | CHANGELOG, roadmap, SECURITY contact, README release-zip steps, issue templates |
| `3a36494` | The served report always carries the in-document policy; publish checklist |
| (this commit) | This report |

## Uncertainties

1. **Windows CI has never run.** `scripts/ci/qa.mjs` skips the two suites I know are POSIX-only. Others may still trip on Windows paths, for example `/usr/bin/false` as `AGENT_CLI_PATH` in four self-tests; it should just fail to spawn, which those tests expect. That is why Windows does not block.
2. **The workflows were not executed or linted.** GitHub Actions cannot run here, and YAML checks through ruby or python needed approvals I did not have. The files were reviewed by hand. The zip's exec bits were checked by reading the zip's central directory (0755 for both launchers). Extracting it with macOS's own tools also needed an approval, so Archive Utility's handling was not observed.
3. **The Chrome sandbox fallback is tested by its parts, not end to end.** The stderr pattern comes from Chrome's known messages, and the default and override flags are tested. A real "no usable sandbox" host (Ubuntu 24.04 CI) will be the first end-to-end run.
4. **The served report's CSP and `sandbox` are combined in one header.** Browsers accept that. Report scripts (expand and collapse) were exercised by print QA in Chrome under the meta policy, and every fixture measured clean. Firefox and Safari were not checked in a browser.
5. **`CODEOWNERS` uses `@devesh`** as the brief asked. If that is not the publishing account's handle, GitHub ignores the line.

## Open questions for the owner

1. **Fresh history or full history?** I recommend publishing a single fresh commit (checklist §3). The 98-commit history has no secrets, but it does expose a previous personal domain, server details and hosted-era code naming you. If you want to keep the history, say so and I will instead list exact `git filter-repo` replacements.
2. **Docker image.** The Dockerfile bakes in `node_modules`, which includes the proprietary Claude Agent SDK, and globally installs `@anthropic-ai/claude-code`. Building it locally is fine. **Publishing** an image (Docker Hub or GHCR) would redistribute Anthropic's code, so I added no image-publishing workflow. Should that stay local-build-only?
3. **The publishing account and repository name** (`OWNER/REPO`) and the public committer email. The checklist suggests a `users.noreply.github.com` address.
4. **`LICENSE`** reads "Devesh Singh and contributors". Should it be you, or a company?
5. **Code signing.** macOS Gatekeeper and Windows SmartScreen will still warn on first open of the launchers. The README handles this with right-click → Open and "More info → Run anyway". Signing and notarising would remove the warnings but needs paid developer accounts. Is that out of scope for now?
