import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  HANDSHAKE_TIMEOUT_MS,
  SHUTDOWN_TIMEOUT_MS,
  type CoreMessage,
  type WindowRole,
} from '@yaqmc/client';
import { CoreClient } from '../core/client';
import { CoreSupervisor, tryResolveCoreBinary } from '../core/supervisor';
import { encodeFrame, FrameDecoder } from '../core/frames';
import type { InvokeRequest } from '../ipc';
import { hostDenied, loadMethodAclFromFile } from './channels';
import {
  createHostHandlers,
  lyricsSurfaceCapabilities,
  type HostHandlerDeps,
} from './host-handlers';
import { IpcRouter } from './router';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixturesRoot = path.join(repoRoot, 'packages/yaqmc-client/fixtures');
const PNG = Buffer.from('\x89PNG\r\n\x1a\nrest', 'binary');
const liveBinary = tryResolveCoreBinary({
  env: process.env,
  cargoTargetDir: process.env.CARGO_TARGET_DIR,
  repoRoot,
  packaged: false,
});

const methods = loadMethodAclFromFile(path.join(fixturesRoot, 'methods.json'));

const DIALOG_SPLIT_IO = [
  'diagnostics_export_bundle_to',
  'preferences_set_background_from',
  'plugin_install_from',
] as const;

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
      isLocked: vi.fn(),
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
      position: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
    } as unknown as HostHandlerDeps['unlock'],
    capabilities: () => lyricsSurfaceCapabilities({ platform: 'win32', nativeWayland: false }),
    showMainAndOpenSettings: vi.fn(),
  };
}

type CoreRequestFrame = {
  kind: string;
  id: number;
  method: string;
  params?: unknown;
  origin?: string;
};

function productionChain() {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const decoder = new FrameDecoder();
  const frames: CoreRequestFrame[] = [];
  writable.on('data', (chunk: Buffer) => {
    for (const payload of decoder.push(chunk)) {
      frames.push(JSON.parse(payload.toString('utf8')) as CoreRequestFrame);
    }
  });
  const core = new CoreClient({ readable, writable });
  core.start();

  const dialogs = {
    showSaveDialog: vi.fn(async () => ({
      canceled: false,
      filePath: 'D:\\out\\YAQMC-diagnostics.zip',
    })),
    showOpenDialog: vi.fn(async () => ({
      canceled: false,
      filePaths: ['D:\\Pictures\\bg.png'],
    })),
  };

  const router = new IpcRouter({
    methods,
    client: core,
    hostHandlers: createHostHandlers({
      ...lyricsStubs(),
      dialogs,
      downloadsDir: () => 'D:\\Downloads',
      coreInvoke: (method, params, origin) => core.invoke(method, params, origin),
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

  async function rendererInvoke(request: InvokeRequest, webContentsId = 1) {
    const pending = router.invoke(webContentsId, request);
    await vi.waitFor(() => frames.some((frame) => frame.method === request.method));
    const frame = [...frames].reverse().find((entry) => entry.method === request.method);
    if (frame) {
      readable.write(
        encodeFrame(
          Buffer.from(
            JSON.stringify({
              kind: 'response',
              id: frame.id,
              ok: true,
              result: { path: 'D:\\out\\YAQMC-diagnostics.zip', bytes: 12 },
            }),
          ),
        ),
      );
    }
    return pending;
  }

  return { router, core, frames, dialogs, rendererInvoke, readable };
}

const HOST_PAYLOAD = {
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
  updater: { state: 'idle' as const },
  restartCounter: 0,
};

function tapSerializedRequests(client: CoreClient): CoreRequestFrame[] {
  const frames: CoreRequestFrame[] = [];
  const originalSend = client.send.bind(client);
  client.send = async (message: CoreMessage) => {
    const wire = JSON.parse(Buffer.from(JSON.stringify(message)).toString('utf8')) as CoreRequestFrame;
    if (wire.kind === 'request') {
      frames.push(wire);
    }
    return originalSend(message);
  };
  return frames;
}

async function liveProductionChain(root: string, openPath: string) {
  const savePath = path.join(root, 'YAQMC-diagnostics.zip');
  const supervisor = new CoreSupervisor({
    binary: liveBinary as string,
    hostVersion: '0.1.0',
    expectedCoreVersion: '0.1.0',
    autoRestart: false,
    handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    dataDir: path.join(root, 'data'),
    cacheDir: path.join(root, 'cache'),
    logDir: path.join(root, 'logs'),
    configDir: path.join(root, 'config'),
  });
  await supervisor.start();
  const frames = tapSerializedRequests(supervisor.client);
  const dialogs = {
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: savePath })),
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [openPath] })),
  };
  const router = new IpcRouter({
    methods,
    client: supervisor.client,
    hostHandlers: createHostHandlers({
      ...lyricsStubs(),
      dialogs,
      downloadsDir: () => path.join(root, 'downloads'),
      dataDir: () => path.join(root, 'data'),
      coreInvoke: (method, params, origin) => supervisor.client.invoke(method, params, origin),
      collectHostPayload: () => HOST_PAYLOAD,
    }),
  });
  router.registerWindow(1, 'main');
  return { router, supervisor, frames, dialogs, savePath };
}

