import { existsSync, mkdtempSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { e2eCoreStatus, launchElectronNativeWindow, resolveE2eCoreBin } from './launch';

test.describe.configure({ mode: 'serial' });

test.describe('FE-04 native host', () => {
  let session: Awaited<ReturnType<typeof launchElectronNativeWindow>>;

  test.beforeAll(async () => {
    session = await launchElectronNativeWindow();
  });

  test.afterAll(async () => {
    try {
      await session?.app.close();
    } catch {
      // already closed
    }
  });

  test('exposes window.yaqmc on the main renderer without fake provider', async () => {
    const { page } = session;
    await expect(page.locator('.app-shell')).toBeVisible({ timeout: 60_000 });
    expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:1420\//);
    expect(page.url()).not.toMatch(/[?&]provider=fake/);
    await expect(page.locator('.app-shell')).not.toHaveAttribute('data-provider-id', 'fake');

    const info = await page.evaluate(() => {
      const yaqmc = Reflect.get(globalThis, 'yaqmc');
      return {
        hasInvoke: Boolean(
          yaqmc && typeof yaqmc === 'object' && typeof Reflect.get(yaqmc, 'invoke') === 'function',
        ),
        hasOn: Boolean(
          yaqmc && typeof yaqmc === 'object' && typeof Reflect.get(yaqmc, 'on') === 'function',
        ),
        windowRole: yaqmc && typeof yaqmc === 'object' ? Reflect.get(yaqmc, 'windowRole') : null,
      };
    });
    expect(info).toEqual({ hasInvoke: true, hasOn: true, windowRole: 'main' });
  });

  test('window.minimize via preload invoke minimizes the BrowserWindow', async () => {
    const { app, page } = session;
    await expect(page.locator('.app-shell')).toBeVisible({ timeout: 60_000 });
    await page.evaluate(() => {
      const yaqmc = Reflect.get(globalThis, 'yaqmc');
      const invoke = yaqmc && typeof yaqmc === 'object' ? Reflect.get(yaqmc, 'invoke') : undefined;
      if (typeof invoke !== 'function') {
        throw new Error('window.yaqmc.invoke is missing');
      }
      return invoke('window.minimize');
    });
    await expect
      .poll(
        () =>
          app.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0];
            return window?.isMinimized() ?? false;
          }),
        { timeout: 10_000 },
      )
      .toBe(true);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.restore();
    });
  });

  test('diagnostics_open_log_folder is a host method and returns an existing directory', async () => {
    const { page } = session;
    const logDir = await page.evaluate(() => {
      const yaqmc = Reflect.get(globalThis, 'yaqmc');
      const invoke = yaqmc && typeof yaqmc === 'object' ? Reflect.get(yaqmc, 'invoke') : undefined;
      if (typeof invoke !== 'function') {
        throw new Error('window.yaqmc.invoke is missing');
      }
      return invoke('diagnostics_open_log_folder');
    });
    expect(typeof logDir).toBe('string');
    expect(logDir).toMatch(/logs$/i);
    expect(existsSync(String(logDir))).toBe(true);
  });

  test('host.coreStatus is registered on the main window', async () => {
    const { page } = session;
    const status = await page.evaluate(() => {
      const yaqmc = Reflect.get(globalThis, 'yaqmc');
      const invoke = yaqmc && typeof yaqmc === 'object' ? Reflect.get(yaqmc, 'invoke') : undefined;
      if (typeof invoke !== 'function') {
        throw new Error('window.yaqmc.invoke is missing');
      }
      return invoke('host.coreStatus');
    });
    expect(status).toEqual({
      status: expect.stringMatching(/^(down|restarting|ready|safe-mode)$/),
    });
  });
});

test.describe('FE-04 native host with Core', () => {
  const coreBin = resolveE2eCoreBin();
  test.skip(!coreBin, 'yaqmc-core binary not found (set YAQMC_CORE_BIN or build debug)');

  let session: Awaited<ReturnType<typeof launchElectronNativeWindow>>;

  test.beforeAll(async () => {
    session = await launchElectronNativeWindow({ spawnCore: true });
  });

  test.afterAll(async () => {
    try {
      await session?.app.close();
    } catch {
      // already closed
    }
  });

  test('core reaches ready and player_snapshot works through preload invoke', async () => {
    const { app, page } = session;
    await expect(page.locator('.app-shell')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => e2eCoreStatus(app), { timeout: 60_000 }).toBe('ready');

    const status = await page.evaluate(() => {
      const yaqmc = Reflect.get(globalThis, 'yaqmc');
      const invoke = yaqmc && typeof yaqmc === 'object' ? Reflect.get(yaqmc, 'invoke') : undefined;
      if (typeof invoke !== 'function') {
        throw new Error('window.yaqmc.invoke is missing');
      }
      return invoke('host.coreStatus');
    });
    expect(status).toEqual({ status: 'ready' });

    const snapshot = await page.evaluate(() => {
      const yaqmc = Reflect.get(globalThis, 'yaqmc');
      const invoke = yaqmc && typeof yaqmc === 'object' ? Reflect.get(yaqmc, 'invoke') : undefined;
      if (typeof invoke !== 'function') {
        throw new Error('window.yaqmc.invoke is missing');
      }
      return invoke('player_snapshot');
    });
    expect(snapshot).toMatchObject({ queue: expect.any(Array) });
  });

  test('diagnostics_export_bundle_to writes a ZIP at the exact selected path', async () => {
    const { app, page } = session;
    await expect.poll(() => e2eCoreStatus(app), { timeout: 60_000 }).toBe('ready');
    const dest = path.join(
      mkdtempSync(path.join(os.tmpdir(), 'yaqmc-diag-')),
      'YAQMC-diagnostics.zip',
    );
    const result = (await page.evaluate((filePath) => {
      const yaqmc = Reflect.get(globalThis, 'yaqmc');
      const invoke = yaqmc && typeof yaqmc === 'object' ? Reflect.get(yaqmc, 'invoke') : undefined;
      if (typeof invoke !== 'function') {
        throw new Error('window.yaqmc.invoke is missing');
      }
      return invoke('diagnostics_export_bundle_to', {
        path: filePath,
        request: { includeLogs: true, overrideUnresolved: true },
      });
    }, dest)) as { path?: string; bytes?: number };
    expect(result.path).toBe(dest);
    expect(result.bytes).toBeGreaterThan(0);
    expect(existsSync(dest)).toBe(true);
    unlinkSync(dest);
  });
});
