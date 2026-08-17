import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME_HARD_CAP_BYTES } from '@yaqmc/client';
import { describe, expect, it, vi } from 'vitest';
import { lyricsSurfaceCreateOptions, type LyricsSurfaces } from '../windows/lyrics-surfaces';
import type { LyricsUnlockOverlays } from '../windows/lyrics-unlock';
import { hostDenied, loadMethodAclFromFile } from './channels';
import {
  closeToTrayFromPreferences,
  createHostHandlers,
  DIALOG_PICK_SAVE,
  isNativeWaylandSession,
  lyricsKindFromParams,
  lyricsRoleFromCreateOptions,
  lyricsSurfaceCapabilities,
  lyricsUnlockRoleFromKind,
  playerInvokeMethod,
  rememberCloseToTray,
  SHELL_OPEN_EXTERNAL,
  urlFromOpenExternalParams,
} from './host-handlers';
import { IpcRouter } from './router';

const fixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/yaqmc-client/fixtures',
);

const methods = loadMethodAclFromFile(path.join(fixturesRoot, 'methods.json'));

function mockLyrics(): LyricsSurfaces & {
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  lock: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} {
  const windows = new Map<string, object>();
  return {
    create: vi.fn((kind) => {
      const window = { kind };
      windows.set(kind, window);
      return window as never;
    }),
    show: vi.fn((kind) => {
      windows.set(kind, { kind });
    }),
    hide: vi.fn(),
    lock: vi.fn(),
    get: vi.fn((kind) => windows.get(kind) as never),
  };
}

function mockUnlock(): LyricsUnlockOverlays & {
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
} {
  const windows = new Map<string, object>();
  return {
    create: vi.fn((kind) => {
      const window = { kind };
      windows.set(kind, window);
      return window as never;
    }),
    show: vi.fn((kind) => {
      windows.set(kind, { kind });
    }),
    hide: vi.fn(),
    get: vi.fn((kind) => windows.get(kind) as never),
  };
}

function mockDialogs(options?: {
  save?: { canceled: boolean; filePath?: string };
  open?: { canceled: boolean; filePaths: string[] };
}) {
  return {
    showSaveDialog: vi.fn(async () => options?.save ?? { canceled: true }),
    showOpenDialog: vi.fn(async () => options?.open ?? { canceled: true, filePaths: [] }),
  };
}