describe('dialog-split production IpcRouter + dialog + CoreClient stdio', () => {
  it('serializes origin=main on the real Diagnostics Export continuation', async () => {
    const { router, frames, rendererInvoke } = productionChain();

    await expect(
      router.invoke(1, { method: 'dialog.pickSave', params: { defaultPath: 'YAQMC-diagnostics.zip' } }),
    ).resolves.toMatchObject({ ok: true });
    expect(frames.filter((frame) => frame.kind === 'request')).toEqual([]);

    const spoofed = {
      method: 'diagnostics_export_bundle_to',
      params: {
        path: 'D:\\out\\YAQMC-diagnostics.zip',
        request: { includeLogs: true },
        origin: 'host',
      },
      origin: 'host',
    } as InvokeRequest & { origin: string };

    await expect(rendererInvoke(spoofed)).resolves.toMatchObject({ ok: true });
    const request = frames.find((frame) => frame.method === 'diagnostics_export_bundle_to');
    expect(request).toMatchObject({
      kind: 'request',
      method: 'diagnostics_export_bundle_to',
      origin: 'main',
    });
    expect(request).not.toHaveProperty('origin', 'host');
  });

  it('serializes origin=main on background _from and plugin _from after host pickers', async () => {
    const { router, frames, rendererInvoke } = productionChain();

    await expect(router.invoke(1, { method: 'appearance_pick_background' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      rendererInvoke({
        method: 'preferences_set_background_from',
        params: { path: 'D:\\Pictures\\bg.png' },
      }),
    ).resolves.toMatchObject({ ok: true });
    const background = frames.find((frame) => frame.method === 'preferences_set_background_from');
    expect(background).toEqual({
      kind: 'request',
      id: background?.id,
      method: 'preferences_set_background_from',
      params: { path: 'D:\\Pictures\\bg.png' },
      origin: 'main',
    });

    await expect(router.invoke(1, { method: 'plugin_pick_package' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      rendererInvoke({
        method: 'plugin_install_from',
        params: { request: { path: 'D:\\plugins\\demo.yaqmc-plugin', enable: true, grant: [] } },
      }),
    ).resolves.toMatchObject({ ok: true });
    const plugin = frames.find((frame) => frame.method === 'plugin_install_from');
    expect(plugin?.origin).toBe('main');
    expect(plugin?.method).toBe('plugin_install_from');
  });

  it('surfaces the Core ACL message the background picker currently swallows as imageFailed', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const decoder = new FrameDecoder();
    const frames: CoreRequestFrame[] = [];
    writable.on('data', (chunk: Buffer) => {
      for (const payload of decoder.push(chunk)) {
        frames.push(JSON.parse(payload.toString('utf8')) as CoreRequestFrame);
      }
    });
    const core = new CoreClient({ readable, writable });
    core.start();
    const router = new IpcRouter({ methods, client: core });
    router.registerWindow(1, 'main');

    const pending = router.invoke(1, {
      method: 'preferences_set_background_from',
      params: { path: 'D:\\Pictures\\bg.png' },
    });
    await vi.waitFor(() => frames.some((frame) => frame.method === 'preferences_set_background_from'));
    const frame = frames.find((entry) => entry.method === 'preferences_set_background_from');
    expect(frame?.origin).toBe('main');
    readable.write(
      encodeFrame(
        Buffer.from(
          JSON.stringify({
            kind: 'response',
            id: frame?.id,
            ok: false,
            error: {
              code: 'host.denied',
              message: 'preferences_set_background_from is not allowed from host',
              retryable: false,
            },
          }),
        ),
      ),
    );
    const reply = await pending;
    expect(reply).toEqual({
      ok: false,
      error: {
        code: 'host.denied',
        message: 'preferences_set_background_from is not allowed from host',
        retryable: false,
      },
    });
  });

  it('denies lyric/unlock/OAuth windows and omits origin on true host-internal calls', async () => {
    const { router, frames, core, readable } = productionChain();
    const denied: WindowRole[] = [
      'lyrics-desktop',
      'lyrics-island',
      'unlock-desktop',
      'unlock-island',
    ];
    for (const [index, role] of denied.entries()) {
      router.registerWindow(index + 10, role);
      for (const method of DIALOG_SPLIT_IO) {
        await expect(router.invoke(index + 10, { method, params: { path: 'x' } })).resolves.toEqual({
          ok: false,
          error: hostDenied(method, role),
        });
      }
    }
    await expect(router.invoke(99, { method: 'diagnostics_export_bundle_to' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'host.denied' },
    });
    expect(frames).toEqual([]);

    const hostInternal = core.invoke('platform_attach', { platformKind: 'windows' });
    await vi.waitFor(() => frames.some((frame) => frame.method === 'platform_attach'));
    const attach = frames.find((frame) => frame.method === 'platform_attach');
    expect(attach).toEqual({
      kind: 'request',
      id: attach?.id,
      method: 'platform_attach',
      params: { platformKind: 'windows' },
    });
    expect(attach).not.toHaveProperty('origin');
    readable.write(
      encodeFrame(
        Buffer.from(JSON.stringify({ kind: 'response', id: attach?.id, ok: true, result: { ok: true } })),
      ),
    );
    await hostInternal;
  });
});

describe.skipIf(!liveBinary)('dialog-split live IpcRouter + Core stdio', () => {
  it('main-renderer Diagnostics Export reaches Core as main and creates a ZIP', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-dialog-split-zip-'));
    const chain = await liveProductionChain(root, path.join(root, 'unused.png'));
    try {
      await expect(
        chain.router.invoke(1, {
          method: 'dialog.pickSave',
          params: { defaultPath: 'YAQMC-diagnostics.zip' },
        }),
      ).resolves.toEqual({ ok: true, result: chain.savePath });

      const spoofed = {
        method: 'diagnostics_export_bundle_to',
        params: {
          path: chain.savePath,
          request: { includeLogs: false },
          origin: 'host',
        },
        origin: 'host',
      } as InvokeRequest & { origin: string };

      const reply = await chain.router.invoke(1, spoofed);
      expect(reply).toMatchObject({ ok: true });
      if (reply.ok) {
        expect(reply.result).toMatchObject({ path: chain.savePath });
        expect((reply.result as { bytes: number }).bytes).toBeGreaterThan(0);
      }
      expect(existsSync(chain.savePath)).toBe(true);

      const request = chain.frames.find((frame) => frame.method === 'diagnostics_export_bundle_to');
      expect(request).toMatchObject({
        kind: 'request',
        method: 'diagnostics_export_bundle_to',
        origin: 'main',
      });
      expect(request).not.toHaveProperty('origin', 'host');
    } finally {
      await chain.supervisor.stop();
    }
  }, 30_000);

  it('background picker copies PNG, JPEG, Unicode paths, and >1 MiB images as main', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-dialog-split-bg-'));
    const png = path.join(root, 'wall.png');
    const jpeg = path.join(root, 'wall.jpg');
    const unicode = path.join(root, '背景.png');
    const large = path.join(root, 'large.png');
    writeFileSync(png, PNG);
    writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    writeFileSync(unicode, PNG);
    const largeBytes = Buffer.alloc(1_200_000);
    PNG.copy(largeBytes, 0, 0, PNG.length);
    writeFileSync(large, largeBytes);
    const chain = await liveProductionChain(root, png);
    try {
      const cases: Array<{ file: string; reference: string }> = [
        { file: png, reference: 'backgrounds/custom-background.png' },
        { file: jpeg, reference: 'backgrounds/custom-background.jpg' },
        { file: unicode, reference: 'backgrounds/custom-background.png' },
        { file: large, reference: 'backgrounds/custom-background.png' },
      ];
      for (const sample of cases) {
        chain.dialogs.showOpenDialog.mockResolvedValueOnce({
          canceled: false,
          filePaths: [sample.file],
        });
        const picked = await chain.router.invoke(1, { method: 'appearance_pick_background' });
        expect(picked).toEqual({
          ok: true,
          result: { reference: sample.file, dataUri: '' },
        });
        const reply = await chain.router.invoke(1, {
          method: 'preferences_set_background_from',
          params: { path: sample.file },
        });
        const request = [...chain.frames]
          .reverse()
          .find((frame) => frame.method === 'preferences_set_background_from');
        expect(request?.origin).toBe('main');
        expect(request).not.toHaveProperty('origin', 'host');
        if (!reply.ok) {
          throw new Error(
            `background _from failed for ${path.basename(sample.file)}: ${reply.error.code} ${reply.error.message}`,
          );
        }
        expect(reply.result).toMatchObject({ reference: sample.reference });
        const image = reply.result as { dataUri: string };
        expect(image.dataUri.startsWith('data:image/')).toBe(true);
        expect(image.dataUri.length).toBeGreaterThan(20);
      }
    } finally {
      await chain.supervisor.stop();
    }
  }, 60_000);

  it('plugin install-from-file as main is not a host ACL denial', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-dialog-split-plugin-'));
    const pkg = path.join(root, 'missing.yaqmc-plugin');
    const chain = await liveProductionChain(root, pkg);
    try {
      await expect(chain.router.invoke(1, { method: 'plugin_pick_package' })).resolves.toMatchObject({
        ok: true,
      });
      const reply = await chain.router.invoke(1, {
        method: 'plugin_install_from',
        params: { request: { path: pkg, enable: true, grant: [] } },
      });
      const request = chain.frames.find((frame) => frame.method === 'plugin_install_from');
      expect(request?.origin).toBe('main');
      expect(reply.ok).toBe(false);
      if (!reply.ok) {
        expect(reply.error.code).not.toBe('host.denied');
        expect(reply.error.message).not.toMatch(/not allowed from host/);
      }
    } finally {
      await chain.supervisor.stop();
    }
  }, 30_000);
});
