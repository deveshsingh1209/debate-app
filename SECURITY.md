# Security

## Reporting a problem

Please report it privately through GitHub's private vulnerability reporting: on this repository open the **Security** tab and click **Report a vulnerability** (direct link: `https://github.com/deveshsingh1209/debate-app/security/advisories/new`). Do not open a public issue. Include what you did, what happened, and the version (zip name or commit) you ran. You should hear back within a week. Only the maintainers see the report until a fix is published.

Supported versions: the latest release only.

## Threat model

The Debate App is a single-user program you run on your own machine with your own credentials (a Claude login or API key, an OpenAI key, or a Codex login). It is not designed to be a shared or public service. This section says plainly what it defends against and what it does not.

**What is worth protecting:** your credentials; your debates and uploaded documents, which are often confidential (term sheets, financials); and your model quota or API spend.

**Who it defends against, and how well:**

| Attacker | What they can reach | Defence | How strong |
|---|---|---|---|
| A web page in your browser, on any site | Requests to `127.0.0.1` from your browser (cross-site requests, DNS rebinding) | Host allowlist, Origin check (scheme, host and port), CSRF token on every change | Strong |
| Another app on `localhost` (another dev server, a local tool, an XSS in some other local web app) | The same, from a "localhost" origin a browser treats as friendly | The Origin must be this server's own scheme, host and port; nothing grants CORS, so it cannot read the CSRF token | Strong |
| A hostile uploaded document, or a web page the research desk reads | Text the AI agents read, i.e. prompt injection | Fences, tool scoping, the sandbox, the fetch rule and the question gate (below) | Reduces the risk a lot; cannot remove it |
| A device on your network | Nothing, unless you set `HOST` | The server listens on 127.0.0.1 only; any other `HOST` needs `ACCESS_PASSWORD` | Strong |
| Another program or another user account on the same computer | Plain HTTP to 127.0.0.1 | **None in the default local mode** (see below) | Not defended |
| Malware already running as you | Everything you can reach | Out of scope for any app | Not defended |

**The deliberate trade-off.** In the default local mode there is no login and no launch token, so that starting the app is one command and nothing more. The cost is that any program or account on the same computer that can reach 127.0.0.1 can use the app as you (read and delete debates, start debates on your credentials). On a computer only you use, that is no more access than such a program already has to your files. On a shared computer, set `ACCESS_PASSWORD`.

## What the app does

- **Network exposure.** The server listens on 127.0.0.1 by default. It refuses to start on any other interface unless `ACCESS_PASSWORD` is set. In Docker (where it must listen on all interfaces) a password is generated on first start if you did not set one, printed once in the logs and kept in the data volume (`data/.access-password`, mode 0600); see [docs/DOCKER.md](docs/DOCKER.md).
- **DNS rebinding.** Every request whose `Host` header is not localhost, 127.0.0.1, [::1], `HOST` or an `ALLOWED_HOSTS` entry is refused with 421.
- **Cross-origin requests.** A request carrying an `Origin` must come from this server's own origin: the same scheme, host and port as the address you opened (or `PUBLIC_URL`'s origin, for a reverse proxy). Another app on `localhost:<another port>` is refused. This also covers the live event stream. Every POST and DELETE needs an `x-csrf-token` header that only a same-origin page can read from `GET /api/me`; the server never grants CORS.
- **Password mode.** With `ACCESS_PASSWORD` set, every data route needs a session cookie (`HttpOnly`, `SameSite=Strict`; `Secure` only when the server itself is reached over HTTPS, not through a proxy). Sessions live in memory and end on restart or sign-out. Login attempts are limited to five per minute per address. Use HTTPS (a reverse proxy, with `PUBLIC_URL` set to its address) if the app is reachable beyond your own network.
- **Credentials.** The app stores none. Claude runs on your own Claude Code login, or on a Claude API key that is set only in the environment of the Claude CLI child of a debate on that door; both API keys are read from the environment or `.env`, removed from `process.env`, and never returned or logged; your Codex login is read from `$CODEX_HOME` per turn, and the copy made for a turn is deleted afterwards. Agent subprocesses get an allowlisted environment, not a copy of the server's.
- **Uploaded files** are treated as untrusted. Their text reaches the models only between content-hashed `<<<UNTRUSTED ...>>>` markers, with instructions to treat it as data. The same fence is put around everything derived from untrusted material, wherever it enters a prompt: the dossier analyst's brief (including the shared room record every seat reads), what the research desk found on the web, and the quant desk's python output. Hidden files (`.claude/`, `.mcp.json`, `.env`, `.git/`) in an upload are not saved, and files named like agent instructions (`CLAUDE.md`, `AGENTS.md`) are saved under another name (`_CLAUDE.md`), so no agent CLI can mistake them for its own configuration. Zip uploads are budgeted on their declared sizes before anything is decompressed (150 MB and 500 files in all, 30 MB each), and a request's files are counted as a whole.
- **Agents and their tools.**
  - Expert agents and the chair's speaking turns hold no tools.
  - The seats that read uploads never hold web tools. The panel architect is split in two: a web pass that sees only your topic and the panel's goal, and a designer that reads the dossier brief and holds no tools at all.
  - Research questions are written by models that have read your uploads, so before one is sent it must look like a plain question: anything carrying a link, an email address, a network address or a long encoded string is refused (and the room is told), and long questions are trimmed. A bare site name such as `docs.python.org` may be named; a private or reserved name (`.local`, `.lan`, `.internal`, `.home.arpa`, `.example`) or a subdomain that looks like it carries data (`m41f.acme.com`) may not. The goal that rides along is scrubbed the same way.
  - The research desk (the Claude door) holds web search only, behind a search allowance. It reads the pages it cites with the server's own fetcher, only URLs a search returned, with the public-address check below on every redirect hop and again on the address the connection actually uses.
  - The architect's web pass is the one seat that holds the CLI's WebFetch, behind the same search allowance. A check runs before every fetch, in a hook the CLI cannot skip: the page must have appeared in a web-search result earlier in the same debate, and its host must resolve only to public addresses (no loopback, private, link-local, carrier-grade NAT or `.local` names). After the fetch, where it landed is checked again; if it ended on a private address (a redirect, or DNS that changed between the check and the fetch), the whole turn is stopped and nothing it read is used.
  - The dossier analyst's file tools are scoped to the debate's upload folder. The quant desk and auditors, the only seats with python, run their shell in the operating system's sandbox with no network access. Every seat with a file tool or python is also denied reads of credential locations: `~/.ssh`, `~/.codex`, `~/.claude`, `~/.claude.json`, `~/.aws`, `~/.config`, `~/.gnupg`, `~/.docker`, `~/.kube`, the macOS Keychains folders, `.env` files anywhere, the app's database and its backups.
  - On the Codex door the research thread alone has Codex's web search switched on; its shell network and filesystem stay off. Codex turns run in a permission profile that denies filesystem access, with no network. On the OpenAI door, web search is OpenAI's own `web_search` tool, used by the research desk only.
