# Connect your AI

The Debate App runs on your own computer and uses your own AI account. Nothing goes through a server of ours, and there is no account to make with us.

You need **one** of the four ways below. Pick the one that matches what you already pay for:

| You have | Use | What it costs |
|---|---|---|
| A Claude Pro or Max plan | [1. Claude: sign in](#1-claude-sign-in) | Nothing extra. Debates use your plan's allowance. |
| An Anthropic API account | [2. Claude: API key](#2-claude-api-key) | Pay as you go, billed to your Anthropic account. |
| A ChatGPT Plus or Pro plan | [3. ChatGPT: Codex sign-in](#3-chatgpt-codex-sign-in) | Nothing extra. Debates use your plan's allowance. |
| An OpenAI API account | [4. OpenAI: API key](#4-openai-api-key) | Pay as you go, billed to your OpenAI account. |

You never choose a model. The app gives every seat in the room the right model for its job: Marcus, the chair, and the experts run on Claude Opus 5.5 on both Claude ways, and on GPT-6 Astra on both OpenAI ways.

## The easy way: the Connect screen

Open the app (`npm start`). If nothing is connected yet, the **Connect your AI** screen opens by itself. You can always get back to it with the **Connect your AI** button on the home screen, or from the **Sound** menu in the top corner.

It shows four cards, one for each way. Each card says one of:

- **Ready**: this way works. You can start a debate with it.
- **Needs setup**: nothing is there yet. The card lists the steps.
- **Problem**: something is there but will not work as it is. The card says exactly what to change.

Every command you need to type has a **Copy** button next to it. After you finish a card's steps, press **Re-check**. You do not need to restart the app, even after adding a key.

The New Debate screen checks the way you picked before it lets you start. If it is not ready, the Start button stays off and the fix is shown right there.

Prefer a terminal? `npm run doctor` checks all four the same way and prints the fix for each.

### What "a terminal" means

Some steps ask you to type a command into a terminal.

- **Mac:** open the **Terminal** app (press Cmd+Space, type `Terminal`, press Enter).
- **Windows:** open **PowerShell** from the Start menu.
- **Linux:** open your Terminal app.

Paste the command (Cmd+V on a Mac, Ctrl+V elsewhere) and press Enter.

---

## 1. Claude: sign in

For people with a Claude Pro or Max plan. No key is needed.

1. **Install Claude Code** (one time). In a terminal, run:

   ```bash
   npm install -g @anthropic-ai/claude-code
   ```

2. **Sign in.** In the terminal, run:

   ```bash
   claude
   ```

   It opens your browser. Sign in with your Claude account and approve. Then go back to the terminal.

3. When it says you are signed in, type `/exit` and press Enter.
4. In the app, press **Re-check** on the "Claude: sign in" card. It should say **Ready**.

**If it says "Problem: this version cannot say whether it is signed in"**, your Claude Code is out of date. Run the install command in step 1 again, then `claude` again.

**If the app cannot find Claude Code** even though you installed it, add a line to the app's `.env` file (see [Editing the .env file](#editing-the-env-file)) that says where it is, for example `AGENT_CLI_PATH=/usr/local/bin/claude`.

How the app checks: it asks Claude Code `claude auth status`. That is not a request to the AI and costs nothing.

## 2. Claude: API key

For people who pay Anthropic per use. The debate runs the same Claude models as the sign-in way, billed to your Anthropic account.

1. **Create a key.** Go to [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys), sign in, press **Create Key**, and copy it. It starts with `sk-ant-`.
2. **Put it in the app's `.env` file.** Add this line, with your key straight after the `=` sign, and save:

   ```bash
   ANTHROPIC_API_KEY=sk-ant-...
   ```

   See [Editing the .env file](#editing-the-env-file) if you have not done this before.
3. **Install Claude Code** if you have not already. This way runs on it, but you do **not** need to sign in to it:

   ```bash
   npm install -g @anthropic-ai/claude-code
   ```

4. In the app, press **Re-check** on the "Claude: API key" card. It should say **Ready**.

Common problems the card will point out:

- **"holds a Claude sign-in token, not an API key"**: you pasted a token that starts with `sk-ant-oat`. That is for the sign-in way, not this one. Create an API key in the Console instead.
- **"looks like an OpenAI key"**: the key starts with `sk-` but not `sk-ant-`. It belongs on the `OPENAI_API_KEY=` line instead.
- **"has a space or line break inside it"**: make the line exactly `ANTHROPIC_API_KEY=` followed by the key, nothing else.

How the app keeps the key safe: it reads it from `.env` when it starts (or when you press Re-check), and hands it only to the Claude Code process running that debate. It is never shown in the app, never sent to your browser and never written to a log. The app only checks the key's shape; if Anthropic refuses it (wrong key, no credit), the debate pauses and tells you so.

## 3. ChatGPT: Codex sign-in

For people with a ChatGPT Plus or Pro plan. No key is needed.

1. **Install the Codex CLI** (one time). In a terminal, run:

   ```bash
   npm install -g @openai/codex
   ```

2. **Sign in.** In the terminal, run:

   ```bash
   codex login
   ```

   Choose **Sign in with ChatGPT**. It opens your browser; sign in and approve.
3. In the app, press **Re-check** on the "ChatGPT: Codex sign-in" card. It should say **Ready**.

Common problems the card will point out:

- **"signed in with an API key, not with ChatGPT"**: run `codex login` again and choose **Sign in with ChatGPT**. (To pay per use with an OpenAI key, use way 4 instead.)
- **"keeps its login where this app cannot read it"**: Codex saved your sign-in in your computer's password store, where the app cannot see it. Tell Codex to save it in a file instead, then sign in once more. Paste this into a terminal and press Enter:

  - **Mac or Linux:**

    ```bash
    mkdir -p ~/.codex && echo 'cli_auth_credentials_store = "file"' >> ~/.codex/config.toml && codex login
    ```

  - **Windows (PowerShell):**

    ```powershell
    New-Item -ItemType Directory -Force "$HOME\.codex" | Out-Null; Add-Content "$HOME\.codex\config.toml" 'cli_auth_credentials_store = "file"'; codex login
    ```

  Choose **Sign in with ChatGPT** again, then press **Re-check**.
- **A free ChatGPT plan** shows Ready with a warning: debates start, but the free plan is limited and may stop part-way.

How the app checks: it reads the login file Codex keeps (`~/.codex/auth.json`, or the folder in `CODEX_HOME`) and, when that is missing, asks `codex login status`. Neither is a request to the AI. The login file is never shown or sent anywhere.

## 4. OpenAI: API key

For people who pay OpenAI per use.

1. **Create a key.** Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys), sign in, press **Create new secret key**, and copy it. It starts with `sk-`.
2. **Put it in the app's `.env` file.** Add this line, with your key straight after the `=` sign, and save:

   ```bash
   OPENAI_API_KEY=sk-...
   ```

3. In the app, press **Re-check** on the "OpenAI: API key" card. It should say **Ready**.

If the card says the key **"holds an Anthropic key"**, you pasted a key that starts with `sk-ant-`. Rename the line to `ANTHROPIC_API_KEY=` to use it with way 2.

The key is handled the same way as the Claude key: read from `.env`, never shown, never sent to your browser, never logged.

---

## Editing the .env file

The `.env` file is a plain text file in the app's folder (next to `package.json`). The Connect screen shows its full location and gives you a command that opens it, creating it if needed:

- **Mac:** `touch "/path/to/debate/.env" && open -e "/path/to/debate/.env"` (opens it in TextEdit)
- **Windows:** `notepad "C:\path\to\debate\.env"`
- **Linux:** `touch "/path/to/debate/.env" && xdg-open "/path/to/debate/.env"`

Each setting is one line: the name, an `=` sign, and the value, with no spaces around the `=` and no quotes. For example:

```bash
ANTHROPIC_API_KEY=sk-ant-api03-...
OPENAI_API_KEY=sk-proj-...
```

Save the file, then press **Re-check** in the app. You do not need to restart. A key set in your shell's environment instead of `.env` also works; then restart the app after changing it.

Keep the `.env` file private. It is ignored by git, so it is never committed.

## Still stuck?

- Run `npm run doctor` in the app's folder. It checks Node, all four ways, the port and the data folder, and prints the exact fix for anything wrong.
- `npm run demo` plays a complete scripted debate with no AI connected at all, so you can see what the app does first.
