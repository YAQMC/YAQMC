import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME_HARD_CAP_BYTES } from '@yaqmc/client';
import { describe, expect, it, vi } from 'vitest';
import { lyricsSurfaceCreateOptions, type LyricsSurfaces } from '../windows/lyrics-surfaces';
import { hostDenied, loadMethodAclFromFile } from './channels';
import {
  closeToTrayFromPreferences,
  createHostHandlers,
  isNativeWaylandSession,
  lyricsKindFromParams,
  lyricsRoleFromCreateOptions,
  lyricsSurfaceCapabilities,
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

  it('maps lyrics reconcile/close/lock helpers and leaves unlock unimplemented', async () => {
    const lyrics = mockLyrics();
    const openSettings = vi.fn();
    const emitSurfaceClosed = vi.fn();
    const handlers = createHostHandlers({
      openExternal: vi.fn(),
      lyrics,
      capabilities: () => lyricsSurfaceCapabilities({ platform: 'win32', nativeWayland: false }),
      showMainAndOpenSettings: openSettings,
      emitSurfaceClosed,
    });
    const router = new IpcRouter({ methods, hostHandlers: handlers });
    router.registerWindow(1, 'main');

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

    await expect(
      router.invoke(1, { method: 'lyrics_surface_close', params: { kind: 'desktop' } }),
    ).resolves.toEqual({ ok: true, result: undefined });
    expect(lyrics.hide).toHaveBeenCalledWith('desktop');
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

    await expect(router.invoke(1, { method: 'lyrics_surfaces_unlock_all' })).resolves.toEqual({
      ok: false,
      error: {
        code: 'host.denied',
        message: 'lyrics_surfaces_unlock_all is implemented by the host',
        retryable: false,
      },
    });
    await expect(
      router.invoke(1, { method: 'lyrics_surface_reset_position', params: { kind: 'desktop' } }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'host.denied' } });
  });

  it('leaves the 32 MiB hard cap unchanged', () => {
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});