- **Reports** are model-written HTML. They are escaped when rendered and served with `Content-Security-Policy: sandbox`, so they run as an opaque origin with no access to your session or the API. The same header, and a `<meta>` copy inside every report and transcript, forbid loading or sending anything (`default-src 'none'`; only inline styles and script, and `data:` fonts and images), so even text that escaped the renderer could not carry the report anywhere. The `<meta>` copy also covers a downloaded report opened from disk and the page Chrome prints to PDF. Links in the sources list still open when you click them.
- **PDF export** needs Google Chrome or Chromium on the machine (without one you get the HTML report only). Chrome prints with its own sandbox on. Where that sandbox cannot start (running as root, a container without user namespaces, or Ubuntu 23.10+ where AppArmor blocks it for a Chrome it has no profile for), the app prints once more without it and logs a warning; `CHROME_NO_SANDBOX=1` starts there. The page printed is the app's escaped HTML under the no-load policy either way.
- **Live streams** are capped (8 per debate, 64 in all; the oldest is closed and the page reconnects by itself).
- **Data at rest.** Debates, uploads and reports are stored unencrypted in `DATA_DIR` (created with mode 0700). Treat that folder like the documents in it.
- **The development server** (`npm run dev`, for contributors) serves only the web app's own files, the shared contract and the installed packages. It refuses the data folder, databases, `.env` files and the rest of the repository, and grants CORS to nobody.

## Known limits

Stated plainly, so nobody relies on more than is there:

- **Prompt injection is reduced, not solved.** The fences tell the models that fenced text is data, and they mostly listen; a model can still be talked into something. The defences above are built so that a successful injection has little to work with (no web tools where uploads are read, no arbitrary fetches, no credential files), not on the assumption that injection fails. Do not upload files from people you do not trust.
- **Local accounts are trusted** in the default mode (see the trade-off above).
- **The python sandbox's read rules are enforced by the Claude Code CLI**, which turns the deny rules above into the operating system sandbox's read restrictions. That has been checked offline (the rules are passed on every python turn), not yet in a live run against a real CLI. On Linux the sandbox may not support the `**/.env` pattern; the named folders are literal paths and do not depend on it. The CLI's own login lookup is not affected: the rules restrict the agent's tools, not the CLI.
- **DNS rebinding during a fetch** by the architect's web pass (the one seat whose fetches the CLI makes) is checked before and after, from this process. The research desk's own page reader checks the address each connection actually uses, so this limit does not apply to it. An attacker who controls a domain's DNS and answers the CLI differently from both checks could still make one fetch land on a private address. Two things limit what that buys: the page must have been a search result first, and nothing read in that turn can be sent anywhere, because every other fetch must also be a search result.
- **The Claude and Codex CLIs themselves, and the model providers**, are outside this app's control.
- Fonts are self-hosted in the web app and inlined in reports; neither makes a third-party request.
- `npm audit` sends the dependency tree to the npm registry, so the offline tests do not run it; CI's release-hygiene job and the release workflow do, along with the secrets scan and the licence audit (`scripts/release/`). Dependencies move; Dependabot proposes updates weekly.

## Testing

`npm run security-test` attacks the app offline, on one port (8841): the server booted in its default mode, without a password on a non-loopback address (it must refuse), in password mode and as the Docker image starts it; the dev server; and, in-process, the research desk, the upload rules, the agents' tool grants and sandbox rules, the fetch rule and its hooks, the fences, the research-question gate and the stream limits. It covers the Host, Origin, CSRF, session, path-traversal and secret-leak boundaries too. `npm run qa` includes self-tests for the provider clients and the upload fences. See [docs/SECURITY-AUDIT-2.md](docs/SECURITY-AUDIT-2.md) for the latest audit and [docs/SECFIX-REPORT.md](docs/SECFIX-REPORT.md) for what was fixed after it.
