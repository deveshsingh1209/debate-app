# Roadmap

Honest about what is in 0.1.0 and what is not yet. Planned work can change; anything not under "What exists" is not built.

## What exists (0.1.0)

- **Runs on your own computer** with your own AI account: Claude sign-in, Claude API key, ChatGPT through Codex, or an OpenAI API key. Double-click launchers for Mac, Windows and Linux; a scripted demo (`npm run demo`) needs no account.
- **The debate:** intake and goal, an invented expert panel, an agenda of motions, rounds of argument judged by a referee, a ruling per motion attacked by an adversary desk, closings, and a written report (HTML always; PDF when Chrome or Chromium is installed). You approve the goal, the panel and the agenda, and can be asked questions mid-debate; an autonomous mode logs its assumptions instead.
- **Realism work so far:** a hidden turn trailer (stance, graded claims, questions), a rules linter that rewrites memo-like turns without changing their substance, and provider-neutral web research with cited sources on every door.
- **Quality before cost:** depth profiles (Auto, Quick, Standard, Deep), no default spending limit, an optional ceiling that asks rather than cuts, waste guards, and a quota pause that resumes by itself.
- **Survives restarts:** the append-only event log rebuilds every screen; a refresh or restart resumes where it was.
- **Safe by default:** listens on 127.0.0.1 only, Host/Origin/CSRF guards, an optional password, uploads fenced as untrusted, no web tools where uploads are read, sandboxed reports and an offline security test suite. Details and known limits: [SECURITY.md](../SECURITY.md).
- **Notifications:** tab badge and browser notifications; optional Telegram through your own bot.

- **A live floor:** a floor director picks who speaks and how long, turns are written in full and then played at speaking pace with cut-offs, talking-over and pauses; the chair speaks lightly on triggers. Persona dossiers with a diversity check, stakes, a belief ledger and report sections for stakes, how minds changed and the dissent record are in. The realism index is calibrated on open AMI and ICSI meeting data (honest limits are in [HUMAN-CALIBRATION.md](HUMAN-CALIBRATION.md)).

## Not yet proven

- **Real-run proof:** only one real session has been run (before the live floor existed, and its cost cap ended it before any expert argued). The live floor, the belief ledger and the tuned director numbers (reaction strength, cut rate, chair cooldown, checkpoint size) are proven on scripted models only.
- **Research cost:** a real web-search call on the Claude sign-in route cost about 4 USD in one measured run; this is being addressed inside each door (no third-party search, no other provider).
- **Calibration:** cost estimates, waste thresholds and the Auto depth rules are not yet calibrated on the current models.
- **The OpenAI and Codex doors and the two API-key doors** are built and tested with stand-ins; live proof needs keys or logins on a real run.

## Planned

- **Real-run proof:** complete sessions on each door with published transcripts, reports and measured spend.
- **Evidence discipline end to end:** every figure graded, traced to a source or a computation, and audited before the report.
- **UI:** accessibility pass and mobile layouts; refreshed screenshots.
- **Later:** an optional cross-provider mode where experts on Claude and OpenAI examine each other's arguments.

## Not planned

Hosted service, accounts, telemetry, or storing anyone's credentials. The app stays single-user and local.

The dated plans and reports in [docs/README.md](README.md#project-history-reports-and-plans) record how the project got here.
