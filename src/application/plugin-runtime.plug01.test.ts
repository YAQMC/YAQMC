// @ts-expect-error Vitest runs in Node; the renderer tsconfig does not include Node types.
import { readFileSync } from 'node:fs';
// @ts-expect-error Vitest runs in Node; the renderer tsconfig does not include Node types.
import { dirname, join } from 'node:path';
// @ts-expect-error Vitest runs in Node; the renderer tsconfig does not include Node types.
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installPlugin,
  installUnpackedPlugin,
  listPlugins,
  setPluginEnabled,
  uninstallPlugin,
  type PluginRecord,
} from './plugin-runtime';

const invokeMock = vi.hoisted(() => vi.fn());
const hostKind = vi.hoisted(() => ({ value: 'electron' as 'electron' | 'fake' }));

vi.mock('./yaqmc-runtime', () => ({
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

const examplesRoot = join(dirname(fileURLToPath(import.meta.url)), '../../examples/plugins');

function emptyResources() {
  return {
    safeMode: false,
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

function stubInvoke(handler: (method: string, params: unknown) => unknown) {
  invokeMock.mockImplementation(async (method: string, params?: unknown) => {
    if (method === 'plugin_active_resources') return emptyResources();
    return handler(method, params);
  });
}

describe('PLUG-01 example plugin lifecycle', () => {
  afterEach(() => {
    hostKind.value = 'electron';
    invokeMock.mockReset();
  });

  it('parses the scene-pack example manifest without a lyrics-scene E2E', () => {
    const manifest = JSON.parse(
      readFileSync(join(examplesRoot, 'scene-pack/manifest.json'), 'utf8'),
    ) as {
      id: string;
      entrypoints: { scenes: string[] };
      permissions: string[];
    };
    expect(manifest.id).toBe('dev.yaqmc.example.scenes');
    expect(manifest.entrypoints.scenes).toEqual([
      'scenes/aurora.scene.json',
      'scenes/vinyl-glow.scene.json',
    ]);
    expect(manifest.permissions).toContain('scene.register');
    expect(manifest.id).not.toBe('dev.yaqmc.test.hostile');
  });

  it('installs, lists, disables, enables, and uninstalls on Electron via plugin_install_from', async () => {
    const sakura = pluginRecord('dev.yaqmc.example.sakura', {
      enabled: true,
      status: 'active',
      grantedPermissions: ['style.register'],
    });
    stubInvoke((method) => {
      if (method === 'plugin_install_from') return sakura;
      if (method === 'plugin_list') return [sakura];
      if (method === 'plugin_set_enabled') {
        return { ...sakura, enabled: false, status: 'disabled' as const };
      }
      if (method === 'plugin_uninstall') return undefined;
      throw new Error(method);
    });

    await expect(
      installPlugin('D:\\examples\\plugins\\style-sakura', { enable: true, grant: [] }),
    ).resolves.toMatchObject({ id: 'dev.yaqmc.example.sakura', enabled: true });
    expect(invokeMock).toHaveBeenCalledWith('plugin_install_from', {
      request: { path: 'D:\\examples\\plugins\\style-sakura', enable: true, grant: [] },
    });
    expect(invokeMock).not.toHaveBeenCalledWith('plugin_install', expect.anything());

    await expect(listPlugins()).resolves.toEqual([sakura]);
    await expect(setPluginEnabled('dev.yaqmc.example.sakura', false)).resolves.toMatchObject({
      enabled: false,
      status: 'disabled',
    });
    expect(invokeMock).toHaveBeenCalledWith('plugin_set_enabled', {
      request: { id: 'dev.yaqmc.example.sakura', enabled: false, grant: [] },
    });

    await uninstallPlugin('dev.yaqmc.example.sakura', true);
    expect(invokeMock).toHaveBeenCalledWith('plugin_uninstall', {
      request: { id: 'dev.yaqmc.example.sakura', removeData: true },
    });
  });

  it('installs an unpacked example through plugin_install_unpacked', async () => {
    const sakura = pluginRecord('dev.yaqmc.example.sakura', {
      source: 'unpacked',
      unpackedPath: 'D:\\examples\\plugins\\style-sakura',
    });
    stubInvoke((method) => {
      if (method === 'plugin_install_unpacked') return sakura;
      throw new Error(method);
    });
    await expect(
      installUnpackedPlugin('D:\\examples\\plugins\\style-sakura', {
        enable: false,
        grant: [],
      }),
    ).resolves.toMatchObject({ id: 'dev.yaqmc.example.sakura', source: 'unpacked' });
    expect(invokeMock).toHaveBeenCalledWith('plugin_install_unpacked', {
      request: {
        path: 'D:\\examples\\plugins\\style-sakura',
        enable: false,
        grant: [],
      },
    });
  });

  it('denies enable when sensitive grants are missing and forwards an explicit grant', async () => {
    stubInvoke((method, params) => {
      if (method === 'plugin_set_enabled') {
        const request = (params as { request: { grant: string[]; enabled: boolean } }).request;
        if (request.enabled && !request.grant.includes('network:https://example.com')) {
          throw new Error('sensitive permissions must be explicitly accepted');
        }
        return pluginRecord('dev.yaqmc.example.network', {
          enabled: true,
          status: 'active',
          grantedPermissions: ['network:https://example.com'],
          networkOrigins: ['https://example.com'],
          entrypoints: { styles: 0, scenes: 0, script: true },
          permissions: ['ui.notify', 'network:https://example.com'],
        });
      }
      throw new Error(method);
    });

    await expect(setPluginEnabled('dev.yaqmc.example.network', true, [])).rejects.toThrow(
      /explicitly accepted/,
    );
    await expect(
      setPluginEnabled('dev.yaqmc.example.network', true, ['network:https://example.com']),
    ).resolves.toMatchObject({
      enabled: true,
      grantedPermissions: ['network:https://example.com'],
    });
    expect(invokeMock).toHaveBeenCalledWith('plugin_set_enabled', {
      request: {
        id: 'dev.yaqmc.example.network',
        enabled: true,
        grant: ['network:https://example.com'],
      },
    });
  });

  it('keeps plugin data when uninstall removeData is false', async () => {
    stubInvoke((method) => {
      if (method === 'plugin_uninstall') return undefined;
      throw new Error(method);
    });
    await uninstallPlugin('dev.yaqmc.example.actions', false);
    expect(invokeMock).toHaveBeenCalledWith('plugin_uninstall', {
      request: { id: 'dev.yaqmc.example.actions', removeData: false },
    });
  });
});
