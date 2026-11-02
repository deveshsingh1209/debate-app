# Publish checklist

Exact steps to publish The Debate App as a public GitHub repository and cut the first release. Nothing here has been run: the repository has no remote and nothing has been pushed.

Throughout, `OWNER` is the GitHub account or organisation that will own the repository and `REPO` its name (for example `debate-app`). Commands run from the app folder unless they say otherwise.

## 1. Fill in the real URL

The repository URL is left as the token `<owner>/<repo>` (and one `<this repo>`). Replace every one:

| File | Line(s) | What |
|---|---|---|
| `package.json` | `homepage`, `repository.url`, `bugs.url` | `https://github.com/OWNER/REPO` |
| `.github/ISSUE_TEMPLATE/config.yml` | the security contact `url` | `https://github.com/OWNER/REPO/security/advisories/new` |
| `SECURITY.md` | "Reporting a problem" | the same advisories link |
| `CHANGELOG.md` | the two link references at the bottom | compare and release links |
| `README.md` | "For contributors": `git clone <this repo> && cd debate` | `git clone https://github.com/OWNER/REPO.git && cd REPO` |
| `.github/CODEOWNERS` | `* @devesh` | the maintainer's real GitHub handle, if `devesh` is not it |

Then check none is left:

```bash
git grep -n -E '<owner>|<repo>|<this repo>' -- ':!docs/PUBLISH-CHECKLIST.md' ':!docs/RELEASE-REPORT.md' ':!docs/SECURITY-AUDIT-2.md' ':!docs/SECFIX-REPORT.md' ':!server/scripts/security-test.mts' ':!docs/DOCS-REPORT.md'
```

(The excluded files use `<repo>` to mean "the repository folder" in test output, not the URL.)

Also set the date: in `CHANGELOG.md` change `## [0.1.0] - unreleased (first public release)` to `## [0.1.0] - YYYY-MM-DD`. Commit.

## 2. Double-check before anything leaves the machine

```bash
npm ci
npm run typecheck && npm run build && npm run qa && npm run security-test
node scripts/release/scan-secrets.mjs --terms ~/private-terms.txt   # tracked files
node scripts/release/licenses.mjs                                    # exit 0 = every licence allowed or reviewed
npm audit                                                            # 0 vulnerabilities
```

`~/private-terms.txt` is your own list of words that must never appear (other domains, server names, an employer, client names), one regular expression per line. Keep it outside the repository. Read every hit the scan prints; a clean scan is not proof.

By hand:
- [ ] `git status` is clean and no `.env`, `data/`, `*.db`, `release/` or `.scratch/` is tracked (`git ls-files | grep -E '^(data|release|\.scratch)/|\.env$|\.db$'` prints nothing).
- [ ] The screenshots in `docs/screenshots/` show only the fictional demo debate (they do today) and carry no location or author metadata (checked: dimensions only).
- [ ] `docs/PHASE2-PLAN.md` and the other reports quote imported transcripts only with names replaced by roles. Skim them once more with your own debates in mind.
- [ ] `LICENSE` names the right copyright holder.
- [ ] `THIRD_PARTY_NOTICES.md` is current (`node scripts/release/licenses.mjs --write`, then `git diff`).

## 3. Publish with a fresh history

The working history (about 100 commits) contains no credentials, but its older commits do carry personal and hosting details that the current tree no longer has: a previous personal domain, a server home directory, the owner's name in removed sign-in code, and local paths. Publish the final tree as a single new commit instead, so none of that goes public. Verified: a single-commit copy of this tree scans clean with `--history`.

```bash
# Starting in the app folder, on the branch you want to publish, with everything committed.
PUB=$(mktemp -d)/REPO
git clone --no-local --single-branch . "$PUB"
cd "$PUB"
git checkout --orphan main-public
git commit -m "The Debate App 0.1.0"
git branch -D "$(git branch --format='%(refname:short)' | grep -v '^main-public$')"
git branch -m main
git remote remove origin
git log --all --oneline                       # exactly one commit
node scripts/release/scan-secrets.mjs --history --terms ~/private-terms.txt
```

Use the committer name and email you want public. A GitHub `users.noreply.github.com` address keeps your real email private:

```bash
git -c user.name="Your Name" -c user.email="ID+handle@users.noreply.github.com" commit --amend --reset-author --no-edit
```

Create the repository and push (from `$PUB`):

