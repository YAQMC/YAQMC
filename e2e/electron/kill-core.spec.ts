import { expect, test } from '@playwright/test';
import { e2eCoreStatus, e2eKillCore, launchElectronFakeWindow, resolveE2eCoreBin } from './launch';

test.describe.configure({ mode: 'serial' });

const coreBin = resolveE2eCoreBin();

test.describe('SUP-04 kill-core', () => {
  test.skip(!coreBin, 'yaqmc-core binary not found (set YAQMC_CORE_BIN or build debug)');

  let session: Awaited<ReturnType<typeof launchElectronFakeWindow>>;

  test.beforeAll(async () => {
    session = await launchElectronFakeWindow({ spawnCore: true });
  });

  test.afterAll(async () => {
    try {
      await session?.app.close();
    } catch {
      // already closed
    }
  });

  test('restarts after the live core child is killed', async () => {
    const { app, page } = session;
    await expect.poll(() => e2eCoreStatus(app), { timeout: 60_000 }).toBe('ready');
    await expect(page.locator('.core-status-banner')).toHaveCount(0);

    expect(await e2eKillCore(app)).toBe(true);
    await expect.poll(() => e2eCoreStatus(app), { timeout: 15_000 }).toMatch(/^(down|restarting)$/);
    await expect(page.getByRole('status')).toBeVisible({ timeout: 15_000 });

    await expect.poll(() => e2eCoreStatus(app), { timeout: 60_000 }).toBe('ready');
    await expect(page.locator('.core-status-banner')).toHaveCount(0);
  });
});
