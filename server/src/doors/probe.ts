/**
 * Readiness of the four doors, with NO model call.
 *
 *   claude     `claude auth status` (or CLAUDE_CODE_OAUTH_TOKEN in the environment)
 *   anthropic  ANTHROPIC_API_KEY present and shaped like an API key, plus a Claude CLI to run it
 *   codex      the ChatGPT login in $CODEX_HOME/auth.json, and `codex login status` to explain a miss
 *   openai     OPENAI_API_KEY present and shaped like an API key
 *
 * Pure: everything it touches comes in through `ProbeEnv`, so the selftest runs
 * it against fake machines and fake CLIs, and `npm run doctor` runs it without
 * loading the server's config. No import here may have side effects.
 *
 * What comes back is plain text for a person. A key's value, a token, an
 * account e-mail or a CLI's raw output never appears in it: keys are only
 * tested for presence and shape, and CLI output is only matched, never quoted.
 */
import { validateCodexAuth } from '../agents/codex.ts';
import { PROVIDERS, PROVIDER_LABEL, type Provider } from '../../../shared/models.ts';
import type { DoorState, DoorStatus, DoorStep } from '../../../shared/types.ts';

export interface CmdResult {
  /** false when the program could not be started (not installed). */
  found: boolean;
  code: number | null;
  out: string;
  timedOut?: boolean;
}

export interface ProbeEnv {
  /** CLAUDE_CODE_OAUTH_TOKEN is read for presence only. */
  env: Record<string, string | undefined>;
  anthropicKey: string;
  openaiKey: string;
  /** How to start the Claude CLI; null when none is installed. */
  claudeCli: { cmd: string; args: string[] } | null;
  /** How to start the Codex CLI (`codex` on PATH by default). Only used to explain a missing login. */
  codexCli: { cmd: string; args: string[] } | null;
  codexAuthFile: string;
  readFile(file: string): string | null;
  /** Run a program with a short timeout. Must never make a model call. */
  run(cmd: string, args: string[]): Promise<CmdResult> | CmdResult;
  /** The .env file keys are read from (named in the steps). */
  envFile: string;
  platform: string;
  now?: number;
}

export const DOOR_TITLE: Record<Provider, string> = PROVIDER_LABEL;

const BLURB: Record<Provider, string> = {
  claude: 'Use your Claude subscription (Pro or Max) through Claude Code. No key, and no bill beyond your plan.',
  anthropic: 'Pay as you go with an API key from the Anthropic Console. The same Claude models, billed to your Anthropic account.',
  codex: 'Use your ChatGPT plan (Plus or Pro) through the Codex CLI. No key, and no per-token bill.',
  openai: 'Pay as you go with an API key from the OpenAI platform, billed to your OpenAI account.',
};

const INSTALL_CLAUDE = 'npm install -g @anthropic-ai/claude-code';
const INSTALL_CODEX = 'npm install -g @openai/codex';

/** A shell command that opens the .env file in a text editor, creating it if needed. */
export function openEnvCommand(file: string, platform: string): string {
  const q = `"${file.replace(/"/g, '\\"')}"`;
  if (platform === 'win32') return `notepad ${q}`;
  if (platform === 'darwin') return `touch ${q} && open -e ${q}`;
  return `touch ${q} && xdg-open ${q}`;
}

function keySteps(name: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY', where: string, d: ProbeEnv): DoorStep[] {
  return [
    { text: `Create a key at ${where} and copy it.`, copy: where },
    { text: 'Open the app\'s settings file (.env) in a text editor. This command opens it, and creates it if it is not there yet:', copy: openEnvCommand(d.envFile, d.platform) },
    { text: `Add this line, paste your key straight after the = sign (no spaces, no quotes), and save the file:`, copy: `${name}=` },
    { text: 'Come back here and press Re-check. No restart is needed.' },
  ];
}

