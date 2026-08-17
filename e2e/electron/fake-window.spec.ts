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
