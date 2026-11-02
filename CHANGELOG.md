# Changelog

All notable changes are recorded here. Versions follow [Semantic Versioning](https://semver.org/); while the version starts with 0, anything may change between minor versions.

## [Unreleased]

### Added
- Double-click "Try Demo" launchers for Mac, Windows and Linux.
- docs/PROGRESS.md: a living status board, plan and work log.
- A `persona` evidence grade for a panelist's own backstory. The report lists these anecdotes in a "Panel Anecdotes, Not Evidence" section, and decision trails and numbers-audit rows that rest on one are labelled as assumptions.
- `npm run eval -- <run> --evidence` re-grades a saved run's claims under the evidence rules and lists every claim moved.

### Changed
- `observed` now means only a fact the founder supplied (brief, answers, uploads) or a research finding cited by id. The server regrades any other `observed` claim before anyone reads it, and a ruling graded observed with nothing observed under it is graded assumed.
- The realism lint flags first-person anecdote told as fact (recorded, never rewritten).
- Cost estimates in the app, README and reference docs are labelled uncalibrated; actual usage can be much higher.
- The Claude sign-in readiness check uses the same isolated settings as the agents, so a global API-key helper no longer makes the door look ready.

### Fixed
- Claude Code error results are no longer accepted as answers; an expired sign-in is reported as a sign-in problem.
- The launcher no longer reuses a running demo server for a real session (or the reverse).
- The dissent section no longer repeats a deadline; chart value labels no longer overflow the chart.

### Fixed (from the first real end-to-end debate, 2026-10-28)
- Evidence honesty: a new `persona` grade for a panelist's own backstory; `observed` is reserved for founder-supplied facts and cited research, and a server-side check regrades anything else. The report lists persona stories under "Panel Anecdotes, Not Evidence", and numbers that rest on them are labelled as assumptions. See docs/EVIDENCE-REPORT.md.
- Session length: Quick, Standard and Deep have real per-motion and per-session round and message budgets; the referee closes a settled motion. See docs/FLOW-REPORT.md.
- Research cost: one search per call by default (one more only for a named gap), trimmed results, a token envelope, reuse of earlier answers, and a per-call token and cost log. See docs/COST-REPORT.md.
- Pause and resume: a pause never rules, closes or advances a motion; resume continues at the exact step, including the adversary round, through closings and the report.
- The browser tests no longer assume a fixed port; the doctor self-test matches the isolated Claude sign-in check.

### Fixed (2026-11-01, after a live debate on a real business question)
- Agents no longer load the user's claude.ai connectors or user-scope MCP servers; these added a ~46,000-token block of tool definitions to some sessions.
- The research token envelope counts only what research adds, never stops a call before its first search, and a stopped call says "Research incomplete" instead of returning nothing. The write step's input is capped, and a double-counting bug in the token meter is fixed.

### Known issues
- `npm audit` reports 3 moderate advisories in `glob`/`minimatch`, pulled in by `@fastify/static`. They affect glob patterns, which the app sets itself (never from user input); the only automatic fix is a breaking downgrade, so they are tracked rather than forced.
- Evidence grading, research cost, the research envelope fix and Quick session length are proven in live debates (2026-11-01). Pause/resume is proven offline only; Standard and Deep lengths are not yet calibrated live.

## [0.1.0] - 2026-11-02

The first open-source release. It runs on your own computer with your own AI account; there is no hosted service.

### What you can do
- Describe a decision and watch a panel of AI experts argue it out live, chaired by Marcus, then read a written report with a ruling on every question (HTML; PDF when Chrome or Chromium is installed).
- Connect one of four AI setups: Claude sign-in, Claude API key, ChatGPT through Codex, or an OpenAI API key. A Connect screen checks each one and says what to do; Re-check picks up a new key without a restart.
- Start it with a double-click on Mac, Windows or Linux. The first start installs and builds by itself. `npm run demo` plays a scripted debate with no AI account.
- Choose how deep the room argues (Auto by default). There is no spending limit unless you set one; running out of quota pauses the debate and it resumes by itself.
- Close the tab or restart the app at any point: debates resume where they were.
- Get told when a debate needs you: tab badge, browser notification, optional Telegram through your own bot.

### Safety
- Listens on 127.0.0.1 only; Host, Origin and CSRF guards; an optional password, required for any other address.
- Uploaded files are treated as untrusted; seats that read them hold no web tools; research questions are checked before they are sent.
- Reports run sandboxed and may load or send nothing (Content-Security-Policy in the header and inside every report and transcript). PDF printing keeps Chrome's sandbox on wherever it can run.
- An offline security test suite (`npm run security-test`) and a public threat model in SECURITY.md, including what it does not defend against.

### Project
- MIT licence; third-party licences and font attributions in THIRD_PARTY_NOTICES.md.
- CI on Linux, macOS and Windows with Node 22 and 24; a release workflow that builds `debate-app-<version>.zip` with working launchers; Dependabot.
- Offline release checks: `scripts/release/scan-secrets.mjs` and `scripts/release/licenses.mjs`.

### Known limits
- The floor director is wired into real debates; one real end-to-end debate has been run (see docs/PROGRESS.md).
- The OpenAI and Codex doors, and the live Claude CLI hooks, have been tested offline only.
- Cost estimates are not yet calibrated on the current models; they are information, never a limit.
- The README screenshots show an earlier version.

[Unreleased]: https://github.com/deveshsingh1209/debate-app/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/deveshsingh1209/debate-app/releases/tag/v0.1.0
