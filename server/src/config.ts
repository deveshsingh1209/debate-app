import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Minimal .env loader (repo root), no dependency. Real env vars win.
const envPath = path.resolve(process.cwd(), '.env');

/** KEY=value pairs of a .env file; empty when it does not exist. */
function readDotEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const bootDotEnv = readDotEnv(envPath);
for (const [k, v] of Object.entries(bootDotEnv)) {
  if (process.env[k] === undefined) process.env[k] = v;
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/**
 * Credentials. This app stores none of them.
 *  - Claude: the agent CLI uses your own local Claude Code login.
 *  - Claude API key: ANTHROPIC_API_KEY from the environment or .env. Read
 *    once here and handed only to the Claude CLI child of a debate on that
 *    door (sdk.ts); never returned by any route and never logged.
 *  - OpenAI: OPENAI_API_KEY from the environment or .env. Read once here,
 *    never returned by any route and never logged.
 *  - Codex: your own `codex login`, read from $CODEX_HOME/auth.json
 *    (default ~/.codex) at the start of each turn.
 * Each is removed from process.env after it is read, so nothing that later
 * copies the environment can carry it along.
 */
const openaiApiKey = (process.env.OPENAI_API_KEY ?? '').trim();
delete process.env.OPENAI_API_KEY;
const anthropicApiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim();
delete process.env.ANTHROPIC_API_KEY;
const accessPassword = process.env.ACCESS_PASSWORD ?? '';
delete process.env.ACCESS_PASSWORD;

export const CFG = {
  port: num(process.env.PORT, 8794),
  /** 127.0.0.1 by default. Anything else requires ACCESS_PASSWORD (see index.ts). */
  host: process.env.HOST ?? '127.0.0.1',
  mock: process.env.MOCK === '1',
  /**
   * MOCK only: keep the door gate a real start has (New Debate and
   * POST /api/debates refuse a door that is not ready), so the browser tests
   * can check the gate with no model call. Off by default: a demo starts on
   * any door.
   */
  mockRequireDoor: process.env.MOCK === '1' && process.env.MOCK_REQUIRE_DOOR === '1',
  dataDir: process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data'),

  /** Optional shared password. Required when HOST is not a loopback address. */
  accessPassword,
  /**
   * Extra Host header values accepted besides localhost, 127.0.0.1 and [::1]
   * (and HOST itself). Needed when you open the app by LAN name or IP.
   */
  allowedHosts: list(process.env.ALLOWED_HOSTS),
  /** The address the browser reaches the app by, when that is not HOST:PORT (a TLS proxy). Its origin passes the Origin check. */
  publicUrl: (process.env.PUBLIC_URL ?? '').trim(),
  sessionTtlMs: num(process.env.SESSION_TTL_HOURS, 12) * 3600_000,

  openaiApiKey,
  anthropicApiKey,
  /** The .env file the keys are read from. Its path is shown on the Connect screen; its contents never are. */
  envFile: envPath,
  codexHome: process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),

  /** How the panel addresses you. Optional. */
  founderName: (process.env.FOUNDER_NAME ?? '').trim(),

  /**
   * Optional dollar ceiling for every debate that does not set its own. Off
   * when unset. At the ceiling the room asks you to extend it; it never cuts
   * the argument short by itself.
   */
  budgetCeilingUsd: (() => {
    const v = Number(process.env.BUDGET_CEILING_USD ?? '');
    return Number.isFinite(v) && v > 0 ? v : null;
  })(),

  // Directory holding a node binary the bundled Claude CLI survives on.
  // Node 25.x aborts inside the CLI; auto-detected below when unset.
  nodeBin: process.env.AGENT_NODE_BIN ?? '',

  // Claude Code CLI the agents run. The SDK's bundled 2.0.77 mis-encodes tool
  // calls (duplicate tool_use ids, then a retry loop into a 4GB OOM), so a
  // newer installed CLI is used when present. Auto-detected below when unset.
  cliPath: process.env.AGENT_CLI_PATH ?? '',

  // Agent settings
  /** 4 since Phase 2b: one slot is reserved for background research (see sdk.ts SLOTS). */
  maxConcurrentAgents: num(process.env.MAX_AGENTS, 4),
  turnThinking: num(process.env.TURN_THINKING, 32_000),   // setup + chair turns
  /**
   * The seats that do the actual reasoning now think like it.
   *
   * These were 4K (floor) and a hardcoded 4K (referee), tied to the fact that
   * a floor speech is only 60-120 words. That conflated two different things:
   * how long an expert THINKS and how long it SPEAKS. A real expert reasons at
   * length and then says one short devastating thing. The brevity stays; the
   * shallow thinking was a cost artifact and the brief is now quality only.
   * The referee matters most of all — it judges whether an argument is settled,
   * so it was the shallowest seat deciding how deep every motion goes.
   */
  floorThinking: num(process.env.FLOOR_THINKING, 24_000),
  refereeThinking: num(process.env.REFEREE_THINKING, 32_000),
  steerThinking: num(process.env.STEER_THINKING, 8_000),
  heavyThinking: num(process.env.HEAVY_THINKING, 60_000), // architect, planning, report
  turnTimeoutMs: num(process.env.TURN_TIMEOUT_MIN, 10) * 60_000,
  researchTimeoutMs: num(process.env.RESEARCH_TIMEOUT_MIN, 20) * 60_000,
  // The quant desk holds the floor while it works, so it gets a tighter leash
  // than research, which runs in the background while the room carries on.
  quantTimeoutMs: num(process.env.QUANT_TIMEOUT_MIN, 8) * 60_000,
  maxFloorMessages: num(process.env.MAX_FLOOR_MESSAGES, 120),
  maxInflightResearch: 2,
  /**
   * How fast a turn is performed to the room, in words a second (2b-7). A turn
   * is written in full, then played at this pace, which is what makes cut-offs,
   * talking over and pauses possible. 2.5 is ordinary speech; SPEAKING_PACE=0
   * plays every turn at once (tests). The MOCK engine scales it by MOCK_SPEED.
   */
  speakingPace: speakingPace(),
};

