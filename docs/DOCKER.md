# Running in Docker (advanced, optional)

The normal way to run this app is `npm install && npm start` on your own machine. Docker is for people who want it isolated or always on. It adds one hurdle: the app needs your AI credentials, and a container does not have them.

## What you get

- The app on `http://127.0.0.1:8794` on the host. The compose file publishes to the host's loopback only, never to your network.
- Your debates in `./data` on the host, so they survive rebuilds.
- A sign-in password. Inside a container the app listens on all interfaces, and it never does that without one. You do not have to make it up: unless you set `ACCESS_PASSWORD`, the first start generates a password, prints it once in the logs and keeps it in `./data/.access-password`, so it survives restarts and rebuilds. The sign-in screen is the price of running in a container.

## Start

```bash
cp .env.example .env
# edit .env: add the credentials below (ACCESS_PASSWORD is optional)
docker compose up --build
```

Look for the `SIGN-IN PASSWORD` box in the output (or run `docker compose logs`, or open `./data/.access-password`). Open http://127.0.0.1:8794 and sign in with it. To choose your own password, set `ACCESS_PASSWORD` in `.env`; it always wins over the generated one. To make a new one, delete `./data/.access-password` and restart.

## Credentials (the part that needs care)

Nothing is baked into the image. Pass in only what you use:

| Provider | How |
|---|---|
| OpenAI: API key | `OPENAI_API_KEY=...` in `.env`. Easiest. |
| Claude: API key | `ANTHROPIC_API_KEY=sk-ant-...` in `.env`. The image already has the Claude Code CLI this runs on. |
| Claude: sign in | Run `claude setup-token` on your own machine and put the result in `.env` as `CLAUDE_CODE_OAUTH_TOKEN=...`. On Linux you can instead uncomment the `~/.claude` and `~/.claude.json` mounts in `docker-compose.yml`. On macOS the Claude Code login lives in the Keychain, which a container cannot read, so use the token. |
| ChatGPT: Codex sign-in | Uncomment the `~/.codex` mount. The app writes rotated tokens back to that folder so your own CLI stays signed in. |

Treat `.env` and the mounted folders like passwords. Do not publish the port beyond localhost; if you change the port mapping, keep `127.0.0.1:` in front.

## Limits

- No PDF export (the image has no Chrome). The HTML report always works.
- The image installs the Claude Code CLI from npm at build time; rebuild to update it.
- `npm run doctor` and `npm run demo` are host commands. In Docker, set `MOCK=1` in the environment to see the scripted demo.
