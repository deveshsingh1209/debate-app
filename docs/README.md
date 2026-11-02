# Documentation

Start with the [project README](../README.md) for what the app is, the quick start, credentials and troubleshooting.

| Document | Read it for |
|---|---|
| [HOW-IT-WORKS.md](HOW-IT-WORKS.md) | The app in plain language: who is in the room, what happens, what stays on your computer. |
| [CONNECT-YOUR-AI.md](CONNECT-YOUR-AI.md) | Plain-language setup for the four ways to connect an AI: Claude: sign in, Claude: API key, ChatGPT: Codex sign-in, OpenAI: API key. |
| [REFERENCE.md](REFERENCE.md) | Depth and cost, every setting, Telegram notifications, developer commands. |
| [DOCKER.md](DOCKER.md) | Running in Docker (advanced, optional). |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the app is built: one process, the append-only event log, providers and seat casting, the meeting loop, the budget, trade-offs. |
| [CONTRACT.md](CONTRACT.md) | The server/web contract: a debate's life, events and live frames, screens. `shared/types.ts` is the source of truth. |
| [ROADMAP.md](ROADMAP.md) | What is planned and not built yet. |
| [../SECURITY.md](../SECURITY.md) | The security model and how to report a problem. |
| [SECURITY-AUDIT-2.md](SECURITY-AUDIT-2.md) | The latest audit of the local single-user mode ([SECURITY-AUDIT.md](SECURITY-AUDIT.md) is the first). |
| [SECFIX-REPORT.md](SECFIX-REPORT.md) | What was fixed after audit 2, how each fix is tested, and what remains. |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | How to set up, test and send a change. |
| [PUBLISH-CHECKLIST.md](PUBLISH-CHECKLIST.md) | For the maintainer: exact steps to publish the repository and cut a release. |
| [../CHANGELOG.md](../CHANGELOG.md), [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) | What changed per version; third-party and font licences. |

## Project history (reports and plans)

These are dated records of how the project got here, not reference documentation. Where they disagree with the files above, the files above and the code win.

| Document | What it is |
|---|---|
| [PHASE1-REPORT.md](PHASE1-REPORT.md) | Phase 1: local-first, open-source rework. |
| [PHASE2-PLAN.md](PHASE2-PLAN.md) | The plan for the realism engine and budget profiles (its section 4 caps are superseded). |
| [PHASE2B-A-REPORT.md](PHASE2B-A-REPORT.md) | Phase 2b-A: event contract, floor director, budget profiles (its caps were later removed). |
| [BUDGET-REPORT.md](BUDGET-REPORT.md) | Cost caps removed: depth profiles, auto-deep, waste guards, quota pause and resume, optional ceiling. |
| [MERGE-REPORT.md](MERGE-REPORT.md) | How the worktree branches were merged into `integ`: conflicts, fixes, gate results, open questions. |
| [DOORS-REPORT.md](DOORS-REPORT.md) | The four doors made first-class: the Claude API key door, readiness probes, the Connect screen. |
| [START-REPORT.md](START-REPORT.md) | Double-click launchers, a self-installing `npm start`, the non-coder README. |
| [CALIB-REPORT.md](CALIB-REPORT.md) | Calibrating the realism metrics on real meetings (AMI, ICSI); details in [HUMAN-CALIBRATION.md](HUMAN-CALIBRATION.md). |
| [COSTFIX-REPORT.md](COSTFIX-REPORT.md) | The research desk's cost: search-only loop, server-side page reading, a metered 80,000-token budget per call. |
| [MERGE2-REPORT.md](MERGE2-REPORT.md) | How calib, start, doors, secfix and costfix were merged into `integ2`. |
| [RELEASE-REPORT.md](RELEASE-REPORT.md) | Public-release readiness: secrets and licence audits, report CSP and Chrome sandbox, CI matrix, release zip. |
| [SQLITE-REPORT.md](SQLITE-REPORT.md) | Node's built-in SQLite replaces better-sqlite3: no compiler to install, Node 22.13 minimum, the warning filter, old databases still open, audit and CI fixes. |
| [ENGINE-REPORT.md](ENGINE-REPORT.md) | Steps 2b-5 to 2b-7: dossiers, stakes and the belief ledger wired in, the new report sections, the calibrated realism index (every band decision), and the live floor director. |
