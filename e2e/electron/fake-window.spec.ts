import { expect, test } from '@playwright/test';
import { openFakeHome, playerBar, waitForHydratedPlayer, VITE_DEV_ORIGIN } from '../fake-ui';
import { launchElectronFakeWindow } from './launch';

test.describe.configure({ mode: 'serial' });

test.describe('FE-06 Electron fake-mode', () => {
  let session: Awaited<ReturnType<typeof launchElectronFakeWindow>>;

  test.beforeAll(async () => {
    session = await launchElectronFakeWindow();
  });

  test.afterAll(async () => {
    try {
      await session?.app.close();
    } catch {
      // quit-clean already closed the host
    }
  });

  test('boots the main window on Vite fake-mode', async () => {
    const { page } = session;
    await openFakeHome(page, VITE_DEV_ORIGIN);
    await expect(page.getByRole('heading', { name: 'For you' })).toBeVisible();
    await expect(page.getByText('Offline fixtures')).toBeVisible();
    await expect(page).toHaveURL(/[?&]provider=fake/);
    expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:1420\//);
  });

  test('desktop recommendation cards stay compact and operable across window sizes', async () => {
    const { page, app } = session;
    await openFakeHome(page, VITE_DEV_ORIGIN);
    const window = await app.browserWindow(page);
    for (const [width, height] of [
      [1024, 768],
      [1366, 768],
      [1920, 1080],
    ]) {
      await window.evaluate((window, size) => window.setContentSize(size.width, size.height), {
        width,
        height,
      });
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      const cards = page.locator('.home-page .media-grid--hero > .media-card');
      await expect(cards).toHaveCount(3);
      for (const card of await cards.all()) {
        const geometry = await card.evaluate((element) => {
          const card = element.getBoundingClientRect();
          const cover = element.querySelector('.artwork')!.getBoundingClientRect();
          const meta = element.querySelector('.media-card__meta')!.getBoundingClientRect();
          const play = element.querySelector('.media-card__play')!.getBoundingClientRect();
          return {
            height: card.height,
            sameRow: cover.right <= meta.left,
            playInside:
              play.left >= card.left && play.right <= card.right && play.bottom <= card.bottom,
            playWidth: play.width,
            squareCover: Math.abs(cover.width - cover.height) < 1,
          };
        });
        expect(geometry.height).toBeLessThan(160);
        expect(geometry.sameRow).toBe(true);
        expect(geometry.squareCover).toBe(true);
        expect(geometry.playInside).toBe(true);
        expect(geometry.playWidth).toBeGreaterThanOrEqual(44);
        await expect(card.locator('.media-card__play')).toBeEnabled();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await expect(
        playerBar(page).getByRole('button', { name: 'Play', exact: true }),
      ).toBeInViewport();
      await page.screenshot({ path: `output/playwright/desktop-home-${width}x${height}.png` });
    }
    await window.evaluate((window) => window.setContentSize(1280, 800));
  });

  test('plays and pauses from the player bar', async () => {
    const { page } = session;
    await openFakeHome(page, VITE_DEV_ORIGIN);
    await waitForHydratedPlayer(page);
    const player = playerBar(page);
    await player.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(player.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await player.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(player.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  });

  test('opens settings and returns home', async () => {
    const { page } = session;
    await openFakeHome(page, VITE_DEV_ORIGIN);
    await page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name: 'Settings' })
      .click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page.getByRole('heading', { name: 'For you' })).toBeVisible();
  });

  test('Ctrl+K opens search', async () => {
    const { page } = session;
    await openFakeHome(page, VITE_DEV_ORIGIN);
    await page.keyboard.press('ControlOrMeta+K');
    await expect(page.getByRole('textbox', { name: 'Search music' })).toBeFocused();
  });

  test('quit-clean closes the Electron host', async () => {
    const version = await session.app.evaluate(() => process.versions.electron);
    expect(version?.startsWith('43.')).toBe(true);
    await session.app.close();
    await expect.poll(() => session.app.windows().length, { timeout: 15_000 }).toBe(0);
  });
});
