# Contributing

Thanks for helping. This is a local-first, single-user app: it runs on your machine with your own credentials, and contributions should keep it that way.

## Ground rules

- **No hosted-service assumptions.** No accounts, telemetry or credential storage. Credentials stay with the user's own CLIs and environment.
- **No live model calls in tests.** Every check in `npm run qa` is offline. Use `MOCK=1` or the fake agent seam (`wireAgents` in `server/src/agents/sdk.ts`) rather than spending quota. Please do not run real debates in CI or ask reviewers to.
- **`shared/types.ts` is the contract** between server and web. Extend it; do not invent parallel types. Model ids live only in `shared/models.ts`, and budget numbers only in `shared/budget.ts`.
- **Keep the event log honest.** The append-only event log is the source of truth (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)). New behaviour should be derivable from events so a restart or refresh resumes correctly.
- **Document only what exists.** Mark planned work as roadmap in [docs/ROADMAP.md](docs/ROADMAP.md).

## Setup

Node 22 or newer.

```bash
npm install
MOCK=1 npm run dev     # scripted debate, no credentials needed
```

## Before you open a pull request

All four must pass; CI runs the same:

```bash
npm run typecheck
npm run build
npm run qa
npm run security-test
```

If you change prompts, the engine, the budget or the report, add or extend the matching self-test (`server/src/**/*.selftest.ts`, `web/src/lib/debate-state.selftest.ts`). If you change the access layer, extend `server/scripts/security-test.mts`.

## Pull requests

- Keep them small and focused; one concern per PR.
- Explain the why in the description, and say how you tested it.
- UI changes: describe what you looked at in a browser. Typechecks do not verify a screen.
- Do not commit `.env`, `data/`, or anything containing credentials.

## Reporting bugs and security problems

Use the issue templates for bugs and ideas. For security problems follow [SECURITY.md](SECURITY.md) and do not open a public issue.

## Conduct

Be kind. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
