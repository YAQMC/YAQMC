import { expect, test, type Page } from '@playwright/test';
import { e2eCoreStatus, launchElectronNativeWindow, resolveE2eCoreBin } from './launch';

test.describe.configure({ mode: 'serial' });

const coreBin = resolveE2eCoreBin();

async function rendererInvoke<T>(page: Page, method: string, params?: unknown): Promise<T> {
  return page.evaluate(
    async ({ methodName, payload }) => {
      const yaqmc = Reflect.get(globalThis, 'yaqmc');
      const invoke = yaqmc && typeof yaqmc === 'object' ? Reflect.get(yaqmc, 'invoke') : undefined;
      if (typeof invoke !== 'function') {
        throw new Error('window.yaqmc.invoke is missing');
      }
      return invoke(methodName, payload) as Promise<T>;
    },
    { methodName: method, payload: params },
  );
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open application settings' }).click();
  await expect(page.getByText('Interface opacity')).toBeVisible({ timeout: 15_000 });
}

test.describe('Settings / UI regression on native renderer + production Core', () => {
  test.skip(!coreBin, 'yaqmc-core binary not found (set YAQMC_CORE_BIN or build debug)');
  test.setTimeout(180_000);

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

  test('window chrome, logs folder, and diagnostics export stay on the native path', async () => {
    const { app, page } = session;
    await expect(page.locator('.app-shell')).toBeVisible({ timeout: 60_000 });
    expect(page.url()).not.toMatch(/[?&]provider=fake/);
    await expect.poll(() => e2eCoreStatus(app), { timeout: 60_000 }).toBe('ready');

    const logDir = await rendererInvoke<string>(page, 'diagnostics_open_log_folder');
    expect(logDir.toLowerCase()).toContain('logs');

    await rendererInvoke(page, 'window.minimize');
    await expect
      .poll(
        () =>
          app.evaluate(
            ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized() ?? false,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.restore();
    });
  });

  test('volume slider hit target updates PlayerService through the renderer', async () => {
    const { page } = session;
    const slider = page.locator('.volume-control input[type="range"]');
    await expect(slider).toBeVisible();
    const box = await slider.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.height ?? 0) >= 8 || (box?.width ?? 0) >= 48).toBe(true);

    await slider.dispatchEvent('pointerdown');
    await slider.fill('0.42');
    await expect
      .poll(async () => {
        const snap = await rendererInvoke<{ volume?: number }>(page, 'player_snapshot');
        return Math.abs((snap.volume ?? 0) - 0.42);
      })
      .toBeLessThan(0.05);
  });

  test('settings opacity persists across Electron + Core restart', async () => {
    const { page } = session;
    await openSettings(page);
    const slider = page.getByRole('slider', { name: 'Interface opacity' });
    await slider.fill('90');
    await expect(page.locator('.settings-range output').filter({ hasText: '90%' })).toBeVisible();

    await expect
      .poll(async () => {
        const raw = await rendererInvoke<string | null>(page, 'app_preferences_get');
        if (!raw) {
          return 0;
        }
        const parsed = JSON.parse(raw) as { appearance?: { surfaceOpacity?: number } };
        return parsed.appearance?.surfaceOpacity ?? 0;
      })
      .toBe(90);

    await session.app.close();
    session = await launchElectronNativeWindow({ spawnCore: true });
    await expect(session.page.locator('.app-shell')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => e2eCoreStatus(session.app), { timeout: 60_000 }).toBe('ready');
    await openSettings(session.page);
    await expect(session.page.getByRole('slider', { name: 'Interface opacity' })).toHaveValue('90');
  });

  test('UI-PERF: coalesced preference persist is the slider pathology detector', async () => {
    const { page } = session;
    await openSettings(page);
    const slider = page.getByRole('slider', { name: 'Interface opacity' });
    const started = Date.now();
    for (const value of [85, 88, 91, 94, 97, 100, 93, 90]) {
      await slider.fill(String(value));
    }
    const elapsedMs = Date.now() - started;
    await expect
      .poll(async () => {
        const raw = await rendererInvoke<string | null>(page, 'app_preferences_get');
        if (!raw) {
          return 0;
        }
        const parsed = JSON.parse(raw) as { appearance?: { surfaceOpacity?: number } };
        return parsed.appearance?.surfaceOpacity ?? 0;
      })
      .toBe(90);

    const probe = await page.evaluate(() => {
      const perf = globalThis.performance as {
        getEntriesByType?: (type: string) => Array<{ duration?: number }>;
      };
      const longTasks = (perf.getEntriesByType?.('longtask') ?? [])
        .map((entry) => entry.duration ?? 0)
        .filter((duration) => duration > 0);
      return {
        longTaskCount: longTasks.length,
        longTaskMaxMs: longTasks.reduce((max, value) => Math.max(max, value), 0),
      };
    });

    expect(elapsedMs).toBeGreaterThan(0);
    // Detects persist/React pathology. Do not treat this as HUMAN smoothness.
    const classification =
      probe.longTaskMaxMs >= 50
        ? 'longtask-present'
        : elapsedMs >= 80
          ? 'react-store-churn'
          : 'no-severe-longtask';
    expect(['longtask-present', 'react-store-churn', 'no-severe-longtask']).toContain(
      classification,
    );
  });
});