function speakingPace(): number {
  const raw = process.env.SPEAKING_PACE;
  const base = raw !== undefined && raw.trim() !== '' && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : 2.5;
  if (process.env.MOCK !== '1') return base;
  const s = (process.env.MOCK_SPEED ?? '1').trim();
  if (s === 'max') return 0;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? base * n : base;
}

/**
 * Pick a node runtime for spawned agent CLIs. The bundled Claude CLI aborts
 * under node 25.x, so prefer the current runtime when it is safe, else scan
 * common install roots for a supported major (20-24).
 */
function detectNodeBin(): string {
  const ok = (v: string) => {
    const major = Number(v.replace(/^v/, '').split('.')[0]);
    return major >= 20 && major <= 24;
  };
  if (ok(process.versions.node)) return path.dirname(process.execPath);

  const roots = [
    '/opt/homebrew/Cellar/node',
    '/usr/local/Cellar/node',
    path.join(process.env.HOME ?? '', '.nvm/versions/node'),
  ];
  const found: { v: string; dir: string }[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      const bin = path.join(root, entry, 'bin', 'node');
      if (ok(entry) && fs.existsSync(bin)) found.push({ v: entry, dir: path.dirname(bin) });
    }
  }
  found.sort((a, b) => (a.v < b.v ? 1 : -1)); // newest supported first
  if (found[0]) {
    console.log(`[config] agent runtime pinned to node ${found[0].v} (host node ${process.versions.node} is unsupported by the CLI)`);
    return found[0].dir;
  }
  console.warn(`[config] no supported node (20-24) found for agent subprocesses; host is ${process.versions.node}. Agents may abort.`);
  return '';
}

/**
 * Prefer a globally installed Claude Code CLI over the SDK's bundled 2.0.77.
 * Recent releases ship a native binary (per-platform package) rather than
 * cli.js; the SDK detects and spawns either form, so both are accepted.
 */