const STEPS: Record<Provider, (d: ProbeEnv) => DoorStep[]> = {
  claude: () => [
    { text: 'Install Claude Code (one time). In a terminal, run:', copy: INSTALL_CLAUDE },
    { text: 'Start it and sign in with your Claude account. It opens your browser; approve, and come back.', copy: 'claude' },
    { text: 'Once it says you are signed in, type /exit to leave it.' },
    { text: 'Come back here and press Re-check.' },
  ],
  anthropic: (d) => [
    ...keySteps('ANTHROPIC_API_KEY', 'https://console.anthropic.com/settings/keys', d).slice(0, 3),
    { text: 'This door runs on Claude Code. If it is not installed yet, install it too (no sign-in needed):', copy: INSTALL_CLAUDE },
    { text: 'Come back here and press Re-check. No restart is needed.' },
  ],
  codex: () => [
    { text: 'Install the Codex CLI (one time). In a terminal, run:', copy: INSTALL_CODEX },
    { text: 'Sign in, and choose "Sign in with ChatGPT". It opens your browser; approve, and come back.', copy: 'codex login' },
    { text: 'Come back here and press Re-check.' },
  ],
  openai: (d) => keySteps('OPENAI_API_KEY', 'https://platform.openai.com/api-keys', d),
};

interface Verdict {
  state: DoorState;
  summary: string;
  fix?: string | null;
  note?: string | null;
}

// ---------- claude: the Claude Code login ----------

/**
 * `claude auth status` prints JSON (`"loggedIn": true|false`) on current
 * releases and exits non-zero when signed out; older ones have no such
 * command. Only those facts are read; the output (which names the account)
 * never leaves this function.
 */
export function readClaudeStatus(r: CmdResult): 'in' | 'out' | 'unknown' | 'timeout' | 'missing' {
  if (!r.found) return 'missing';
  if (r.timedOut) return 'timeout';
  const t = r.out.toLowerCase();
  if (/"loggedin"\s*:\s*false|not logged in|not signed in|no credentials|please run \/login/.test(t)) return 'out';
  if (/"loggedin"\s*:\s*true/.test(t)) return 'in';
  if (r.code === 0) return 'in';
  return 'unknown';
}

