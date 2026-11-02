import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withReportCsp } from './csp.ts';

/**
 * HTML -> paginated PDF via headless Chrome.
 *
 * No npm dependency: we shell out to whatever Chrome/Chromium the host already
 * has. If none exists the caller keeps the interactive HTML and simply has no
 * PDF, so a missing browser can never fail a completed debate.
 */

const CANDIDATES = [
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

let cached: string | null | undefined;

/** Absolute path to a usable Chrome binary, or null. */
export function findChrome(): string | null {
  if (cached !== undefined) return cached;
  const fromEnv = process.env.CHROME_PATH;
  // CHROME_PATH=none turns PDF export and print QA off (the offline engine test uses it).
  if (fromEnv === 'none') return (cached = null);
  if (fromEnv && fs.existsSync(fromEnv)) return (cached = fromEnv);
  cached = CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
  return cached;
}

export class NoChromeError extends Error {
  constructor() {
    super(
      'No Chrome or Chromium found for PDF export. Install one (Debian/Ubuntu: sudo apt-get install -y chromium) or set CHROME_PATH.'
    );
    this.name = 'NoChromeError';
  }
}

/**
 * Chrome's own sandbox stays on wherever it can run. It cannot run as root
 * (Chrome refuses), and on some hosts it cannot start at all: containers
 * without user namespaces, and Ubuntu 23.10+ where AppArmor blocks them for
 * browsers it has no profile for. There, and only there, printing falls back
 * to `--no-sandbox`, with a warning, and stays there for the process.
 * CHROME_NO_SANDBOX=1 starts in the fallback. The page printed is the app's
 * own escaped HTML under a no-load CSP either way, so the fallback loses a
 * third wall, not the first.
 */
let sandboxUnavailable = false;
const SANDBOX_FAILURE = /no usable sandbox|--no-sandbox|setuid sandbox|namespace sandbox|zygote/i;

export function chromeSandboxFlags(): string[] {
  const off = sandboxUnavailable || process.env.CHROME_NO_SANDBOX === '1' || process.getuid?.() === 0;
  return off ? ['--no-sandbox'] : [];
}

/**
 * True when a failed Chrome run (with the sandbox on) reads like the sandbox
 * could not start. Records it so later runs go straight to the fallback.
 */
export function sandboxFailed(stderr: string): boolean {
  if (chromeSandboxFlags().length || !SANDBOX_FAILURE.test(stderr)) return false;
  sandboxUnavailable = true;
  console.warn('[pdf] Chrome cannot start its sandbox on this machine; printing without it. Set CHROME_NO_SANDBOX=1 to skip the first try.');
  return true;
}

/**
 * Renders `html` to `outPath` as A4 with backgrounds and page numbers.
 * The report's own @media print rules do the layout work; this only drives
 * pagination and the running footer.
 */
export function renderPdf(html: string, outPath: string, opts: { title?: string; timeoutMs?: number } = {}): Promise<void> {
  const chrome = findChrome();
  if (!chrome) return Promise.reject(new NoChromeError());
  const page = withReportCsp(html);
  return printOnce(chrome, page, outPath, opts).catch((err: Error & { stderr?: string }) => {
    if (sandboxFailed(err.stderr ?? '')) return printOnce(chrome, page, outPath, opts);
    throw err;
  });
}

function printOnce(chrome: string, html: string, outPath: string, opts: { timeoutMs?: number }): Promise<void> {

  // Snap-packaged Chromium (Ubuntu default) has a PRIVATE /tmp: it reports
  // bytes written but the file lands inside its sandbox and never appears on
  // the real filesystem. Staging under the data dir (inside $HOME) keeps both
  // the input and the output visible to confined and unconfined browsers alike.
  const stageRoot = process.env.DATA_DIR ?? os.tmpdir();
  fs.mkdirSync(stageRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(stageRoot, '.pdf-'));
  const src = path.join(tmp, 'report.html');
  const stagedOut = path.join(tmp, 'report.pdf');   // written where Chrome can reach, then moved
  fs.writeFileSync(src, html, 'utf8');

  const args = [
    '--headless=new',
    '--disable-gpu',
    ...chromeSandboxFlags(),           // empty unless the sandbox cannot run here (above)
    '--disable-dev-shm-usage',         // small /dev/shm on containers and VPS
    // Local-first: a fresh profile must not phone home (updates, sync, field trials).
    '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--no-pdf-header-footer',          // the document supplies its own furniture
    '--print-to-pdf-no-header',
    '--virtual-time-budget=8000',      // let inline scripts and fonts settle
    `--print-to-pdf=${stagedOut}`,
    `--user-data-dir=${path.join(tmp, 'profile')}`,
    'file://' + src,
  ];

  /**
   * Wait for the FILE, not for Chrome to exit.
   *
   * `--print-to-pdf` writes the document and then, on a full Chrome build,
   * frequently sits there instead of exiting. Waiting on `exit` therefore timed
   * out on a report that had been finished and flushed minutes earlier: the
   * caller saw a failure, while the artifact sat complete in the staging dir.
   * Polling for a file that has stopped growing is the honest signal, and it
   * behaves the same on chrome-headless-shell (which does exit) and on the
   * desktop browser (which does not).
   */
  return new Promise<void>((resolve, reject) => {
    const budget = opts.timeoutMs ?? 90_000;
    const proc = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    proc.stderr?.on('data', (d) => { stderr = (stderr + String(d)).slice(-1500); });

    const cleanup = () => {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    };
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      if (err) { cleanup(); return reject(Object.assign(err, { stderr })); }
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.copyFileSync(stagedOut, outPath);
      cleanup();
      resolve();
    };

    let lastSize = -1;
    let stableFor = 0;
    const poll = setInterval(() => {
      let size = 0;
      try { size = fs.existsSync(stagedOut) ? fs.statSync(stagedOut).size : 0; } catch { return; }
      if (size < 1000) return;                       // not written yet
      stableFor = size === lastSize ? stableFor + 1 : 0;
      lastSize = size;
      if (stableFor >= 3) finish();                  // ~1.5s unchanged: flushed
    }, 500);

    const timer = setTimeout(() => {
      const wrote = fs.existsSync(stagedOut) && fs.statSync(stagedOut).size >= 1000;
      // Out of time but the file is there: take it rather than throw away a
      // finished report because the browser would not close.
      finish(wrote ? undefined : new Error(`PDF render timed out after ${budget / 1000}s. ${stderr.slice(-300)}`));
    }, budget);

    proc.on('error', (err) => finish(err));
    proc.on('exit', (code) => {
      // Fast path when the browser does exit: give the write a beat to land.
      setTimeout(() => {
        const ok = fs.existsSync(stagedOut) && fs.statSync(stagedOut).size >= 1000;
        finish(ok ? undefined : new Error(`Chrome produced no PDF (exit ${code}). ${stderr.slice(-400)}`));
      }, 300);
    });
  });
}
