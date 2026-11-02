/**
 * The rest of the surface: the settings menu and the theme, the notification
 * prompt (only ever after a click), the keyboard, reduced motion, and a
 * 390px phone screen.
 */
import { test, expect, probes } from './fixtures';
import { TOPIC, overflowing, shot } from './helpers';

test.describe('settings and theme', () => {
  test('dark by default; Light and System switch it and survive a reload', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: /^Sound (on|off)$/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Sound and display' });
    await dialog.getByRole('radio', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(dialog.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await shot(page, 'deck-light');

    // System follows the computer's setting, live.
    await page.getByRole('button', { name: /^Sound (on|off)$/ }).click();
    await page.getByRole('dialog').getByRole('radio', { name: 'System' }).click();
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    // The menu's link reaches Connect your AI.
    await page.getByRole('dialog').getByRole('link', { name: 'Connect your AI' }).click();
    await expect(page).toHaveURL(/\/connect$/);
    await page.evaluate(() => localStorage.removeItem('debate.theme'));
  });

  test('the settings menu closes on Escape and on a click outside', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByRole('button', { name: /^Sound (on|off)$/ });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await toggle.click();
    await page.mouse.click(10, 880);
    await expect(page.getByRole('dialog')).toBeHidden();
  });
});

test.describe('notifications', () => {
  test('the permission prompt never appears on page load, only after a click', async ({ page }) => {
    for (const path of ['/', '/new', '/connect']) {
      await page.goto(path);
      await page.waitForTimeout(800);
      expect((await probes(page)).permissionAsks, `asked on load of ${path}`).toBe(0);
    }
    await page.goto('/new');
    await expect(page.getByText('Your browser will ask for permission when you start the debate.')).toBeVisible();
    await page.getByRole('button', { name: 'Allow now' }).click();
    expect((await probes(page)).permissionAsks).toBe(1);
    await expect(page.getByText(/You will get a notification when a debate needs your answer/)).toBeVisible();
  });

  test('starting a debate is the click that asks, once', async ({ page }) => {
    await page.goto('/new');
    await page.getByLabel('What should the panel decide?').fill(TOPIC);
    expect((await probes(page)).permissionAsks).toBe(0);
    await page.getByRole('button', { name: 'Start the debate' }).click();
    await page.waitForURL(/\/debate\//);
    // An in-app navigation: the same window, so the count carries over.
    expect((await probes(page)).permissionAsks).toBe(1);
    await page.goBack();
    // Answered once: turning the switch off and on again does not ask again.
    await page.getByRole('button', { name: 'Notify me: on' }).click();
    await expect(page.getByText('Off. The tab title still shows')).toBeVisible();
    await page.getByRole('button', { name: 'Notify me: off' }).click();
    expect((await probes(page)).permissionAsks).toBe(1);
  });
});

test.describe('keyboard', () => {
  test('the deck, New debate and Connect work from the keyboard alone, with a visible focus ring', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Tab to the New debate tile and press Enter.
    let found = false;
    for (let i = 0; i < 12 && !found; i++) {
      await page.keyboard.press('Tab');
      found = await page.evaluate(() => document.activeElement?.classList.contains('new-tile') ?? false);
    }
    expect(found, 'the New debate tile is reachable with Tab').toBe(true);
    const ring = await page.evaluate(() => {
      const cs = getComputedStyle(document.activeElement!);
      return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1 ? 'outline' : cs.boxShadow !== 'none' ? 'shadow' : 'none';
    });
    expect(ring, 'focus is visible').not.toBe('none');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/new$/);

    // The topic, then the AI picker as one radio group moved with the arrow keys.
    const topic = page.getByLabel('What should the panel decide?');
    await topic.focus();
    await page.keyboard.type('Keyboard only: should we open a second office?');
    const group = page.getByRole('radiogroup', { name: 'Which AI runs the debate' });
    await group.getByRole('radio', { checked: true }).focus();
    const first = await group.getByRole('radio', { checked: true }).getAttribute('data-door');
    await page.keyboard.press('ArrowRight');
    const next = await group.getByRole('radio', { checked: true }).getAttribute('data-door');
    expect(next).not.toBe(first);
    await expect(group.getByRole('radio', { checked: true })).toBeFocused();

    // Connect: every Copy and Re-check button is a real button in the tab order.
    await page.goto('/connect');
    // The cards render once the door check answers; count() does not wait.
    await expect(page.locator('.cx-card')).toHaveCount(4);
    const buttons = page.locator('.cx-card button');
    const n = await buttons.count();
    expect(n).toBeGreaterThan(8);
    for (let i = 0; i < n; i++) expect(await buttons.nth(i).getAttribute('tabindex')).not.toBe('-1');
  });

  test('a past debate opens with Enter', async ({ page }) => {
    await page.goto('/');
    const row = page.locator('.lib-row').first();
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/debate\/d_/);
  });
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });
  test('animations stop and sound defaults to key cues only', async ({ page }) => {
    await page.goto('/');
    const moving = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
        const cs = getComputedStyle(el);
        const dur = Math.max(...cs.animationDuration.split(',').map((s) => parseFloat(s) || 0));
        if (cs.animationName !== 'none' && dur > 0.02 && cs.animationIterationCount === 'infinite') out.push(el.className);
      }
      return out;
    });
    expect(moving, 'endless animations under reduced motion').toEqual([]);
    await page.getByRole('button', { name: /^Sound (on|off)$/ }).click();
    await page.getByRole('dialog').getByRole('switch', { name: 'Sound' }).click();
    await expect(page.getByRole('dialog').getByRole('radio', { name: 'Key only' })).toHaveAttribute('aria-checked', 'true');
    await page.evaluate(() => localStorage.removeItem('debate.sound.v2'));
  });

  test('the live room has no endless animation either', async ({ page }) => {
    await page.goto('/');
    await page.locator('.lib-row').first().click();
    await expect(page.locator('.hud')).toBeVisible();
    await page.waitForTimeout(800);
    const moving = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('*'))
        .filter((el) => {
          const cs = getComputedStyle(el);
          return cs.animationName !== 'none' && cs.animationIterationCount === 'infinite' && parseFloat(cs.animationDuration) > 0.02;
        })
        .map((el) => el.className),
    );
    expect(moving).toEqual([]);
  });
});

