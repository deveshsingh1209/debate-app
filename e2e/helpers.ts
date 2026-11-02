/**
 * The sandbox the server runs in (serve.mjs) and the steps a founder takes.
 * Tests change what the doors see the way a person would: a key in .env, a
 * Claude or Codex login appearing, then Re-check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page } from '@playwright/test';

const repo = fileURLToPath(new URL('..', import.meta.url));
export const SANDBOX = path.join(repo, '.scratch', 'e2e');
export const SHOTS = path.join(repo, '.scratch', 'e2e-shots');

/** Set (or remove, with null) one line of the sandbox's .env. */
export function setEnvKey(name: string, value: string | null) {
  const file = path.join(SANDBOX, '.env');
  const lines = (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split('\n').filter((l) => l && !l.startsWith(`${name}=`));
  if (value !== null) lines.push(`${name}=${value}`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

/** What `claude` + sign-in leaves behind, as far as the stub is concerned. */
export function signInClaude() {
  fs.writeFileSync(path.join(SANDBOX, 'state', 'claude-signed-in'), '1');
}

/** What `codex login` with ChatGPT leaves behind. */
export function signInCodex() {
  fs.writeFileSync(
    path.join(SANDBOX, 'codex', 'auth.json'),
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'a.b.c', refresh_token: 'r', account_id: 'acct' }, last_refresh: '2026-10-01T00:00:00Z' }),
  );
}

export const DOOR_TITLE = {
  claude: 'Claude: sign in',
  anthropic: 'Claude: API key',
  codex: 'ChatGPT: Codex sign-in',
  openai: 'OpenAI: API key',
} as const;
export type Door = keyof typeof DOOR_TITLE;

export const TOPIC =
  'We sell a design tool on per-seat pricing at $12 a seat. Should new customers move to usage-based pricing from 1 January, and how do we protect existing accounts?';

/** The door buttons on New debate are named "<title>, <state>". */
export function doorButton(page: Page, door: Door): Locator {
  return page.getByRole('radio', { name: new RegExp(`^${DOOR_TITLE[door].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) });
}

/** Start a debate from New debate on one door. Returns its id. */
export async function startDebate(page: Page, opts: { door: Door; topic?: string; autonomous?: boolean }): Promise<string> {
  await page.goto('/new');
  await page.getByLabel('What should the panel decide?').fill(opts.topic ?? TOPIC);
  await doorButton(page, opts.door).click();
  await expect(doorButton(page, opts.door)).toHaveAttribute('aria-checked', 'true');
  if (opts.autonomous) await page.getByRole('radio', { name: /Autonomous/ }).click();
  const start = page.getByRole('button', { name: 'Start the debate' });
  await expect(start).toBeEnabled();
  await start.click();
  await page.waitForURL(/\/debate\/d_[\w-]+$/);
  return page.url().split('/debate/')[1];
}

/**
 * Play the founder until the debate is complete: answer each question with
 * its first option and approve the goal, panel and plan. `onTick` runs on
 * every pass before anything is clicked, so a test can look at the room as it goes.
 */
export async function driveToEnd(page: Page, onTick?: () => Promise<void>, limitMs = 150_000) {
  const t0 = Date.now();
  const hud = page.locator('.hud');
  while (Date.now() - t0 < limitMs) {
    if (await hud.getByRole('button', { name: 'Report', exact: true }).isVisible()) return;
    // Look before acting: a question card is answered (and gone) by the click below.
    if (onTick) await onTick();
    const tries: Locator[] = [
      page.locator('.dock .opt-card:not([disabled])').first(),
      page.getByRole('button', { name: 'Approve goal' }),
      page.getByRole('button', { name: 'Approve panel' }),
      page.getByRole('button', { name: 'Approve plan' }),
    ];
    for (const t of tries) {
      if (await t.isVisible() && await t.isEnabled()) {
        await t.click();
        await page.waitForTimeout(500);
        break;
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`the debate did not finish in ${limitMs / 1000}s`);
}

/** Every element of the page that is wider than the viewport (and not inside something that scrolls sideways on purpose). */
export async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 1 || r.left < -1) {
        // Inside a horizontal scroller, or visually hidden: fine.
        let p: HTMLElement | null = el.parentElement;
        let ok = false;
        while (p) {
          const cs = getComputedStyle(p);
          if (/(auto|scroll|hidden|clip)/.test(cs.overflowX) && p.getBoundingClientRect().right <= vw + 1) { ok = true; break; }
          p = p.parentElement;
        }
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed' && cs.visibility === 'hidden') ok = true;
        if (el.closest('.sr-only')) ok = true;
        if (!ok) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')} [${Math.round(r.left)}..${Math.round(r.right)}]`);
      }
    }
    return out.slice(0, 12);
  });
}

export async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}
