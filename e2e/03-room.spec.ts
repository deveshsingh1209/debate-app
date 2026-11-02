/**
 * One whole debate, played by the founder through the browser: the questions,
 * the three approvals, Marcus's question mid-debate, then the live room
 * (people talking over each other, cut-offs, pauses, belief changes), the
 * room's sound (off until asked for, quiet when on) and the report.
 */
import { test, expect, probes } from './fixtures';
import { driveToEnd, shot, startDebate } from './helpers';

test.describe.configure({ mode: 'serial' });

let debateUrl = '';

test('the live room: overlap, cut-offs, pauses and belief changes, with sound off throughout', async ({ page }) => {
  await startDebate(page, { door: 'claude' });
  debateUrl = page.url();
  const seen = { crosstalk: false, marcusAsked: false, title: false };
  await driveToEnd(page, async () => {
    if (!seen.crosstalk && (await page.locator('.crosstalk').count())) {
      seen.crosstalk = true;
      await expect(page.locator('.crosstalk-k')).toHaveText('Talking over each other');
      await shot(page, 'room-crosstalk');
    }
    if (!seen.marcusAsked && (await page.getByText('Marcus needs your call').isVisible())) {
      seen.marcusAsked = true;
      await shot(page, 'room-question');
    }
    if (!seen.title && (await page.locator('.hud-title').innerText()).toLowerCase().includes('price problem')) seen.title = true;
  });
  expect(seen.marcusAsked, 'Marcus asked the founder a question mid-debate').toBe(true);
  expect(seen.title, 'the room took the name intake gave it').toBe(true);

  // Everything the live floor did is on the record after the fact too.
  const feed = page.locator('.feed');
  await expect(feed.locator('.bub-cut').first()).toContainText(/cut off by /);
  await expect(feed.locator('.bub-tag.over').first()).toContainText(/^over /);
  await expect(feed.locator('.pause-beat').first()).toBeAttached();
  await expect(feed.locator('.pause-beat .pb-len').first()).toHaveText(/^\d+s$/);
  const concession = feed.locator('.concession').first();
  await expect(concession).toBeAttached();
  await expect(concession.getByRole('img', { name: /^From .+ to .+/ })).toBeAttached();
  await expect(concession).toContainText(/What it cost/);
  await expect(page.locator('.rail.right')).toContainText('1');

  // Sound is off by default, and nothing made an AudioContext in the whole debate, clicks and all.
  await expect(page.getByRole('button', { name: 'Sound off' })).toBeVisible();
  expect((await probes(page)).audioContexts).toBe(0);
  await shot(page, 'room-complete');
});

test('sound: on only when asked, quiet by default, volume and mute work', async ({ page }) => {
  await page.goto(debateUrl);
  await page.getByRole('button', { name: 'Sound off' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sound and display' });
  await expect(dialog).toBeVisible();
  // Off: the volume and cue controls are there but disabled.
  await expect(dialog.getByRole('slider')).toBeDisabled();
  expect((await probes(page)).audioContexts).toBe(0);

  await dialog.getByRole('switch', { name: 'Sound' }).click();
  await expect(dialog.getByRole('switch', { name: 'Sound' })).toHaveAttribute('aria-checked', 'true');
  const p = await probes(page);
  expect(p.audioContexts).toBe(1);
  expect(p.masterGain).toBeCloseTo(0.35, 2); // quiet by default
  expect(p.oscillators).toBeGreaterThan(0);   // the switch plays one soft tick so you know it works
  await expect(page.getByRole('button', { name: 'Sound on' })).toBeVisible();

  const slider = dialog.getByRole('slider');
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(dialog.getByText('25%')).toBeVisible();
  // A cue can be previewed.
  const before = (await probes(page)).oscillators;
  await dialog.getByRole('button', { name: 'Gavel' }).click();
  expect((await probes(page)).oscillators).toBeGreaterThan(before);

  // Mute: off again, and previews stop.
  await dialog.getByRole('switch', { name: 'Sound' }).click();
  await expect(page.getByRole('button', { name: 'Sound off' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Gavel' })).toHaveCount(0);

  // Escape closes the menu.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('sound turned on last time stays silent on a new page until the first click', async ({ page }) => {
  await page.goto(debateUrl);
  await page.evaluate(() => localStorage.setItem('debate.sound.v2', JSON.stringify({ enabled: true, volume: 0.35, scope: 'all' })));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sound on' })).toBeVisible();
  await page.waitForTimeout(1500);
  expect((await probes(page)).audioContexts).toBe(0);
  await page.locator('.feed').click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => (await probes(page)).audioContexts).toBe(1);
  await page.evaluate(() => localStorage.removeItem('debate.sound.v2'));
});

test('the report: stakes, how minds changed, dissent and sources', async ({ page }) => {
  await page.goto(debateUrl);
  await page.locator('.hud').getByRole('button', { name: 'Report', exact: true }).click();
  await expect(page).toHaveURL(/\/report$/);
  const frame = page.frameLocator('iframe[title="Debate report"]');
  for (const h of ['Key Recommendation', 'What Was at Stake', 'How Minds Changed', 'Dissenting Opinions', 'Sources']) {
    await expect(frame.getByRole('heading', { level: 2, name: h })).toBeAttached();
  }
  await expect(frame.locator('#stakes')).toContainText(/assumed|Decision owner|owner/i);
  await expect(frame.locator('#minds')).toContainText(/moved|held/i);
  await expect(frame.locator('#dissents')).toContainText(/Tripwire|tripwire/);
  await expect(frame.locator('#sources a[href^="http"]').first()).toBeAttached();
  await shot(page, 'report');
  await expect(page.getByRole('link', { name: 'Download' }).or(page.getByRole('button', { name: 'Download' }))).toBeVisible();
  await page.getByRole('button', { name: 'Back to the room' }).click();
  await expect(page).toHaveURL(/\/debate\/d_[\w-]+$/);
});
