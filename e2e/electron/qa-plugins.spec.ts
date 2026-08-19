import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { e2eCoreStatus, launchElectronNativeWindow, resolveE2eCoreBin } from './launch';

test.describe.configure({ mode: 'serial' });

const coreBin = resolveE2eCoreBin();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const examples = path.join(repoRoot, 'examples', 'plugins');
const sakuraId = 'dev.yaqmc.example.sakura';
const networkId = 'dev.yaqmc.example.network';
const scenesId = 'dev.yaqmc.example.scenes';
const hostileId = 'dev.yaqmc.test.hostile';
const sakuraZip = path.join(examples, 'packages', `${sakuraId}-1.0.0.yaqmc-plugin`);

type PluginRecord = {
  id?: string;
  enabled?: boolean;
  status?: string;
  grantedPermissions?: string[];
};

type PluginResources = {
  safeMode?: boolean;
  developerMode?: boolean;
  styles?: unknown[];
  scenes?: Array<{ sceneId?: string; pluginId?: string }>;
  scripts?: unknown[];
};

async function rendererInvoke<T>(page: Page, method: string, params?: unknown): Promise<T> {
  return page.evaluate(
    async ({ methodName, payload }) => {
      const yaqmc = Reflect.get(globalThis, 'yaqmc');
      const invoke =
        yaqmc && typeof yaqmc === 'object' ? Reflect.get(yaqmc, 'invoke') : undefined;
      if (typeof invoke !== 'function') {
        throw new Error('window.yaqmc.invoke is missing');
      }
      return invoke(methodName, payload) as Promise<T>;
    },
    { methodName: method, payload: params },
  );
}

