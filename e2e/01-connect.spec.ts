/**
 * First run on a computer with no AI connected: the Connect screen opens by
 * itself, shows all four ways with live statuses, copies the exact commands,
 * and Re-check picks up a key, a login or a fix without a restart. New
 * debate's Start stays off, with the fix beside it, until the picked way is
 * ready.
 */
import { test, expect } from './fixtures';
import { DOOR_TITLE, TOPIC, doorButton, setEnvKey, shot, signInClaude, signInCodex } from './helpers';

const card = (page: import('@playwright/test').Page, title: string) => page.getByRole('region', { name: title });

test.describe.configure({ mode: 'serial' });

test('first run opens Connect your AI, with four cards that each say what is missing', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/connect$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Connect your AI' })).toBeVisible();
  for (const title of Object.values(DOOR_TITLE)) {
    const c = card(page, title);
    await expect(c).toBeVisible();
    await expect(c.getByText('Needs setup', { exact: true })).toBeVisible();
    await expect(c.getByRole('button', { name: 'Re-check' })).toBeVisible();
    await expect(c.getByText(/How to fix/)).toBeVisible();
  }
  await expect(card(page, DOOR_TITLE.claude)).toContainText('installed but not signed in');
  await expect(card(page, DOOR_TITLE.anthropic)).toContainText('No ANTHROPIC_API_KEY');
  await expect(card(page, DOOR_TITLE.codex)).toContainText('not signed in');
  await expect(card(page, DOOR_TITLE.openai)).toContainText('No OPENAI_API_KEY');
  // Nothing is ready, so there is no shortcut to a debate yet.
  await expect(page.getByRole('button', { name: 'Start a new debate' })).toHaveCount(0);
  await shot(page, 'connect-none-ready');

  // Shown once: the next visit to the deck stays on the deck and says why.
  await page.goto('/');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('No AI is connected yet')).toBeVisible();
});

