/// <reference lib="dom" />
import { expect, test } from '@playwright/test';
import { launchElectronFakeWindow } from './launch';
import { VITE_DEV_ORIGIN } from '../fake-ui';

test('the native main window resizes freely and keeps its title-bar controls inside', async () => {
  const { app, page } = await launchElectronFakeWindow();
  try {
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getMinimumSize()),
    ).toEqual([0, 0]);
    // Use the actual preload bridge for window controls, without starting Core or logging in.
    await page.goto(VITE_DEV_ORIGIN);
    await expect(page.locator('.app-shell')).toHaveAttribute('data-host-kind', 'electron');
    for (const size of [
      { width: 320, height: 240 },
      { width: 400, height: 700 },
      { width: 599, height: 400 },
      { width: 768, height: 1024 },
      { width: 1280, height: 300 },
      { width: 1280, height: 800 },
    ]) {
      await app.evaluate(({ BrowserWindow }, next) => {
        BrowserWindow.getAllWindows()[0]!.setContentSize(next.width, next.height);
      }, size);
      await expect
        .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
        .toEqual(size);
      const controls = page.locator('.topbar__window-controls button');
      if ((await controls.count()) === 0) continue; // macOS uses native traffic lights.
      for (const control of await controls.all()) {
        await expect(control).toBeVisible();
        await expect
          .poll(async () => {
            const box = (await control.boundingBox())!;
            return box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1;
          })
          .toBe(true);
      }
    }
  } finally {
    await app.close();
  }
});
