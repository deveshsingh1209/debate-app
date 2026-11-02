/**
 * The doors probe on this machine: probe.ts wired to the server's config,
 * with a ~30 s cache so the Connect screen and the New Debate screen can ask
 * as often as they like without spawning a CLI each time.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CFG, rereadKeys } from '../config.ts';
import { claudeChildEnv, codexAuthPath } from '../agents/sdk.ts';
import { wireOpenAI } from '../agents/openai.ts';
import { probeDoors, type CmdResult, type ProbeEnv } from './probe.ts';
import type { Provider } from '../../../shared/models.ts';
import type { DoorStatus, DoorsInfo } from '../../../shared/types.ts';

export const DOORS_TTL_MS = 30_000;
/** A Re-check storm (a held-down button) still spawns at most one probe this often. */
const FRESH_MIN_MS = 2_000;
const RUN_TIMEOUT_MS = 8_000;

/**
 * Run a CLI for a status line. The environment is the Claude child's
 * allowlist without any API key, so `claude auth status` reports the login,
 * and nothing secret is handed to a program that only needs to say yes or no.
 */
function run(cmd: string, args: string[]): Promise<CmdResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: { ...claudeChildEnv(), CODEX_HOME: CFG.codexHome }, timeout: RUN_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string }) | null;
      if (e && e.code === 'ENOENT') return resolve({ found: false, code: null, out: '' });
      if (e && (e.killed || e.signal === 'SIGTERM')) return resolve({ found: true, code: null, out: '', timedOut: true });
      resolve({ found: true, code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: `${stdout ?? ''}${stderr ?? ''}` });
    });
  });
}

/** How to start the detected Claude CLI: a native binary directly, a cli.js through node. */
function claudeCli(): ProbeEnv['claudeCli'] {
  if (!CFG.cliPath) return null;
  if (!CFG.cliPath.endsWith('.js')) return { cmd: CFG.cliPath, args: [] };
  const node = CFG.nodeBin ? path.join(CFG.nodeBin, 'node') : process.execPath;
  return { cmd: node, args: [CFG.cliPath] };
}

export function liveProbeEnv(): ProbeEnv {
  return {
    env: process.env,
    anthropicKey: CFG.anthropicApiKey,
    openaiKey: CFG.openaiApiKey,
    claudeCli: claudeCli(),
    codexCli: { cmd: 'codex', args: [] },
    codexAuthFile: codexAuthPath(),
    readFile: (f) => {
      try { return fs.readFileSync(f, 'utf8'); } catch { return null; }
    },
    run,
    envFile: CFG.envFile,
    platform: process.platform,
  };
}

/** Re-read the API keys in .env and hand a changed OpenAI key to its client. Logs names, never values. */
export function reloadKeys(file?: string) {
  const changed = rereadKeys(file);
  if (changed.openai) wireOpenAI({ apiKey: CFG.openaiApiKey });
  if (changed.openai || changed.anthropic) {
    console.log(`[doors] re-read .env: ${[changed.anthropic && 'ANTHROPIC_API_KEY', changed.openai && 'OPENAI_API_KEY'].filter(Boolean).join(', ')} changed`);
  }
  return changed;
}

let cached: { at: number; doors: DoorStatus[] } | null = null;
let inflight: Promise<DoorStatus[]> | null = null;
let probeEnvFor: () => ProbeEnv = liveProbeEnv;

/** Tests: probe a fake machine instead of this one. Resets the cache. */
export function wireDoors(f: (() => ProbeEnv) | null) {
  probeEnvFor = f ?? liveProbeEnv;
  cached = null;
}

/**
 * Every door's status. Cached for DOORS_TTL_MS; `fresh` re-checks now (and
 * first re-reads the two API keys from .env, so a key pasted in a moment ago
 * works without a restart). Concurrent callers share one probe.
 */
export async function doorStatuses(fresh = false): Promise<DoorStatus[]> {
  // Reading .env is cheap, so a fresh check always does it first: a key pasted
  // a moment ago must not be hidden by the storm guard or a probe already running.
  const keysChanged = fresh && probeEnvFor === liveProbeEnv && Object.values(reloadKeys()).some(Boolean);
  const now = Date.now();
  if (!keysChanged && cached && now - cached.at < (fresh ? FRESH_MIN_MS : DOORS_TTL_MS)) return cached.doors;
  if (inflight && !keysChanged) return inflight;
  const before = inflight ?? Promise.resolve();
  const p: Promise<DoorStatus[]> = before
    .catch(() => {})
    .then(() => probeDoors(probeEnvFor()))
    .then((doors) => {
      cached = { at: Date.now(), doors };
      return doors;
    })
    .finally(() => { if (inflight === p) inflight = null; });
  inflight = p;
  return p;
}

export async function doorStatus(id: Provider, fresh = false): Promise<DoorStatus> {
  return (await doorStatuses(fresh)).find((d) => d.id === id)!;
}

export async function doorsInfo(fresh = false): Promise<DoorsInfo> {
  return { doors: await doorStatuses(fresh), envFile: CFG.envFile, mock: CFG.mock && !CFG.mockRequireDoor };
}
