import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { WindowRole } from '@yaqmc/client';
import type { InvokeRequest } from '../ipc';
import { hostDenied, loadMethodAclFromFile } from './channels';
import {
  createHostHandlers,
  lyricsSurfaceCapabilities,
  type HostHandlerDeps,
} from './host-handlers';
import { IpcRouter } from './router';

const fixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/yaqmc-client/fixtures',
);

const methods = loadMethodAclFromFile(path.join(fixturesRoot, 'methods.json'));

const DIALOG_SPLIT_IO = [
  'diagnostics_export_bundle_to',
  'preferences_set_background_from',
  'plugin_install_from',
] as const;

const UNAUTHORIZED_ROLES: WindowRole[] = [
  'lyrics-desktop',
  'lyrics-island',
  'unlock-desktop',
  'unlock-island',
];

function lyricsStubs(): Pick<
  HostHandlerDeps,
  'openExternal' | 'lyrics' | 'unlock' | 'capabilities' | 'showMainAndOpenSettings'
> {
  return {
    openExternal: vi.fn(),
    lyrics: {
      show: vi.fn(),
      hide: vi.fn(),
      lock: vi.fn(),
      get: vi.fn(),
      isVisible: vi.fn(),
      create: vi.fn(),
      restoreGeometry: vi.fn(),
      resetPosition: vi.fn(),
      flushGeometry: vi.fn(),
    } as HostHandlerDeps['lyrics'],
    unlock: {
      show: vi.fn(),
      hide: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
    } as unknown as HostHandlerDeps['unlock'],
    capabilities: () =>
      lyricsSurfaceCapabilities({ platform: 'win32', nativeWayland: false }),
    showMainAndOpenSettings: vi.fn(),
  };
}