async function rendererInvokeError(
  page: Page,
  method: string,
  params?: unknown,
): Promise<string> {
  return page.evaluate(
    async ({ methodName, payload }) => {
      const yaqmc = Reflect.get(globalThis, 'yaqmc');
      const invoke =
        yaqmc && typeof yaqmc === 'object' ? Reflect.get(yaqmc, 'invoke') : undefined;
      if (typeof invoke !== 'function') {
        throw new Error('window.yaqmc.invoke is missing');
      }
      try {
        await invoke(methodName, payload);
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    { methodName: method, payload: params },
  );
}

async function listPlugins(page: Page): Promise<PluginRecord[]> {
  const list = await rendererInvoke<PluginRecord[]>(page, 'plugin_list');
  return Array.isArray(list) ? list : [];
}

async function uninstallAll(page: Page): Promise<void> {
  for (const record of await listPlugins(page)) {
    if (!record.id) {
      continue;
    }
    await rendererInvoke(page, 'plugin_uninstall', {
      request: { id: record.id, removeData: true },
    });
  }
  await rendererInvoke(page, 'plugin_set_safe_mode', { enabled: false });
  await rendererInvoke(page, 'plugin_set_developer_mode', { enabled: false });
}

function assertNoHostile(records: PluginRecord[]): void {
  expect(records.some((record) => record.id === hostileId)).toBe(false);
}

test.describe('PLUG example plugins on native renderer + production Core', () => {
  test.skip(!coreBin, 'yaqmc-core binary not found (set YAQMC_CORE_BIN or build debug)');
  test.setTimeout(180_000);

  let session: Awaited<ReturnType<typeof launchElectronNativeWindow>>;

  test.beforeAll(async () => {
    execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'pack-example-plugins.mjs')], {
      cwd: repoRoot,
      windowsHide: true,
    });
    expect(existsSync(sakuraZip)).toBe(true);
    session = await launchElectronNativeWindow({ spawnCore: true });
    await expect(session.page.locator('.app-shell')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => e2eCoreStatus(session.app), { timeout: 60_000 }).toBe('ready');
    await uninstallAll(session.page);
  });

  test.afterAll(async () => {
    try {
      if (session?.page) {
        await uninstallAll(session.page);
      }
    } catch {
      // Core already gone
    }
    try {
      await session?.app.close();
    } catch {
      // already closed
    }
  });

  test('install from file, enable/disable, reject update while enabled, uninstall', async () => {
    const { page } = session;
    expect(page.url()).not.toMatch(/[?&]provider=fake/);

    const installed = await rendererInvoke<PluginRecord>(page, 'plugin_install_from', {
      request: { path: sakuraZip, enable: true, grant: [] },
    });
    expect(installed.id).toBe(sakuraId);
    expect(installed.enabled).toBe(true);
    assertNoHostile(await listPlugins(page));

    const disabled = await rendererInvoke<PluginRecord>(page, 'plugin_set_enabled', {
      request: { id: sakuraId, enabled: false, grant: [] },
    });
    expect(disabled.enabled).toBe(false);

    const enabled = await rendererInvoke<PluginRecord>(page, 'plugin_set_enabled', {
      request: { id: sakuraId, enabled: true, grant: [] },
    });
    expect(enabled.enabled).toBe(true);

    const updateWhileEnabled = await rendererInvokeError(page, 'plugin_install_from', {
      request: { path: sakuraZip, enable: true, grant: [] },
    });
    expect(updateWhileEnabled).toMatch(/disable the current version before installing an update/i);

    await rendererInvoke(page, 'plugin_set_enabled', {
      request: { id: sakuraId, enabled: false, grant: [] },
    });
    const updated = await rendererInvoke<PluginRecord>(page, 'plugin_install_from', {
      request: { path: sakuraZip, enable: false, grant: [] },
    });
    expect(updated.id).toBe(sakuraId);
    expect(updated.enabled).toBe(false);

    const reenabled = await rendererInvoke<PluginRecord>(page, 'plugin_set_enabled', {
      request: { id: sakuraId, enabled: true, grant: [] },
    });
    expect(reenabled.enabled).toBe(true);

    await rendererInvoke(page, 'plugin_uninstall', {
      request: { id: sakuraId, removeData: true },
    });
    expect((await listPlugins(page)).some((record) => record.id === sakuraId)).toBe(false);
    assertNoHostile(await listPlugins(page));
  });

  test('permission deny vs grant and denied network origin stays denied', async () => {
    const { page } = session;
    await rendererInvoke(page, 'plugin_set_developer_mode', { enabled: true });
    const parked = await rendererInvoke<PluginRecord>(page, 'plugin_install_unpacked', {
      request: {
        path: path.join(examples, 'script-network'),
        enable: false,
        grant: [],
      },
    });
    expect(parked.id).toBe(networkId);
    expect(parked.enabled).toBe(false);

    const deniedEnable = await rendererInvokeError(page, 'plugin_set_enabled', {
      request: { id: networkId, enabled: true, grant: [] },
    });
    expect(deniedEnable).toMatch(/explicitly accepted/i);
    expect((await listPlugins(page)).find((record) => record.id === networkId)?.enabled).toBe(
      false,
    );

    const granted = await rendererInvoke<PluginRecord>(page, 'plugin_set_enabled', {
      request: { id: networkId, enabled: true, grant: ['network:https://example.com'] },
    });
    expect(granted.enabled).toBe(true);
    expect(granted.grantedPermissions).toEqual(
      expect.arrayContaining(['network:https://example.com']),
    );

    const token = await rendererInvoke<string>(page, 'plugin_runtime_start', {
      pluginId: networkId,
    });
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(4);

    const deniedOrigin = await rendererInvokeError(page, 'plugin_bridge', {
      request: {
        token,
        method: 'network.request',
        payload: { method: 'GET', url: 'https://evil.example/' },
      },
    });
    expect(deniedOrigin).toMatch(/origin is not granted/i);

    await rendererInvoke(page, 'plugin_runtime_stop', { token });
    await rendererInvoke(page, 'plugin_uninstall', {
      request: { id: networkId, removeData: true },
    });
    assertNoHostile(await listPlugins(page));
  });

  test('lyrics scene pack registers scenes for the picker', async () => {
    const { page } = session;
    await rendererInvoke(page, 'plugin_set_developer_mode', { enabled: true });
    const installed = await rendererInvoke<PluginRecord>(page, 'plugin_install_unpacked', {
      request: {
        path: path.join(examples, 'scene-pack'),
        enable: true,
        grant: [],
      },
    });
    expect(installed.id).toBe(scenesId);
    const resources = await rendererInvoke<PluginResources>(page, 'plugin_active_resources');
    expect(resources.safeMode).toBe(false);
    expect((resources.scenes ?? []).length).toBeGreaterThanOrEqual(2);
    expect((resources.scenes ?? []).map((scene) => scene.sceneId)).toEqual(
      expect.arrayContaining(['aurora', 'vinyl-glow']),
    );
    await rendererInvoke(page, 'plugin_uninstall', {
      request: { id: scenesId, removeData: true },
    });
  });

  test('mark-failed crash-loop journal enters safe mode without killing the host', async () => {
    const { page } = session;
    await rendererInvoke(page, 'plugin_set_developer_mode', { enabled: true });
    await rendererInvoke(page, 'plugin_install_unpacked', {
      request: {
        path: path.join(examples, 'style-sakura'),
        enable: true,
        grant: [],
      },
    });
    for (let index = 0; index < 3; index += 1) {
      const failed = await rendererInvoke<PluginRecord>(page, 'plugin_mark_failed', {
        id: sakuraId,
        reason: `qa simulated worker crash ${String(index)}`,
      });
      expect(failed.status).toBe('failed');
      expect(failed.enabled).toBe(false);
    }
    const safe = await rendererInvoke<boolean>(page, 'plugin_set_safe_mode', { enabled: true });
    expect(safe).toBe(true);
    const resources = await rendererInvoke<PluginResources>(page, 'plugin_active_resources');
    expect(resources.safeMode).toBe(true);
    expect(resources.styles ?? []).toEqual([]);
    expect(resources.scripts ?? []).toEqual([]);
    await expect(page.locator('.app-shell')).toBeVisible();

    const enableDenied = await rendererInvokeError(page, 'plugin_set_enabled', {
      request: { id: sakuraId, enabled: true, grant: [] },
    });
    expect(enableDenied).toMatch(/safe mode/i);

    await rendererInvoke(page, 'plugin_set_safe_mode', { enabled: false });
    await rendererInvoke(page, 'plugin_uninstall', {
      request: { id: sakuraId, removeData: true },
    });
    assertNoHostile(await listPlugins(page));
  });

  test('enabled example plugin survives Electron + Core restart', async () => {
    const { page } = session;
    const installed = await rendererInvoke<PluginRecord>(page, 'plugin_install_from', {
      request: { path: sakuraZip, enable: true, grant: [] },
    });
    expect(installed.enabled).toBe(true);

    await session.app.close();
    session = await launchElectronNativeWindow({ spawnCore: true });
    await expect(session.page.locator('.app-shell')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => e2eCoreStatus(session.app), { timeout: 60_000 }).toBe('ready');

    const resources = await rendererInvoke<PluginResources>(
      session.page,
      'plugin_active_resources',
    );
    expect(resources.safeMode).toBe(false);
    const restored = (await listPlugins(session.page)).find((record) => record.id === sakuraId);
    expect(restored?.status).not.toBe('failed');
    expect(restored?.enabled).toBe(true);
    assertNoHostile(await listPlugins(session.page));
    await rendererInvoke(session.page, 'plugin_uninstall', {
      request: { id: sakuraId, removeData: true },
    });
  });
});
