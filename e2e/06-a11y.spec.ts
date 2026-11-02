/**
 * Accessibility smoke check: axe-core on the main screens, in both themes and
 * at both widths. Any critical or serious violation fails, with the rule, the
 * elements and why, so it can be fixed rather than guessed at.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

async function axe(page: Page, label: string, opts: { frame?: boolean } = {}) {
  let b = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  if (!opts.frame) b = b.exclude('iframe');
  const res = await b.analyze();
  const bad = res.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  const lines = bad.flatMap((v) => [
    `${label}: [${v.impact}] ${v.id}: ${v.help}`,
    ...v.nodes.slice(0, 6).map((n) => `    ${n.target.join(' ')}: ${n.failureSummary?.split('\n').slice(1, 2).join(' ').trim()}`),
  ]);
  expect(lines, `axe on ${label}`).toEqual([]);
}

async function screens(page: Page, theme: 'dark' | 'light', tag: string) {
  await page.goto('/');
  await page.evaluate((t) => localStorage.setItem('debate.theme', t), theme);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.waitForTimeout(600);
  await axe(page, `deck ${tag}`);

  await page.getByRole('button', { name: /^Sound (on|off)$/ }).click();
  await axe(page, `settings menu ${tag}`);
  await page.keyboard.press('Escape');

  await page.goto('/connect');
  await expect(page.locator('.cx-card').first()).toBeVisible();
  await axe(page, `connect ${tag}`);

  await page.goto('/new');
  await expect(page.getByRole('radiogroup', { name: 'Which AI runs the debate' })).toBeVisible();
  await page.waitForTimeout(600);
  await axe(page, `new debate ${tag}`);

  // A finished debate: the room, then the report (inside its frame too).
  await page.goto('/');
  await page.locator('.lib-row').filter({ has: page.getByRole('button', { name: 'Report' }) }).first().click();
  await expect(page.locator('.hud')).toBeVisible();
  await page.waitForTimeout(1000);
  await axe(page, `room ${tag}`);
  await page.locator('.hud').getByRole('button', { name: 'Report', exact: true }).click();
  await page.waitForTimeout(1500);
  await axe(page, `report ${tag}`, { frame: true });

  // A debate waiting on the founder (02-doors leaves some at their first question): the question card.
  await page.goto('/');
  await page.locator('.lib-row').filter({ hasText: 'Clarifying' }).first().click();
  await expect(page.getByText('Clarification needed')).toBeVisible();
  await page.waitForTimeout(600);
  await axe(page, `room question ${tag}`);
  await page.evaluate(() => localStorage.removeItem('debate.theme'));
}

test('no critical or serious violations, dark, 1440px', async ({ page }) => {
  await screens(page, 'dark', 'dark 1440');
});

test('no critical or serious violations, light, 1440px', async ({ page }) => {
  await screens(page, 'light', 'light 1440');
});

test.describe('390px', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('no critical or serious violations, dark and light, 390px', async ({ page }) => {
    await screens(page, 'dark', 'dark 390');
    await screens(page, 'light', 'light 390');
  });
});
