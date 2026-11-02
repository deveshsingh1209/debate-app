/**
 * The screenshots in docs/screenshots (compressed JPEGs), taken from the state
 * the suite leaves behind. Only runs under `npm run e2e:shots`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { driveToEnd, startDebate } from './helpers';

const OUT = fileURLToPath(new URL('../docs/screenshots', import.meta.url));

async function theme(page: Page, t: 'dark' | 'light') {
  await page.goto('/');
  await page.evaluate((v) => localStorage.setItem('debate.theme', v), t);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', t);
}

async function snap(page: Page, name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 72 });
}

test('docs screenshot: the live room, people talking over each other', async ({ page }) => {
  await theme(page, 'dark');
  await startDebate(page, { door: 'claude' });
  let taken = false;
  await driveToEnd(page, async () => {
    if (!taken && (await page.locator('.crosstalk').count())) {
      taken = true;
      await snap(page, 'room-dark-1440');
    }
  });
  expect(taken, 'the room showed crosstalk').toBe(true);
  await page.evaluate(() => localStorage.removeItem('debate.theme'));
});

async function openComplete(page: Page) {
  await page.goto('/');
  await page.locator('.lib-row').filter({ has: page.getByRole('button', { name: 'Report' }) }).first().click();
  await expect(page.locator('.hud')).toBeVisible();
}

test('docs screenshots, 1440px', async ({ page }) => {
  await theme(page, 'dark');
  await snap(page, 'deck-dark-1440');

  await page.goto('/connect');
  await expect(page.locator('.cx-card')).toHaveCount(4);
  await snap(page, 'connect-dark-1440');

  await openComplete(page);
  await page.locator('.hud').getByRole('button', { name: 'Report', exact: true }).click();
  await expect(page.frameLocator('iframe[title="Debate report"]').getByRole('heading', { name: 'Key Recommendation' })).toBeVisible();
  await snap(page, 'report-dark-1440');

  await theme(page, 'light');
  await page.goto('/new');
  await page.getByLabel('What should the panel decide?').fill(
    'We sell a design tool on per-seat pricing at $12 a seat. Should new customers move to usage-based pricing from 1 January?',
  );
  await snap(page, 'new-light-1440');

  await openComplete(page);
  await snap(page, 'room-light-1440');
  await page.evaluate(() => localStorage.removeItem('debate.theme'));
});

test.describe('390px', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('docs screenshots, 390px', async ({ page }) => {
    await theme(page, 'dark');
    await page.locator('.lib-row').filter({ hasText: 'Clarifying' }).first().click();
    await expect(page.getByText('Clarification needed')).toBeVisible();
    await snap(page, 'question-dark-390');

    await openComplete(page);
    await snap(page, 'room-dark-390');
    await page.evaluate(() => localStorage.removeItem('debate.theme'));
  });
});