describe('dialog-split origin continuation', () => {
  it('keeps _to/_from as main-renderer methods, not host-internal', () => {
    for (const name of DIALOG_SPLIT_IO) {
      const row = methods.find((method) => method.name === name);
      expect(row, name).toBeDefined();
      expect(row?.owner).toBe('core');
      expect(row?.allowedOrigins).toEqual(['main']);
    }
    const attach = methods.find((method) => method.name === 'platform_attach');
    expect(attach?.allowedOrigins).toEqual(['host', 'main']);
  });

  it('stamps main origin on Diagnostics Export after the host-owned Save dialog', async () => {
    const hostPayload = {
      schemaVersion: 1,
      electron: '43.4.0',
      chrome: '',
      node: '',
      windows: [],
      display: {
        backend: 'win32',
        capabilities: {
          alwaysOnTop: true,
          clickThrough: true,
          globalShortcuts: true,
          transparency: true,
        },
      },
      updater: { state: 'idle' },
      restartCounter: 0,
    };
    const coreInvoke = vi.fn(async () => ({ path: 'D:\\out\\YAQMC-diagnostics.zip', bytes: 12 }));
    const router = new IpcRouter({
      methods,
      hostHandlers: createHostHandlers({
        ...lyricsStubs(),
        downloadsDir: () => 'D:\\Downloads',
        coreInvoke,
        collectHostPayload: () => hostPayload,
      }),
    });
    router.registerWindow(1, 'main');

    await expect(
      router.invoke(1, {
        method: 'diagnostics_export_bundle_to',
        params: { path: 'D:\\out\\YAQMC-diagnostics.zip', request: { includeLogs: true } },
      }),
    ).resolves.toEqual({
      ok: true,
      result: { path: 'D:\\out\\YAQMC-diagnostics.zip', bytes: 12 },
    });
    expect(coreInvoke).toHaveBeenCalledWith(
      'diagnostics_export_bundle_to',
      {
        path: 'D:\\out\\YAQMC-diagnostics.zip',
        request: { includeLogs: true, hostPayload },
      },
      'main',
    );
  });

  it('uses the same Main-assigned origin for background _from and plugin _from', async () => {
    const invoke = vi.fn(async (method: string) => {
      if (method === 'preferences_set_background_from') {
        return { reference: 'bg.png', dataUri: '' };
      }
      return { id: 'plugin-1' };
    });
    const router = new IpcRouter({
      methods,
      client: { invoke },
    });
    router.registerWindow(1, 'main');

    await expect(
      router.invoke(1, {
        method: 'preferences_set_background_from',
        params: { path: 'D:\\Pictures\\bg.png' },
      }),
    ).resolves.toEqual({ ok: true, result: { reference: 'bg.png', dataUri: '' } });
    expect(invoke).toHaveBeenCalledWith(
      'preferences_set_background_from',
      { path: 'D:\\Pictures\\bg.png' },
      'main',
    );

    invoke.mockClear();
    await expect(
      router.invoke(1, {
        method: 'plugin_install_from',
        params: { request: { path: 'D:\\plugins\\demo.yaqmc-plugin', enable: false, grant: [] } },
      }),
    ).resolves.toEqual({ ok: true, result: { id: 'plugin-1' } });
    expect(invoke).toHaveBeenCalledWith(
      'plugin_install_from',
      { request: { path: 'D:\\plugins\\demo.yaqmc-plugin', enable: false, grant: [] } },
      'main',
    );
  });

  it('denies lyric, unlock, and unregistered OAuth windows before Core', async () => {
    const invoke = vi.fn(async () => ({ leaked: true }));
    const coreInvoke = vi.fn(async () => ({ leaked: true }));
    const router = new IpcRouter({
      methods,
      client: { invoke },
      hostHandlers: createHostHandlers({
        ...lyricsStubs(),
        coreInvoke,
        collectHostPayload: () => {
          throw new Error('host payload must not run for denied origins');
        },
      }),
    });
    router.registerWindow(1, 'main');
    for (const [id, role] of UNAUTHORIZED_ROLES.entries()) {
      router.registerWindow(id + 2, role);
    }

    for (const name of DIALOG_SPLIT_IO) {
      for (const [index, role] of UNAUTHORIZED_ROLES.entries()) {
        await expect(router.invoke(index + 2, { method: name, params: { path: 'x' } })).resolves.toEqual({
          ok: false,
          error: hostDenied(name, role),
        });
      }
      await expect(router.invoke(99, { method: name, params: { path: 'x' } })).resolves.toMatchObject({
        ok: false,
        error: { code: 'host.denied' },
      });
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(coreInvoke).not.toHaveBeenCalled();
  });

  it('does not let a renderer choose or spoof origin', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const coreInvoke = vi.fn(async () => ({ path: 'D:\\out\\YAQMC-diagnostics.zip', bytes: 1 }));
    const router = new IpcRouter({
      methods,
      client: { invoke },
      hostHandlers: createHostHandlers({
        ...lyricsStubs(),
        coreInvoke,
        collectHostPayload: () => ({
          schemaVersion: 1,
          electron: '43.4.0',
          chrome: '',
          node: '',
          windows: [],
          display: {
            backend: 'win32',
            capabilities: {
              alwaysOnTop: true,
              clickThrough: true,
              globalShortcuts: true,
              transparency: true,
            },
          },
          updater: { state: 'idle' },
          restartCounter: 0,
        }),
      }),
    });
    router.registerWindow(1, 'main');

    const spoofed = {
      method: 'diagnostics_export_bundle_to',
      params: { path: 'D:\\out\\YAQMC-diagnostics.zip', origin: 'host' },
      origin: 'host',
    } as InvokeRequest & { origin: string };

    await expect(router.invoke(1, spoofed)).resolves.toMatchObject({ ok: true });
    expect(coreInvoke).toHaveBeenCalledWith(
      'diagnostics_export_bundle_to',
      expect.objectContaining({
        path: 'D:\\out\\YAQMC-diagnostics.zip',
      }),
      'main',
    );

    invoke.mockClear();
    const fromSpoof = {
      method: 'preferences_set_background_from',
      params: { path: 'D:\\bg.png', origin: 'lyrics-desktop' },
      origin: 'host',
    } as InvokeRequest & { origin: string };
    await expect(router.invoke(1, fromSpoof)).resolves.toMatchObject({ ok: true });
    expect(invoke).toHaveBeenCalledWith(
      'preferences_set_background_from',
      { path: 'D:\\bg.png', origin: 'lyrics-desktop' },
      'main',
    );
  });
});
