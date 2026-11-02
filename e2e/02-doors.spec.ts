/**
 * A debate starts on each of the four ways once it is ready. MOCK=1 answers
 * every model call from a script whichever way is picked, so this proves the
 * path from New debate into the room for each, not the provider itself.
 */
import { test, expect } from './fixtures';
import { DOOR_TITLE, startDebate, type Door } from './helpers';

for (const door of Object.keys(DOOR_TITLE) as Door[]) {
  test(`a debate starts on ${DOOR_TITLE[door]}`, async ({ page }) => {
    await startDebate(page, { door, topic: `${DOOR_TITLE[door]}: should we move new customers to usage pricing from January?` });
    await expect(page.locator('.hud').getByText(DOOR_TITLE[door], { exact: true })).toBeVisible();
    // The chair's intake runs and asks its first question: the room is live.
    await expect(page.getByText('Clarification needed')).toBeVisible();
    await expect(page.getByRole('img', { name: 'Connected' })).toBeVisible();
  });
}

test('the deck lists each debate with the way it runs on', async ({ page }) => {
  await page.goto('/');
  for (const title of Object.values(DOOR_TITLE)) {
    await expect(page.locator('.lib-row').filter({ hasText: `${title}: should we move` }).getByText(title, { exact: true })).toBeVisible();
  }
});
