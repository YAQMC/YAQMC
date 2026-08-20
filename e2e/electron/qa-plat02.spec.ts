import { expect, test, type Page } from '@playwright/test';
import { e2eCoreStatus, launchElectronNativeWindow, resolveE2eCoreBin } from './launch';

test.describe.configure({ mode: 'serial' });

const coreBin = resolveE2eCoreBin();

type DesktopIntegrationStatus = {
  globalShortcutsSupported: boolean;
  globalShortcutsEnabled: boolean;
  globalShortcuts: string[];
  shortcutError: string | null;
};

type PreferencesDocument = {
  system?: Record<string, unknown>;
  [key: string]: unknown;
};

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

async function readPreferences(page: Page): Promise<PreferencesDocument> {
  const raw = await rendererInvoke<string | null>(page, 'app_preferences_get');
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as PreferencesDocument;
}

async function writeShortcutsPreference(page: Page, enabled: boolean): Promise<void> {
  const parsed = await readPreferences(page);
  await rendererInvoke(page, 'app_preferences_set', {
    value: JSON.stringify({
      ...parsed,
      system: { ...parsed.system, globalShortcutsEnabled: enabled },
    }),
  });
}

test.describe('PLAT-02 global shortcuts production path', () => {
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

  test('host handler is implemented; Windows can enable or surfaces a real register() conflict', async () => {
    const { app, page } = session;
    await expect(page.locator('.app-shell')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => e2eCoreStatus(app), { timeout: 60_000 }).toBe('ready');
    await expect
      .poll(async () => (await rendererInvoke<string | null>(page, 'app_preferences_get')) !== null)
      .toBe(true);

    const apiWorks = await app.evaluate(({ globalShortcut }) => {
      const ok = globalShortcut.register('Control+Alt+F24', () => undefined);
      if (ok) {
        globalShortcut.unregister('Control+Alt+F24');
      }
      return ok;
    });
    expect(apiWorks).toBe(true);

    const before = await rendererInvoke<DesktopIntegrationStatus>(
      page,
      'system_integration_status',
    );
    expect(before.globalShortcuts).toEqual([
      'control+alt+Space',
      'control+alt+ArrowLeft',
      'control+alt+ArrowRight',
    ]);

    if (!before.globalShortcutsSupported) {
      expect(process.platform).not.toBe('win32');
      await expect(
        rendererInvoke(page, 'system_shortcuts_set_enabled', { enabled: true }),
      ).rejects.toThrow(/Wayland|shortcut/i);
      const after = await rendererInvoke<DesktopIntegrationStatus>(
        page,
        'system_integration_status',
      );
      expect(after.globalShortcutsEnabled).toBe(false);
      expect(after.globalShortcutsSupported).toBe(false);
      return;
    }

    if (process.platform === 'win32') {
      expect(before.globalShortcutsSupported).toBe(true);
    }

    let registered = false;
    try {
      const enabled = await rendererInvoke<DesktopIntegrationStatus>(
        page,
        'system_shortcuts_set_enabled',
        { enabled: true },
      );
      expect(enabled.globalShortcutsEnabled).toBe(true);
      registered = true;
    } catch (error) {
      const message = String(error);
      expect(message).not.toMatch(/implemented by the host/);
      expect(message).toMatch(/shortcut conflict for control\+alt\+(Space|ArrowLeft|ArrowRight)/);
      const after = await rendererInvoke<DesktopIntegrationStatus>(
        page,
        'system_integration_status',
      );
      expect(after.globalShortcutsEnabled).toBe(false);
      expect(after.shortcutError).toMatch(/shortcut conflict/);
    }

    await openSettings(page);
    const toggle = page.getByRole('switch', { name: 'Global shortcuts' });
    await toggle.scrollIntoViewIfNeeded();

    if (!registered) {
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(page.locator('.settings-error')).toHaveAttribute(
        'title',
        /shortcut conflict for control\+alt\+(Space|ArrowLeft|ArrowRight)/,
      );
      await expect(page.locator('.app-shell')).toBeVisible();
      return;
    }

    if ((await toggle.getAttribute('aria-checked')) !== 'true') {
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await writeShortcutsPreference(page, true);
    await expect
      .poll(async () => (await readPreferences(page)).system?.globalShortcutsEnabled === true)
      .toBe(true);

    await session.app.close();
    session = await launchElectronNativeWindow({ spawnCore: true });
    await expect(session.page.locator('.app-shell')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => e2eCoreStatus(session.app), { timeout: 60_000 }).toBe('ready');
    await expect
      .poll(
        async () => (await readPreferences(session.page)).system?.globalShortcutsEnabled === true,
      )
      .toBe(true);
    await expect
      .poll(async () => {
        const status = await rendererInvoke<DesktopIntegrationStatus>(
          session.page,
          'system_integration_status',
        );
        return status.globalShortcutsEnabled;
      })
      .toBe(true);

    await openSettings(session.page);
    await expect(session.page.getByRole('switch', { name: 'Global shortcuts' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await rendererInvoke(session.page, 'system_shortcuts_set_enabled', { enabled: false });
    await writeShortcutsPreference(session.page, false);
  });
});