```bash
gh auth status
gh repo create OWNER/REPO --public \
  --description "A panel of AI experts argues your decision out live and writes you a report. Runs locally with your own AI account." \
  --homepage "https://github.com/OWNER/REPO#readme" \
  --source . --remote origin --push
```

## 4. Repository settings (once, right after creating it)

```bash
# Private vulnerability reporting (SECURITY.md and the issue template point at it)
gh api -X PUT repos/OWNER/REPO/private-vulnerability-reporting
# Dependabot alerts and security updates
gh api -X PUT repos/OWNER/REPO/vulnerability-alerts
gh api -X PUT repos/OWNER/REPO/automated-security-fixes
# Topics
gh repo edit OWNER/REPO --add-topic ai,llm,multi-agent,debate,decision-making,local-first,claude,openai
# No wiki or projects; issues on
gh repo edit OWNER/REPO --enable-wiki=false --enable-projects=false --enable-issues
```

In the web UI:
- [ ] **Settings → Code security**: secret scanning and push protection on (free for public repositories).
- [ ] **Settings → Branches**: protect `main`: require a pull request and the CI checks `ubuntu-latest / Node 22`, `ubuntu-latest / Node 24`, `macos-latest / Node 22`, `macos-latest / Node 24` and `Release hygiene`. Do not require the Windows checks until they have passed once (they are non-blocking in `ci.yml` for now).
- [ ] **Settings → Actions → General**: workflow permissions "Read repository contents" (the release job asks for write itself).
- [ ] Watch the first CI run. If the Windows jobs pass, delete the `continue-on-error` line in `.github/workflows/ci.yml` and add them to branch protection.

## 5. Cut the release

```bash
git tag -a v0.1.0 -m "The Debate App 0.1.0"
git push origin v0.1.0
```

The Release workflow re-runs every gate, builds `debate-app-0.1.0.zip` (the source with the launchers marked executable, no `node_modules`), checks the launchers' bits, and opens a **draft** release with the notes from `CHANGELOG.md`. Then:

- [ ] Download the zip from the draft. On a Mac: unzip with a double-click, double-click **Start on Mac.command** (right-click → Open the first time), and run the demo. If you can, do the same on Windows and Linux.
- [ ] Read the notes, then **Publish release**.

To build the same zip locally: `node scripts/release/make-zip.mjs --notes` (output in `release/`, which git ignores).

**About exec bits.** GitHub's own **Code → Download ZIP** drops the executable bit, so from that copy the Mac and Linux launchers need the README's fallback once (right-click → Open on a Mac, or `chmod +x`). The release zip keeps the bits, which is why the README now sends people to Releases first. macOS still asks to confirm the first open of any downloaded script (right-click → Open); that is Gatekeeper, not the bits, and only code signing and notarisation would remove it.

## 6. First-release notes (draft)

The workflow takes the release notes from `CHANGELOG.md`'s 0.1.0 section. A shorter announcement, for the release page intro or a post:

> **The Debate App 0.1.0: your decision, argued out by a panel of AI experts**
>
> Describe a decision you have to make. A panel of AI experts, invented for your topic and chaired by a moderator called Marcus, argues it out live in front of you, asks you questions when it needs to, and hands you a written report with a ruling on every question, the reasoning, the sources and the strongest objections.
>
> It runs on your own computer with your own AI account: a Claude plan or API key, or a ChatGPT plan (Codex) or OpenAI API key. No sign-up, no server of ours, no telemetry. Free and MIT licensed.
>
> - Download `debate-app-0.1.0.zip` below, unzip, and double-click the start file for your system. You need Node.js 22 or newer; the start file checks and tells you.
> - Try it with no AI account: `npm run demo` plays a scripted debate.
> - Debates are thorough, often an hour or more, and there is no spending limit unless you set one. Running out of quota pauses the debate; it resumes by itself.
>
> This is an early release. The live meeting rhythm (interruptions, overlap, a lighter-touch chair) is built but not yet switched on in real debates, and the OpenAI and Codex setups have been tested offline only. See the roadmap. Security model and known limits: SECURITY.md. Please report vulnerabilities privately through the Security tab.

## 7. After publishing

- [ ] Open the repository page signed out and read the README as a newcomer; follow the Mac install steps from the release.
- [ ] Check the Security tab shows "Report a vulnerability".
- [ ] Merge or close Dependabot's first PRs after CI passes.
- [ ] Replace the README screenshots when the UI settles (they show an earlier version and say so).