test.describe('a 390px phone screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  for (const [name, path] of [['deck', '/'], ['connect', '/connect'], ['new', '/new']] as const) {
    test(`${name}: nothing spills off the side`, async ({ page }) => {
      await page.goto(path);
      await page.waitForTimeout(800);
      expect(await overflowing(page)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await shot(page, `${name}-390`);
    });
  }
  test('the room and the report fit, and the panel and record open as drawers', async ({ page }) => {
    await page.goto('/');
    const done = page.locator('.lib-row').filter({ has: page.getByRole('button', { name: 'Report' }) }).first();
    await done.click();
    await expect(page.locator('.hud')).toBeVisible();
    await page.waitForTimeout(800);
    expect(await overflowing(page)).toEqual([]);
    await shot(page, 'room-390');
    await page.getByRole('button', { name: 'Panel', exact: true }).click();
    await expect(page.locator('.drawer.left')).toBeVisible();
    await page.locator('.drawer').getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(page.locator('.drawer.right')).toContainText('Decisions');
    await page.locator('.drawer').getByRole('button', { name: 'Close' }).click();
    await page.locator('.hud').getByRole('button', { name: 'Report', exact: true }).click();
    await page.waitForTimeout(1200);
    expect(await overflowing(page)).toEqual([]);
    const frameOverflow = await page.frameLocator('iframe[title="Debate report"]').locator('body').evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(frameOverflow).toBeLessThanOrEqual(1);
    await shot(page, 'report-390');
  });
});
