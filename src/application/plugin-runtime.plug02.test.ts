import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyPluginResources,
  pluginHostSafeMode,
  pluginWorkerBootstrap,
  setPluginSafeMode,
  type PluginRecord,
} from './plugin-runtime';

const invokeMock = vi.hoisted(() => vi.fn());
const hostKind = vi.hoisted(() => ({ value: 'electron' as 'electron' | 'fake' }));

vi.mock('./yaqmc-runtime', () => ({
  getHostBridge: () => ({
    get kind() {
      return hostKind.value;
    },
  }),
  getYaqmcClient: () => ({
    invoke: invokeMock,
    on: vi.fn(() => () => undefined),
    bridge: {
      get kind() {
        return hostKind.value;
      },
    },
  }),
}));

vi.mock('./native-player-runtime', () => ({
  isNativeRuntime: true,
}));

const HOSTILE_ID = 'dev.yaqmc.test.hostile';
const CRASH_LOOP_FAILURES = 3;

function emptyResources(safeMode = false) {
  return {
    safeMode,
    developerMode: false,
    styleOrder: [] as string[],
    styles: [] as unknown[],
    scenes: [] as unknown[],
    scripts: [] as unknown[],
  };
}

function pluginRecord(id: string, extra: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id,
    name: id,
    version: '1.0.0',
    authors: [],
    enabled: false,
    status: 'installed',
    apiVersion: 1,
    packageSha256: 'abc',
    source: 'local-file',
    unsigned: true,
    entrypoints: { styles: 1, scenes: 0, script: false },
    permissions: ['style.register'],
    grantedPermissions: [],
    riskRating: 'none',
    styleScan: { severity: null, findings: [] },
    scriptScan: { severity: null, findings: [] },
    compatible: true,
    platforms: [],
    ...extra,
  };
}

describe('PLUG-02 proxy deny and safe-mode crash drill', () => {
  afterEach(() => {
    hostKind.value = 'electron';
    invokeMock.mockReset();
  });

  it('keeps raw fetch denied and proxies only through network.request', () => {
    const source = pluginWorkerBootstrap(
      'definePlugin({ activate() { return function () {}; } });',
      'dev.yaqmc.example.network',
    );
    expect(source).toContain('network denied');
    expect(source).toContain('network.request');
    expect(source).not.toContain(HOSTILE_ID);
  });

  it('setPluginSafeMode disables scripts and styles from active resources', async () => {
    invokeMock.mockImplementation(async (method: string) => {
      if (method === 'plugin_set_safe_mode') return true;
      if (method === 'plugin_active_resources') {
        return {
          ...emptyResources(true),
          styles: [{ pluginId: 'dev.yaqmc.example.sakura', css: 'body{}' }],
          scripts: [
            {
              pluginId: 'dev.yaqmc.example.network',
              pluginName: 'Scoped network',
              source: 'definePlugin({ activate() { return function () {}; } });',
            },
          ],
        };
      }
      throw new Error(method);
    });

    await expect(setPluginSafeMode(true)).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('plugin_set_safe_mode', { enabled: true });
    expect(invokeMock).toHaveBeenCalledWith('plugin_active_resources');
    expect(invokeMock).not.toHaveBeenCalledWith('plugin_runtime_start', expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith('plugin_install', expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith('plugin_install_from', expect.anything());
  });

  it('enters safe mode after N simulated worker failures', async () => {
    let safeMode = false;
    invokeMock.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'plugin_mark_failed') {
        const id = (params as { id: string }).id;
        return pluginRecord(id, { enabled: false, status: 'failed', lastError: 'simulated crash' });
      }
      if (method === 'plugin_set_safe_mode') {
        safeMode = Boolean((params as { enabled: boolean }).enabled);
        return safeMode;
      }
      if (method === 'plugin_active_resources') {
        return {
          ...emptyResources(safeMode),
          scripts: safeMode
            ? []
            : [
                {
                  pluginId: 'dev.yaqmc.example.network',
                  pluginName: 'Scoped network',
                  source: 'definePlugin({ activate() { return function () {}; } });',
                },
              ],
        };
      }
      throw new Error(method);
    });

    for (let index = 0; index < CRASH_LOOP_FAILURES; index += 1) {
      await invokeMock('plugin_mark_failed', {
        id: 'dev.yaqmc.example.network',
        reason: `simulated worker crash ${index}`,
      });
    }
    await expect(setPluginSafeMode(true)).resolves.toBe(true);
    await expect(pluginHostSafeMode()).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('plugin_set_safe_mode', { enabled: true });
    expect(invokeMock).not.toHaveBeenCalledWith('plugin_runtime_start', expect.anything());
  });

  it('applyPluginResources does not start scripts while safeMode is set', async () => {
    invokeMock.mockImplementation(async (method: string) => {
      if (method === 'plugin_active_resources') {
        return {
          ...emptyResources(true),
          scripts: [
            {
              pluginId: HOSTILE_ID,
              pluginName: 'Hostile probe',
              source: 'definePlugin({ activate() { fetch("https://example.com"); } });',
            },
          ],
        };
      }
      throw new Error(method);
    });

    const resources = await applyPluginResources();
    expect(resources?.safeMode).toBe(true);
    expect(invokeMock).not.toHaveBeenCalledWith('plugin_runtime_start', expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith('plugin_mark_failed', expect.anything());
  });
});
