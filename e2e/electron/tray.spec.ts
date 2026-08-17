import { expect, test } from '@playwright/test';
import { launchElectronFakeWindow, e2eMainVisible, e2eTrayActive, e2eTrayClick } from './launch';

test.describe.configure({ mode: 'serial' });

test.describe('PLAT-01 tray click', () => {
  let session: Awaited<ReturnType<typeof launchElectronFakeWindow>>;

  test.beforeAll(async () => {
    session = await launchElectronFakeWindow({ tray: true });
  });

  test.afterAll(async () => {
    try {
      await session?.app.close();
    } catch {
      // already closed
    }
  });

  test('programmatic show-hide toggles the main window', async () => {
    const { app } = session;
    await expect.poll(() => e2eTrayActive(app)).toBe(true);
    await expect.poll(() => e2eMainVisible(app)).toBe(true);

    expect(await e2eTrayClick(app, 'show-hide')).toBe(true);
    await expect.poll(() => e2eMainVisible(app)).toBe(false);

    expect(await e2eTrayClick(app, 'show-hide')).toBe(true);
    await expect.poll(() => e2eMainVisible(app)).toBe(true);
  });
});