test('every command has a Copy button that puts exactly that text on the clipboard', async ({ page, context }) => {
  // The server's own origin, so E2E_PORT moves the grant with it.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(test.info().project.use.baseURL!).origin });
  await page.goto('/connect');
  const claude = card(page, DOOR_TITLE.claude);
  const copies = claude.getByRole('button', { name: /^Copy / });
  await expect(copies).toHaveCount(2);
  await claude.getByRole('button', { name: 'Copy npm install -g @anthropic-ai/claude-code' }).click();
  await expect(claude.getByRole('button', { name: 'Copy npm install -g @anthropic-ai/claude-code' })).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npm install -g @anthropic-ai/claude-code');

  const openai = card(page, DOOR_TITLE.openai);
  await openai.getByRole('button', { name: 'Copy OPENAI_API_KEY=' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('OPENAI_API_KEY=');
  // The .env command names the real file, quoted.
  const envCmd = openai.locator('code.cx-copy-v').filter({ hasText: '.env' });
  await expect(envCmd).toContainText('.scratch/e2e/.env"');
  // A long command wraps instead of being cut off.
  const box = await envCmd.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(box.scroll).toBeLessThanOrEqual(box.client + 1);
});

test('New debate: Start is off with the fix shown while no way is ready', async ({ page, baseURL }) => {
  await page.goto('/new');
  await page.getByLabel('What should the panel decide?').fill(TOPIC);
  for (const door of ['claude', 'anthropic', 'codex', 'openai'] as const) {
    const b = doorButton(page, door);
    await expect(b).toHaveAccessibleName(new RegExp('Needs setup'));
  }
  const start = page.getByRole('button', { name: 'Start the debate' });
  await expect(start).toBeDisabled();
  const fix = page.getByRole('status').filter({ hasText: 'Needs setup' });
  await expect(fix).toContainText(`${DOOR_TITLE.claude}: Needs setup`);
  await expect(fix).toContainText('run claude');
  await expect(fix.getByRole('button', { name: 'Re-check' })).toBeVisible();
  await expect(page.getByText(/Connect Claude: sign in first/)).toBeVisible();
  await shot(page, 'new-blocked');

  // The server refuses too, in words, whatever the page does.
  const csrf = (await (await page.request.get('/api/me')).json()).csrfToken;
  const res = await page.request.post('/api/debates', {
    headers: { 'x-csrf-token': csrf, origin: new URL(test.info().project.use.baseURL!).origin },
    data: { topic: TOPIC, config: { provider: 'openai', mode: 'directed', autonomy: 'interactive' } },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toMatch(/OpenAI: API key is not ready/);
});

test('Re-check: a wrong key is a Problem with its fix, a right key is Ready, no restart', async ({ page }) => {
  await page.goto('/connect');
  // An OpenAI key pasted on the Anthropic line.
  setEnvKey('ANTHROPIC_API_KEY', 'sk-proj-e2e-wrong-line');
  const anthropic = card(page, DOOR_TITLE.anthropic);
  await anthropic.getByRole('button', { name: 'Re-check' }).click();
  await expect(anthropic.getByText('Problem', { exact: true })).toBeVisible();
  await expect(anthropic).toContainText('looks like an OpenAI key');
  await expect(anthropic).toContainText('rename the line to OPENAI_API_KEY=');
  // The key itself is never shown.
  await expect(page.locator('body')).not.toContainText('sk-proj-e2e-wrong-line');

  setEnvKey('OPENAI_API_KEY', 'sk-e2e-not-a-real-key');
  const openai = card(page, DOOR_TITLE.openai);
  await openai.getByRole('button', { name: 'Re-check' }).click();
  await expect(openai.getByText('Ready', { exact: true })).toBeVisible();
  await expect(openai.getByRole('button', { name: 'Start a debate with this' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start a new debate' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('sk-e2e-not-a-real-key');
  await shot(page, 'connect-one-ready');
});

test('New debate: Start comes on for a ready way, and stays off for one that is not', async ({ page }) => {
  await page.goto('/new');
  await page.getByLabel('What should the panel decide?').fill(TOPIC);
  // The first ready way is picked for you.
  await expect(doorButton(page, 'openai')).toHaveAttribute('aria-checked', 'true');
  await expect(doorButton(page, 'openai')).toHaveAccessibleName(/Ready/);
  const start = page.getByRole('button', { name: 'Start the debate' });
  await expect(start).toBeEnabled();
  await doorButton(page, 'anthropic').click();
  await expect(start).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: 'Problem' })).toContainText('looks like an OpenAI key');
  await doorButton(page, 'openai').click();
  await expect(start).toBeEnabled();
});

test('all four ways become Ready as they are set up', async ({ page }) => {
  setEnvKey('ANTHROPIC_API_KEY', 'sk-ant-api03-FAKE-e2e-test-key');
  signInClaude();
  signInCodex();
  await page.goto('/connect');
  await page.getByRole('button', { name: 'Re-check all' }).click();
  for (const title of Object.values(DOOR_TITLE)) {
    await expect(card(page, title).getByText('Ready', { exact: true })).toBeVisible();
  }
  await expect(card(page, DOOR_TITLE.claude)).toContainText('installed and signed in');
  await expect(card(page, DOOR_TITLE.codex)).toContainText('Signed in to Codex with ChatGPT');
  // A ready card keeps its steps folded away.
  await expect(card(page, DOOR_TITLE.claude).getByText('How this was set up')).toBeVisible();
  await expect(card(page, DOOR_TITLE.claude).getByText(/How to fix/)).toHaveCount(0);
  await shot(page, 'connect-all-ready');
  await card(page, DOOR_TITLE.codex).getByRole('button', { name: 'Start a debate with this' }).click();
  await expect(page).toHaveURL(/\/new\?door=codex$/);
  await expect(doorButton(page, 'codex')).toHaveAttribute('aria-checked', 'true');
});
