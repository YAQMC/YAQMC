import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { e2eCoreStatus, launchElectronNativeWindow, resolveE2eCoreBin } from './launch';

test.describe.configure({ mode: 'serial' });

const coreBin = resolveE2eCoreBin();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sakuraZip = path.join(
  repoRoot,
  'examples',
  'plugins',
  'packages',
  'dev.yaqmc.example.sakura-1.0.0.yaqmc-plugin',
);
const shots = path.join(repoRoot, 'output', 'playwright');

async function invoke<T>(page: Page, method: string, params?: unknown): Promise<T> {
  return page.evaluate(
    async ({ method, params }) => {
      const yaqmc = Reflect.get(globalThis, 'yaqmc') as {
        invoke(method: string, params?: unknown): Promise<unknown>;
      };
      return yaqmc.invoke(method, params) as Promise<T>;
    },
    { method, params },
  );
}

async function setColorMode(page: Page, colorMode: 'light' | 'dark'): Promise<void> {
  await page.evaluate(async (mode) => {
    const preferencesPath = '/src/application/preferences.ts';
    const { usePreferencesStore } = await import(/* @vite-ignore */ preferencesPath);
    usePreferencesStore.getState().updateAppearance({ colorMode: mode });
  }, colorMode);
}

test.describe('Plugins page on native renderer + production Core', () => {
  test.skip(!coreBin, 'yaqmc-core binary not found (set YAQMC_CORE_BIN or build debug)');
  test.setTimeout(180_000);

  let session: Awaited<ReturnType<typeof launchElectronNativeWindow>>;

  test.beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    session = await launchElectronNativeWindow({ spawnCore: true });
    await expect(session.page.locator('.app-shell')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => e2eCoreStatus(session.app), { timeout: 60_000 }).toBe('ready');
  });

  test.afterAll(async () => {
    try {
      await invoke(session.page, 'plugin_uninstall', {
        request: { id: 'dev.yaqmc.example.sakura', removeData: true },
      });
    } catch {
      // not installed
    }
    await session?.app.close().catch(() => undefined);
  });

  test('sidebar entry, management tab, and no manager left in Settings', async () => {
    const { page } = session;
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText('Installed plugins')).toHaveCount(0);

    await page.getByRole('button', { name: 'Plugins', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Plugins', level: 1 })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Plugin Management' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    expect(existsSync(sakuraZip)).toBe(true);
    await invoke(page, 'plugin_install_from', {
      request: { path: sakuraZip, enable: false, grant: [] },
    });
    await page.getByRole('button', { name: 'Refresh' }).click();
    const card = page.locator('.plugin-card', { hasText: 'Sakura' });
    await expect(card).toBeVisible();
    await expect(card.getByText('Disabled')).toBeVisible();
    await card.getByRole('button', { name: 'Details', exact: true }).click();
    const details = page.getByRole('dialog');
    await expect(details.getByText('dev.yaqmc.example.sakura')).toBeVisible();
    await page.screenshot({ path: path.join(shots, 'plugin-center-details-dark.png') });
    await page.keyboard.press('Escape');
    await expect(details).toHaveCount(0);

    for (const mode of ['dark', 'light'] as const) {
      await setColorMode(page, mode);
      await page.screenshot({ path: path.join(shots, `plugin-center-manage-${mode}.png`) });
    }
    // Back returns from the store tab to management through the shared history.
    await page.getByRole('tab', { name: 'Plugin Store' }).click();
    await expect(page.getByRole('tab', { name: 'Plugin Store' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.goBack().catch(() => undefined);
  });

  test('store queries the live yaqmc-plugin topic or reports why it cannot', async () => {
    const { page } = session;
    await page.getByRole('button', { name: 'Plugins', exact: true }).click();
    await page.getByRole('tab', { name: 'Plugin Store' }).click();
    const store = page.locator('#plugins-panel-store');
    const card = store.locator('.plugin-card', { hasText: 'yaqmc-music-providers' });
    const alert = store.getByRole('alert');
    // External service: success and a reported failure are both valid, an empty view is not.
    await expect(card.or(alert)).toBeVisible({ timeout: 60_000 });
    if (await card.isVisible()) {
      await expect(card.getByText('YAQMC organization')).toBeVisible();
      await card.getByRole('button', { name: /install|details/i }).click();
      const dialog = page.getByRole('dialog', { name: 'YAQMC/yaqmc-music-providers' });
      await expect(dialog).toBeVisible();
      await expect(
        dialog
          .getByText(/no published releases/i)
          .or(dialog.getByRole('radio'))
          .first(),
      ).toBeVisible({ timeout: 60_000 });
      for (const mode of ['light', 'dark'] as const) {
        await setColorMode(page, mode);
        await page.screenshot({ path: path.join(shots, `plugin-store-details-${mode}.png`) });
      }
      await page.keyboard.press('Escape');
    }
    await page.screenshot({ path: path.join(shots, 'plugin-store-dark.png') });
    await page.setViewportSize({ width: 1000, height: 720 }).catch(() => undefined);
  });
});
