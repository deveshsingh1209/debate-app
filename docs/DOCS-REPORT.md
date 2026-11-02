# Docs report: open-source readiness

**Branch:** `wt/docs`. Documentation and repository files only; no code changed, so typecheck, build, qa and security-test are unaffected (not re-run). No server was started, no model call made.

## Added
- `README.md` rewritten: what it is, 60-second quick start (plus a `MOCK=1` path), credentials per provider, what a debate is like, budget profiles, configuration, FAQ, troubleshooting, development commands.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1 short form).
- `.github/`: bug and feature issue templates, issue config pointing security reports to private advisories, PR template, `workflows/ci.yml` (typecheck, build, qa, security-test on Node 22 and the current LTS).
- `docs/README.md`: index of reference docs and, separately, project history.

## Refreshed
- `docs/ARCHITECTURE.md`: round engine instead of bidding, budget and caps, concurrency slots, floor director marked built-but-not-wired, tests, cost bands now in `shared/budget.ts`.
- `docs/CONTRACT.md`: budget profile replaces engine mode in setup; `floor_set` noted as legacy.
- `docs/ROADMAP.md`: added director wiring, cost calibration, retiring the engine-mode switch.

## Stale items found
- **Engine mode switch** (`directed` / `freeforall`) is still on the setup screen (`web/src/routes/NewDebate.tsx`) with copy about bidding, but `runner.ts` never reads `config.mode`. Documented as ignored; not changed (code is out of scope).
- Prompt text and the casting strategy string still mention "floor bids" (`runner.ts:1304`, also noted in the Phase 2b-A report).
- Google Fonts are still loaded by the web app and reports; the README and SECURITY.md say so.

## Open questions
1. **Cost caps vs the owner decision.** The code still ships hard dollar and call caps per profile (`shared/budget.ts`). The decision says caps must not limit quality and quota exhaustion should pause and resume. The README describes the caps as they are; it needs rewording if they are removed or made advisory.
2. Remove the engine-mode switch now, or leave until the director is wired?
3. Is CI on a hosted runner acceptable given `qa` launches Chrome on HTML that links Google Fonts (a pre-existing note in the Phase 2b-A report)?
4. A repository URL is not known, so the quick start says `git clone <this repo>`; the CoC contact is the repository's private advisory channel.
5. The CI workflow is unrun (no remote); `npm ci` assumes the committed `package-lock.json` is in sync.
