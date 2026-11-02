/**
 * A spent AI allowance pauses the debate instead of failing it, says so in a
 * banner with when it will try again, and Resume carries on from the same
 * step. The mock spends the allowance once for a topic marked #mock-quota.
 */
import { test, expect } from './fixtures';
import { shot, startDebate } from './helpers';

test('quota pause: the banner says what happened and Resume carries on', async ({ page }) => {
  await startDebate(page, {
    door: 'anthropic',
    autonomous: true,
    topic: 'Should we move new customers to usage pricing from January? #mock-quota',
  });
  const banner = page.getByRole('status').filter({ hasText: 'Paused: waiting for quota' });
  await expect(banner).toBeVisible({ timeout: 90_000 });
  await expect(banner).toContainText(/resumes ~\d{1,2}:\d{2}/);
  await expect(banner).toContainText('Nothing is lost or cut');
  await expect(page.locator('.hud')).toContainText('Paused');
  await shot(page, 'room-quota-pause');

  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(banner).toBeHidden();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  // It goes on to finish by itself (autonomous), nothing cut.
  await expect(page.locator('.hud').getByRole('button', { name: 'Report', exact: true })).toBeVisible({ timeout: 150_000 });
});