function detectCli(): string {
  const home = process.env.HOME ?? '';
  const roots = [
    '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code',
    '/usr/lib/node_modules/@anthropic-ai/claude-code',
    path.join(home, '.npm-global/lib/node_modules/@anthropic-ai/claude-code'),
    path.join(home, '.claude/local/node_modules/@anthropic-ai/claude-code'),
  ];
  const platformPkg = `claude-code-${process.platform}-${process.arch}`;

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const candidates = [
      path.join(root, 'node_modules/@anthropic-ai', platformPkg, 'claude'), // native binary
      path.join(root, 'cli.js'),                                            // classic JS bundle
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        console.log(`[config] agents using installed CLI at ${c}`);
        return c;
      }
    }
  }
  // Any other install (Homebrew cask, the native installer): the `claude` on PATH.
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const c = dir && path.join(dir, 'claude');
    if (c && fs.existsSync(c)) {
      const real = fs.realpathSync(c);
      console.log(`[config] agents using installed CLI at ${real}`);
      return real;
    }
  }
  console.warn('[config] no installed Claude CLI found; falling back to the SDK bundle, which may not know current model ids. Install Claude Code and sign in with `claude`.');
  return '';
}

/**
 * Pick up an API key added to (or changed in) .env since start-up, so the
 * Connect screen's Re-check works without a restart. Only the two key names
 * are read, and only a value that differs from what .env held at boot is
 * taken: a key set in the real environment still wins over an untouched file.
 * Returns which keys changed. The values never leave this module and CFG.
 */
export function rereadKeys(file = envPath): { openai: boolean; anthropic: boolean } {
  const now = readDotEnv(file);
  const take = (name: 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY', field: 'openaiApiKey' | 'anthropicApiKey'): boolean => {
    const v = (now[name] ?? '').trim();
    if (v === (bootDotEnv[name] ?? '').trim() || v === CFG[field]) return false;
    bootDotEnv[name] = v;
    CFG[field] = v;
    return true;
  };
  return { openai: take('OPENAI_API_KEY', 'openaiApiKey'), anthropic: take('ANTHROPIC_API_KEY', 'anthropicApiKey') };
}

if (!CFG.cliPath) CFG.cliPath = detectCli();
// Only a JavaScript CLI (cli.js, or the SDK's bundle) runs on node; a native binary does not care.
if (!CFG.nodeBin && (!CFG.cliPath || CFG.cliPath.endsWith('.js'))) CFG.nodeBin = detectNodeBin();

// Private to this user: debates and uploads can hold sensitive material.
fs.mkdirSync(CFG.dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(CFG.dataDir, 'debates'), { recursive: true, mode: 0o700 });

/**
 * The container's password, when nobody set one.
 *
 * Inside Docker the app must listen on all interfaces, and it never does that
 * without a password. Asking a non-coder to invent one before the first start
 * was the one extra step Docker cost, so the image sets AUTO_ACCESS_PASSWORD
 * and the first start generates a password, keeps it in the data volume (mode
 * 0600, beside the debates it protects) and prints it once. Later starts read
 * the same file and do not print it again. ACCESS_PASSWORD still wins when set.
 * Outside the image nothing changes: `npm start` stays password-free on
 * 127.0.0.1, and a non-loopback HOST without a password still refuses to start.
 */
export const PASSWORD_FILE = path.join(CFG.dataDir, '.access-password');
export let generatedPassword: string | null = null;
const loopbackHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(CFG.host.toLowerCase());
if (!CFG.accessPassword && !loopbackHost && process.env.AUTO_ACCESS_PASSWORD === '1') {
  const saved = fs.existsSync(PASSWORD_FILE) ? fs.readFileSync(PASSWORD_FILE, 'utf8').trim() : '';
  if (saved) {
    CFG.accessPassword = saved;
  } else {
    CFG.accessPassword = generatedPassword = crypto.randomBytes(18).toString('base64url');
    fs.writeFileSync(PASSWORD_FILE, CFG.accessPassword + '\n', { mode: 0o600 });
  }
}

export const debateDir = (id: string) => {
  const dir = path.join(CFG.dataDir, 'debates', id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