async function probeClaude(d: ProbeEnv): Promise<Verdict> {
  if ((d.env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim()) {
    return { state: 'ready', summary: 'Signed in through CLAUDE_CODE_OAUTH_TOKEN in your environment.' };
  }
  const notInstalled: Verdict = {
    state: 'needs_setup',
    summary: 'Claude Code is not installed on this computer.',
    fix: `Install Claude Code (\`${INSTALL_CLAUDE}\`), run \`claude\` once and sign in, then press Re-check.`,
  };
  if (!d.claudeCli) return notInstalled;
  // Match the agent's isolated settingSources: []: global API-key helpers
  // must not make the subscription door look ready when it cannot use them.
  const st = readClaudeStatus(await d.run(d.claudeCli.cmd, [...d.claudeCli.args, '--setting-sources=', 'auth', 'status']));
  switch (st) {
    case 'missing':
      return notInstalled;
    case 'in':
      return { state: 'ready', summary: 'Claude Code is installed and signed in.' };
    case 'out':
      return {
        state: 'needs_setup',
        summary: 'Claude Code is installed but not signed in.',
        fix: 'Open a terminal, run `claude`, sign in with your Claude account, type /exit, then press Re-check.',
      };
    case 'timeout':
      return {
        state: 'problem',
        summary: 'Claude Code did not answer in time.',
        fix: 'Run `claude` in a terminal to see what it says (it may want an update or a sign-in), then press Re-check.',
      };
    default:
      // No status command: an old Claude Code, which also predates the models the app casts.
      return {
        state: 'problem',
        summary: 'Claude Code is installed, but this version cannot say whether it is signed in. It is probably out of date.',
        fix: `Update it with \`${INSTALL_CLAUDE}\`, run \`claude\` once and sign in, then press Re-check.`,
      };
  }
}

// ---------- key shapes ----------

/** What is wrong with a pasted key, in words, or null when it looks right. Never echoes the key. */
export function anthropicKeyProblem(key: string): Verdict | null {
  if (/\s/.test(key)) {
    return { state: 'problem', summary: 'The ANTHROPIC_API_KEY in .env has a space or line break inside it.', fix: 'Open .env and make the line exactly ANTHROPIC_API_KEY= followed by the key, with nothing else. Then press Re-check.' };
  }
  if (key.startsWith('sk-ant-oat')) {
    return {
      state: 'problem',
      summary: 'ANTHROPIC_API_KEY holds a Claude sign-in token, not an API key.',
      fix: 'Remove that line from .env. To use your Claude subscription, use the "Claude: sign in" door instead. For this door, create an API key in the Anthropic Console.',
    };
  }
  if (key.startsWith('sk-ant-admin')) {
    return { state: 'problem', summary: 'ANTHROPIC_API_KEY holds an Admin key, which cannot run models.', fix: 'Create a regular API key in the Anthropic Console (Settings, API keys), put it in .env, then press Re-check.' };
  }
  if (!key.startsWith('sk-ant-')) {
    return key.startsWith('sk-')
      ? { state: 'problem', summary: 'ANTHROPIC_API_KEY looks like an OpenAI key.', fix: 'Anthropic keys start with sk-ant-. If this is an OpenAI key, rename the line to OPENAI_API_KEY= instead, then press Re-check.' }
      : { state: 'problem', summary: 'ANTHROPIC_API_KEY does not look like an Anthropic API key.', fix: 'Anthropic API keys start with sk-ant-. Copy the key again from the Anthropic Console, put it in .env, then press Re-check.' };
  }
  return null;
}

export function openaiKeyProblem(key: string): Verdict | null {
  if (/\s/.test(key)) {
    return { state: 'problem', summary: 'The OPENAI_API_KEY in .env has a space or line break inside it.', fix: 'Open .env and make the line exactly OPENAI_API_KEY= followed by the key, with nothing else. Then press Re-check.' };
  }
  if (key.startsWith('sk-ant-')) {
    return { state: 'problem', summary: 'OPENAI_API_KEY holds an Anthropic key.', fix: 'Rename the line to ANTHROPIC_API_KEY= to use it on the "Claude: API key" door, or put an OpenAI key here. Then press Re-check.' };
  }
  if (!key.startsWith('sk-')) {
    return { state: 'problem', summary: 'OPENAI_API_KEY does not look like an OpenAI API key.', fix: 'OpenAI API keys start with sk-. Copy the key again from platform.openai.com, put it in .env, then press Re-check.' };
  }
  return null;
}

async function probeAnthropic(d: ProbeEnv): Promise<Verdict> {
  const key = d.anthropicKey.trim();
  if (!key) {
    return { state: 'needs_setup', summary: 'No ANTHROPIC_API_KEY in .env yet.', fix: 'Create a key in the Anthropic Console, add ANTHROPIC_API_KEY= and the key to .env, then press Re-check.' };
  }
  const bad = anthropicKeyProblem(key);
  if (bad) return bad;
  // The key is spent through the Claude CLI, so one has to be installed. Signing it in is not needed.
  const cli = d.claudeCli ? await d.run(d.claudeCli.cmd, [...d.claudeCli.args, '--version']) : null;
  if (!cli?.found) {
    return {
      state: 'problem',
      summary: 'An API key is set, but Claude Code (the engine this door runs on) is not installed.',
      fix: `Install Claude Code with \`${INSTALL_CLAUDE}\`. You do not need to sign in to it. Then press Re-check.`,
    };
  }
  return {
    state: 'ready',
    summary: 'An API key is set (it is never shown), and Claude Code is installed to run it.',
    note: 'Billed per use to your Anthropic account. The key is only checked for its shape here; if Anthropic refuses it, the debate pauses and says so.',
  };
}

// ---------- codex: the ChatGPT login ----------

export function readCodexStatus(r: CmdResult): 'chatgpt' | 'apikey' | 'out' | 'missing' | 'unknown' {
  if (!r.found) return 'missing';
  const t = r.out.toLowerCase();
  if (/not logged in|not signed in/.test(t)) return 'out';
  if (/logged in using chatgpt|signed in with chatgpt/.test(t)) return 'chatgpt';
  if (/logged in using an api key|api key/.test(t) && /logged in/.test(t)) return 'apikey';
  return r.code === 0 && /logged in/.test(t) ? 'chatgpt' : 'unknown';
}

async function probeCodex(d: ProbeEnv): Promise<Verdict> {
  const raw = d.readFile(d.codexAuthFile);
  if (raw !== null && raw.trim()) {
    const v = validateCodexAuth(raw.trim(), d.now ?? Date.now());
    if (v.ok) return { state: 'ready', summary: 'Signed in to Codex with ChatGPT.', note: v.warning };
    const apiKeyMode = /API-key mode/i.test(v.error);
    return {
      state: 'problem',
      summary: apiKeyMode ? 'Codex is signed in with an API key, not with ChatGPT.' : 'The Codex login file is there but cannot be used.',
      fix: apiKeyMode
        ? 'Run `codex login` and choose "Sign in with ChatGPT", then press Re-check. (To pay per use with an OpenAI key, use the "OpenAI: API key" door instead.)'
        : 'Run `codex login` again and choose "Sign in with ChatGPT", then press Re-check.',
    };
  }
  // No usable file. Ask the CLI why, so the fix is the right one.
  const st = d.codexCli ? readCodexStatus(await d.run(d.codexCli.cmd, [...d.codexCli.args, 'login', 'status'])) : 'missing';
  if (st === 'missing') {
    return {
      state: 'needs_setup',
      summary: 'The Codex CLI is not installed on this computer.',
      fix: `Install it (\`${INSTALL_CODEX}\`), run \`codex login\` and choose "Sign in with ChatGPT", then press Re-check.`,
    };
  }
  if (st === 'chatgpt' || st === 'apikey') {
    return {
      state: 'problem',
      summary: st === 'apikey' ? 'Codex is signed in with an API key, not with ChatGPT.' : 'Codex is signed in, but keeps its login where this app cannot read it (your computer\'s password store).',
      fix: st === 'apikey'
        ? 'Run `codex login` and choose "Sign in with ChatGPT", then press Re-check.'
        : 'Tell Codex to save its sign-in in a file, then sign in once more: add the line cli_auth_credentials_store = "file" to the file ~/.codex/config.toml (the help page has a command that does it for you), run `codex login`, choose "Sign in with ChatGPT", then press Re-check.',
    };
  }
  return {
    state: 'needs_setup',
    summary: 'Codex is installed but not signed in.',
    fix: 'Open a terminal, run `codex login`, choose "Sign in with ChatGPT", then press Re-check.',
  };
}

// ---------- openai: the API key ----------

async function probeOpenAI(d: ProbeEnv): Promise<Verdict> {
  const key = d.openaiKey.trim();
  if (!key) {
    return { state: 'needs_setup', summary: 'No OPENAI_API_KEY in .env yet.', fix: 'Create a key at platform.openai.com, add OPENAI_API_KEY= and the key to .env, then press Re-check.' };
  }
  return openaiKeyProblem(key) ?? {
    state: 'ready',
    summary: 'An API key is set (it is never shown).',
    note: 'Billed per use to your OpenAI account. The key is only checked for its shape here; if OpenAI refuses it, the debate pauses and says so.',
  };
}

const PROBES: Record<Provider, (d: ProbeEnv) => Promise<Verdict>> = {
  claude: probeClaude,
  anthropic: probeAnthropic,
  codex: probeCodex,
  openai: probeOpenAI,
};

/** Probe one door. Never throws: a probe that breaks is a `problem`, not a crash. */
export async function probeDoor(id: Provider, d: ProbeEnv): Promise<DoorStatus> {
  let v: Verdict;
  try {
    v = await PROBES[id](d);
  } catch {
    v = { state: 'problem', summary: 'The check itself failed.', fix: 'Press Re-check. If it keeps failing, run `npm run doctor` in the app folder.' };
  }
  return {
    id,
    title: DOOR_TITLE[id],
    blurb: BLURB[id],
    state: v.state,
    summary: v.summary,
    fix: v.state === 'ready' ? null : v.fix ?? null,
    steps: STEPS[id](d),
    note: v.note ?? null,
    checkedAt: d.now ?? Date.now(),
  };
}

/** All four, in the order the app offers them, probed in parallel. */
export function probeDoors(d: ProbeEnv): Promise<DoorStatus[]> {
  return Promise.all(PROVIDERS.map((id) => probeDoor(id, d)));
}