describe('host handler helpers', () => {
  it('maps tray/shortcut actions onto Core player methods', () => {
    expect(playerInvokeMethod('toggle')).toBe('player_toggle');
    expect(playerInvokeMethod('next')).toBe('player_next');
    expect(playerInvokeMethod('previous')).toBe('player_previous');
  });

  it('treats native Wayland as linux + WAYLAND_DISPLAY without DISPLAY', () => {
    expect(isNativeWaylandSession('win32', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(false);
    expect(isNativeWaylandSession('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(true);
    expect(
      isNativeWaylandSession('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }),
    ).toBe(false);
    expect(isNativeWaylandSession('linux', { DISPLAY: ':0' })).toBe(false);
  });

  it('defaults close-to-tray to hide unless closeBehavior is quit', () => {
    expect(closeToTrayFromPreferences(null)).toBe(true);
    expect(closeToTrayFromPreferences('{"version":2}')).toBe(true);
    expect(closeToTrayFromPreferences('{"system":{"closeBehavior":"hide-to-tray"}}')).toBe(true);
    expect(closeToTrayFromPreferences('{"system":{"closeBehavior":"quit"}}')).toBe(false);
    expect(rememberCloseToTray({ key: 'locale' }, false)).toBe(false);
    expect(rememberCloseToTray('{"system":{"closeBehavior":"quit"}}', true)).toBe(false);
  });

  it('reads shell.openExternal urls from a string or { url }', () => {
    expect(urlFromOpenExternalParams('https://github.com/YAQMC/YAQMC')).toBe(
      'https://github.com/YAQMC/YAQMC',
    );
    expect(urlFromOpenExternalParams({ url: 'https://y.qq.com/' })).toBe('https://y.qq.com/');
    expect(urlFromOpenExternalParams({ href: 'https://y.qq.com/' })).toBe('');
    expect(lyricsKindFromParams({ kind: 'island' })).toBe('island');
    expect(lyricsKindFromParams({ kind: 'unlock' })).toBeUndefined();
  });

  it('maps lyrics create geometry onto window roles', () => {
    expect(lyricsRoleFromCreateOptions(lyricsSurfaceCreateOptions('desktop', '/p'))).toBe(
      'lyrics-desktop',
    );
    expect(lyricsRoleFromCreateOptions(lyricsSurfaceCreateOptions('island', '/p'))).toBe(
      'lyrics-island',
    );
    expect(lyricsUnlockRoleFromKind('desktop')).toBe('unlock-desktop');
    expect(lyricsUnlockRoleFromKind('island')).toBe('unlock-island');
  });

  it('degrades lyrics capabilities on native Wayland', () => {
    const wayland = lyricsSurfaceCapabilities({ platform: 'linux', nativeWayland: true });
    expect(wayland.backend).toBe('wayland-native');
    expect(wayland.reliableAlwaysOnTop).toBe(false);
    expect(wayland.limitations.length).toBeGreaterThan(0);
    const win32 = lyricsSurfaceCapabilities({ platform: 'win32', nativeWayland: false });
    expect(win32.backend).toBe('win32');
    expect(win32.reliableClickThrough).toBe(true);
  });
});

describe('IpcRouter host intercepts', () => {
  it('allowlists shell.openExternal from main and denies other origins', async () => {
    const openExternal = vi.fn(async () => undefined);
    const lyrics = mockLyrics();
    const handlers = createHostHandlers({
      openExternal,
      lyrics,
      unlock: mockUnlock(),
      capabilities: () => lyricsSurfaceCapabilities({ platform: 'win32', nativeWayland: false }),
      showMainAndOpenSettings: vi.fn(),
    });
    const router = new IpcRouter({ methods, hostHandlers: handlers });
    router.registerWindow(1, 'main');
    router.registerWindow(2, 'lyrics-desktop');

    await expect(
      router.invoke(1, {
        method: SHELL_OPEN_EXTERNAL,
        params: { url: 'https://github.com/YAQMC/YAQMC' },
      }),
    ).resolves.toEqual({ ok: true, result: true });
    expect(openExternal).toHaveBeenCalledWith('https://github.com/YAQMC/YAQMC');

    openExternal.mockClear();
    await expect(
      router.invoke(1, { method: SHELL_OPEN_EXTERNAL, params: { url: 'https://evil.example/' } }),
    ).resolves.toEqual({ ok: true, result: false });
    expect(openExternal).not.toHaveBeenCalled();

    await expect(
      router.invoke(2, {
        method: SHELL_OPEN_EXTERNAL,
        params: { url: 'https://github.com/YAQMC/YAQMC' },
      }),
    ).resolves.toEqual({ ok: false, error: hostDenied(SHELL_OPEN_EXTERNAL, 'lyrics-desktop') });
  });

  it('maps lyrics reconcile/close/lock helpers and unlock overlays', async () => {
    const lyrics = mockLyrics();
    const unlock = mockUnlock();
    const openSettings = vi.fn();
    const emitSurfaceClosed = vi.fn();
    const handlers = createHostHandlers({
      openExternal: vi.fn(),
      lyrics,
      unlock,
      capabilities: () => lyricsSurfaceCapabilities({ platform: 'win32', nativeWayland: false }),
      showMainAndOpenSettings: openSettings,
      emitSurfaceClosed,
    });
    const router = new IpcRouter({ methods, hostHandlers: handlers });
    router.registerWindow(1, 'main');
    router.registerWindow(2, 'unlock-desktop');

    await expect(
      router.invoke(1, {
        method: 'lyrics_surfaces_reconcile',
        params: {
          surfaces: {
            desktop: { enabled: true, interaction: 'passive-locked' },
            island: { enabled: false },
          },
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { desktop: true, island: true, platform: 'win32' },
    });
    expect(lyrics.show).toHaveBeenCalledWith('desktop');
    expect(lyrics.lock).toHaveBeenCalledWith('desktop', true);
    expect(lyrics.hide).toHaveBeenCalledWith('island');
    expect(unlock.show).toHaveBeenCalledWith('desktop');
    expect(unlock.hide).toHaveBeenCalledWith('island');

    await expect(
      router.invoke(1, { method: 'lyrics_surface_close', params: { kind: 'desktop' } }),
    ).resolves.toEqual({ ok: true, result: undefined });
    expect(lyrics.hide).toHaveBeenCalledWith('desktop');
    expect(unlock.hide).toHaveBeenCalledWith('desktop');
    expect(emitSurfaceClosed).toHaveBeenCalledWith('desktop');

    await expect(
      router.invoke(1, {
        method: 'lyrics_surface_set_interaction',
        params: { kind: 'desktop', interaction: 'interactive', value: '{"version":2}' },
      }),
    ).resolves.toEqual({ ok: true, result: '{"version":2}' });
    expect(lyrics.lock).toHaveBeenCalledWith('desktop', false);

    await expect(router.invoke(1, { method: 'lyrics_surface_show_settings' })).resolves.toEqual({
      ok: true,
      result: undefined,
    });
    expect(openSettings).toHaveBeenCalledTimes(1);

    lyrics.show('desktop');
    lyrics.show('island');
    await expect(router.invoke(1, { method: 'lyrics_surfaces_unlock_all' })).resolves.toEqual({
      ok: true,
      result: 2,
    });
    expect(lyrics.lock).toHaveBeenCalledWith('desktop', false);
    expect(lyrics.lock).toHaveBeenCalledWith('island', false);
    expect(unlock.hide).toHaveBeenCalledWith('desktop');
    expect(unlock.hide).toHaveBeenCalledWith('island');

    await expect(
      router.invoke(2, { method: 'lyrics_surface_unlock', params: { kind: 'desktop' } }),
    ).resolves.toEqual({ ok: true, result: undefined });
    expect(lyrics.lock).toHaveBeenCalledWith('desktop', false);
    expect(unlock.hide).toHaveBeenCalledWith('desktop');

    await expect(
      router.invoke(1, { method: 'lyrics_surface_reset_position', params: { kind: 'desktop' } }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'host.denied' } });
  });

  it('injects Electron dialogs for inventory path pickers and dialog.pickSave', async () => {
    const dialogs = mockDialogs({
      save: { canceled: false, filePath: 'D:\\exports\\YAQMC-diagnostics.zip' },
      open: { canceled: false, filePaths: ['/tmp/wall.png'] },
    });
    const handlers = createHostHandlers({
      openExternal: vi.fn(),
      lyrics: mockLyrics(),
      unlock: mockUnlock(),
      capabilities: () => lyricsSurfaceCapabilities({ platform: 'win32', nativeWayland: false }),
      showMainAndOpenSettings: vi.fn(),
      dialogs,
    });
    const router = new IpcRouter({ methods, hostHandlers: handlers });
    router.registerWindow(1, 'main');

    await expect(router.invoke(1, { method: 'appearance_pick_background' })).resolves.toEqual({
      ok: true,
      result: { reference: '/tmp/wall.png', dataUri: '' },
    });
    expect(dialogs.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
        properties: ['openFile'],
      }),
    );

    dialogs.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/plugins/pack.yaqmc-plugin'],
    });
    await expect(router.invoke(1, { method: 'plugin_pick_package' })).resolves.toEqual({
      ok: true,
      result: '/plugins/pack.yaqmc-plugin',
    });

    dialogs.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/plugins/unpacked'],
    });
    await expect(router.invoke(1, { method: 'plugin_pick_directory' })).resolves.toEqual({
      ok: true,
      result: '/plugins/unpacked',
    });
    expect(dialogs.showOpenDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ properties: ['openDirectory'] }),
    );

    await expect(router.invoke(1, { method: DIALOG_PICK_SAVE })).resolves.toEqual({
      ok: true,
      result: 'D:\\exports\\YAQMC-diagnostics.zip',
    });
    expect(dialogs.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: 'YAQMC-diagnostics.zip',
        filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
      }),
    );

    dialogs.showSaveDialog.mockResolvedValueOnce({ canceled: true });
    await expect(router.invoke(1, { method: DIALOG_PICK_SAVE })).resolves.toEqual({
      ok: true,
      result: null,
    });
  });

  it('leaves the 32 MiB hard cap unchanged', () => {
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});
