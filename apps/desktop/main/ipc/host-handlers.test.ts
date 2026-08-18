import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME_HARD_CAP_BYTES } from '@yaqmc/client';
import { describe, expect, it, vi } from 'vitest';
import {
  lyricsSurfaceCreateOptions,
  type LyricsSurfaceKind,
  type LyricsSurfaceWindow,
  type LyricsSurfaces,
} from '../windows/lyrics-surfaces';
import type {
  LyricsUnlockKind,
  LyricsUnlockOverlays,
  LyricsUnlockWindow,
} from '../windows/lyrics-unlock';
import { hostDenied, loadMethodAclFromFile } from './channels';
import {
  closeToTrayFromPreferences,
  createHostHandlers,
  DIALOG_PICK_SAVE,
  DIAGNOSTICS_OPEN_LOG_FOLDER,
  DIAGNOSTICS_REVEAL_BUNDLE,
  HOST_CORE_STATUS,
  HOST_UPDATER_CHECK_METHOD,
  isNativeWaylandSession,
  loginProviderFromParams,
  lyricsKindFromParams,
  lyricsRoleFromCreateOptions,
  lyricsSurfaceCapabilities,
  lyricsUnlockRoleFromKind,
  playerInvokeMethod,
  rememberCloseToTray,
  SHELL_OPEN_EXTERNAL,
  WINDOW_CLOSE,
  WINDOW_MINIMIZE,
  WINDOW_SET_FULLSCREEN,
  WINDOW_TOGGLE_MAXIMIZE,
  urlFromOpenExternalParams,
  type OAuthHostDeps,
} from './host-handlers';
import { IpcRouter } from './router';

const fixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/yaqmc-client/fixtures',
);

const methods = loadMethodAclFromFile(path.join(fixturesRoot, 'methods.json'));

function stubLyricsWindow(): LyricsSurfaceWindow {
  return {
    loadURL: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    setFocusable: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setResizable: vi.fn(),
  };
}

function stubUnlockWindow(): LyricsUnlockWindow {
  return {
    loadURL: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    setAlwaysOnTop: vi.fn(),
  };
}

function mockLyrics(): LyricsSurfaces & {
  create: ReturnType<typeof vi.fn<(kind: LyricsSurfaceKind) => LyricsSurfaceWindow>>;
  show: ReturnType<typeof vi.fn<(kind: LyricsSurfaceKind) => void>>;
  hide: ReturnType<typeof vi.fn<(kind: LyricsSurfaceKind) => void>>;
  lock: ReturnType<typeof vi.fn<(kind: LyricsSurfaceKind, locked: boolean) => void>>;
  get: ReturnType<typeof vi.fn<(kind: LyricsSurfaceKind) => LyricsSurfaceWindow | undefined>>;
  isVisible: ReturnType<typeof vi.fn<(kind: LyricsSurfaceKind) => boolean>>;
  restoreGeometry: ReturnType<typeof vi.fn<(kind?: LyricsSurfaceKind) => Promise<void>>>;
  resetPosition: ReturnType<typeof vi.fn<(kind: LyricsSurfaceKind) => Promise<void>>>;
  flushGeometry: ReturnType<typeof vi.fn<(kind: LyricsSurfaceKind) => Promise<void>>>;
} {
  const windows = new Map<LyricsSurfaceKind, LyricsSurfaceWindow>();
  return {
    create: vi.fn((kind: LyricsSurfaceKind) => {
      const existing = windows.get(kind);
      if (existing) {
        return existing;
      }
      const window = stubLyricsWindow();
      windows.set(kind, window);
      return window;
    }),
    show: vi.fn((kind: LyricsSurfaceKind) => {
      if (!windows.has(kind)) {
        windows.set(kind, stubLyricsWindow());
      }
    }),
    hide: vi.fn<(kind: LyricsSurfaceKind) => void>(),
    lock: vi.fn<(kind: LyricsSurfaceKind, locked: boolean) => void>(),
    get: vi.fn((kind: LyricsSurfaceKind) => windows.get(kind)),
    isVisible: vi.fn((kind: LyricsSurfaceKind) => windows.has(kind)),
    restoreGeometry: vi.fn<(kind?: LyricsSurfaceKind) => Promise<void>>(async () => undefined),
    resetPosition: vi.fn<(kind: LyricsSurfaceKind) => Promise<void>>(async () => undefined),
    flushGeometry: vi.fn<(kind: LyricsSurfaceKind) => Promise<void>>(async () => undefined),
  };
}

function mockUnlock(): LyricsUnlockOverlays & {
  create: ReturnType<typeof vi.fn<(kind: LyricsUnlockKind) => LyricsUnlockWindow>>;
  show: ReturnType<typeof vi.fn<(kind: LyricsUnlockKind) => void>>;
  hide: ReturnType<typeof vi.fn<(kind: LyricsUnlockKind) => void>>;
  get: ReturnType<typeof vi.fn<(kind: LyricsUnlockKind) => LyricsUnlockWindow | undefined>>;
} {
  const windows = new Map<LyricsUnlockKind, LyricsUnlockWindow>();
  return {
    create: vi.fn((kind: LyricsUnlockKind) => {
      const existing = windows.get(kind);
      if (existing) {
        return existing;
      }
      const window = stubUnlockWindow();
      windows.set(kind, window);
      return window;
    }),
    show: vi.fn((kind: LyricsUnlockKind) => {
      if (!windows.has(kind)) {
        windows.set(kind, stubUnlockWindow());
      }
    }),
    hide: vi.fn<(kind: LyricsUnlockKind) => void>(),
    get: vi.fn((kind: LyricsUnlockKind) => windows.get(kind)),
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
    expect(isNativeWaylandSession('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' })).toBe(
      false,
    );
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
    expect(loginProviderFromParams({ loginProvider: 'qq' })).toBe('qq');
    expect(loginProviderFromParams({ loginProvider: 'wechat' })).toBe('wechat');
    expect(loginProviderFromParams({ loginProvider: 'phone' })).toBeUndefined();
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

  it('routes window chrome and host.coreStatus from main and denies lyrics', async () => {
    const chrome = {
      minimize: vi.fn(),
      toggleMaximize: vi.fn(),
      close: vi.fn(),
      setFullscreen: vi.fn(),
    };
    const handlers = createHostHandlers({
      openExternal: vi.fn(),
      lyrics: mockLyrics(),
      unlock: mockUnlock(),
      capabilities: () => lyricsSurfaceCapabilities({ platform: 'win32', nativeWayland: false }),
      showMainAndOpenSettings: vi.fn(),
      windowChrome: (id) => (id === 1 ? chrome : undefined),
      coreStatus: () => ({ status: 'ready' }),
    });
    const router = new IpcRouter({ methods, hostHandlers: handlers });
    router.registerWindow(1, 'main');
    router.registerWindow(2, 'lyrics-desktop');

    await expect(router.invoke(1, { method: WINDOW_MINIMIZE })).resolves.toEqual({
      ok: true,
      result: undefined,
    });
    expect(chrome.minimize).toHaveBeenCalledTimes(1);
    await expect(router.invoke(1, { method: WINDOW_TOGGLE_MAXIMIZE })).resolves.toEqual({
      ok: true,
      result: undefined,
    });
    expect(chrome.toggleMaximize).toHaveBeenCalledTimes(1);
    await expect(router.invoke(1, { method: WINDOW_CLOSE })).resolves.toEqual({
      ok: true,
      result: undefined,
    });
    expect(chrome.close).toHaveBeenCalledTimes(1);
    await expect(
      router.invoke(1, { method: WINDOW_SET_FULLSCREEN, params: { enabled: true } }),
    ).resolves.toEqual({ ok: true, result: undefined });
    expect(chrome.setFullscreen).toHaveBeenCalledWith(true);
    await expect(router.invoke(1, { method: HOST_CORE_STATUS })).resolves.toEqual({
      ok: true,
      result: { status: 'ready' },
    });

    chrome.minimize.mockClear();
    await expect(router.invoke(2, { method: WINDOW_MINIMIZE })).resolves.toEqual({
      ok: false,
      error: hostDenied(WINDOW_MINIMIZE, 'lyrics-desktop'),
    });
    expect(chrome.minimize).not.toHaveBeenCalled();
    await expect(router.invoke(2, { method: HOST_CORE_STATUS })).resolves.toEqual({
      ok: false,
      error: hostDenied(HOST_CORE_STATUS, 'lyrics-desktop'),
    });
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
    ).resolves.toEqual({ ok: true, result: undefined });
    expect(lyrics.resetPosition).toHaveBeenCalledWith('desktop');
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

  it('resolves relative diagnostics save paths under Downloads and appends .zip', async () => {
    const dialogs = mockDialogs({
      save: { canceled: false, filePath: 'report' },
      open: { canceled: true, filePaths: [] },
    });
    const handlers = createHostHandlers({
      openExternal: vi.fn(),
      lyrics: mockLyrics(),
      unlock: mockUnlock(),
      capabilities: () => lyricsSurfaceCapabilities({ platform: 'win32', nativeWayland: false }),
      showMainAndOpenSettings: vi.fn(),
      dialogs,
      downloadsDir: () => 'D:\\Downloads',
    });
    const router = new IpcRouter({ methods, hostHandlers: handlers });
    router.registerWindow(1, 'main');

    await expect(router.invoke(1, { method: DIALOG_PICK_SAVE })).resolves.toEqual({
      ok: true,
      result: path.join('D:\\Downloads', 'report.zip'),
    });
    expect(dialogs.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: path.join('D:\\Downloads', 'YAQMC-diagnostics.zip'),
      }),
    );
  });

  it('opens the Core log folder via shell.openPath and reveals existing zips', async () => {
    const logDir = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-logs-'));
    const openPath = vi.fn(async () => '');
    const showItemInFolder = vi.fn();
    const exists = vi.fn((target: string) => target.endsWith('YAQMC-diagnostics.zip'));
    const handlers = createHostHandlers({
      openExternal: vi.fn(),
      lyrics: mockLyrics(),
      unlock: mockUnlock(),
      capabilities: () => lyricsSurfaceCapabilities({ platform: 'win32', nativeWayland: false }),
      showMainAndOpenSettings: vi.fn(),
      folders: {
        logDir: () => logDir,
        openPath,
        showItemInFolder,
        exists,
      },
    });
    const router = new IpcRouter({ methods, hostHandlers: handlers });
    router.registerWindow(1, 'main');
    router.registerWindow(2, 'lyrics-desktop');

    await expect(router.invoke(1, { method: DIAGNOSTICS_OPEN_LOG_FOLDER })).resolves.toEqual({
      ok: true,
      result: logDir,
    });
    expect(openPath).toHaveBeenCalledWith(logDir);

    const zip = 'D:\\exports\\YAQMC-diagnostics.zip';
    await expect(
      router.invoke(1, { method: DIAGNOSTICS_REVEAL_BUNDLE, params: { path: zip } }),
    ).resolves.toEqual({ ok: true, result: undefined });
    expect(showItemInFolder).toHaveBeenCalledWith(path.resolve(zip));

    openPath.mockClear();
    showItemInFolder.mockClear();
    await expect(router.invoke(2, { method: DIAGNOSTICS_OPEN_LOG_FOLDER })).resolves.toEqual({
      ok: false,
      error: hostDenied(DIAGNOSTICS_OPEN_LOG_FOLDER, 'lyrics-desktop'),
    });
    expect(openPath).not.toHaveBeenCalled();
    await expect(
      router.invoke(2, { method: DIAGNOSTICS_REVEAL_BUNDLE, params: { path: zip } }),
    ).resolves.toEqual({
      ok: false,
      error: hostDenied(DIAGNOSTICS_REVEAL_BUNDLE, 'lyrics-desktop'),
    });
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it('surfaces openPath failures and rejects non-zip reveal targets', async () => {
    const logDir = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-logs-fail-'));
    const handlers = createHostHandlers({
      openExternal: vi.fn(),
      lyrics: mockLyrics(),
      unlock: mockUnlock(),
      capabilities: () => lyricsSurfaceCapabilities({ platform: 'win32', nativeWayland: false }),
      showMainAndOpenSettings: vi.fn(),
      folders: {
        logDir: () => logDir,
        openPath: async () => 'Failed to open',
        showItemInFolder: vi.fn(),
        exists: () => true,
      },
    });
    const router = new IpcRouter({ methods, hostHandlers: handlers });
    router.registerWindow(1, 'main');

    await expect(router.invoke(1, { method: DIAGNOSTICS_OPEN_LOG_FOLDER })).resolves.toMatchObject({
      ok: false,
      error: { message: 'Failed to open' },
    });
    await expect(
      router.invoke(1, {
        method: DIAGNOSTICS_REVEAL_BUNDLE,
        params: { path: 'D:\\Windows\\notepad.exe' },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { message: 'path is outside the log directory and is not an existing zip' },
    });
  });

  it('intercepts qqmusic_auth_oauth_start with an injected OAuth popup', async () => {
    const prepared = {
      attemptId: 'attempt-0',
      url: 'https://graph.qq.com/oauth2.0/show?client_id=1',
      navigationAllowlist: ['https://graph.qq.com/**'],
      callbackMatcher: { urlPrefix: 'https://y.qq.com/portal/wx_redirect.html' },
    };
    const snapshot = {
      state: 'waiting-for-confirmation',
      attemptId: 'attempt-0',
      ownerLeaseId: 'lease-0',
      expiresAtMs: 1,
      pollAfterMs: 1000,
      profile: null,
      entitlement: null,
      revision: 1,
      capabilities: {
        favoritesRead: true,
        favoritesWrite: true,
        playlistRead: true,
        playlistWrite: true,
        recentHistoryRead: true,
      },
    };
    const oauthWindow = {
      webContents: {
        on: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      },
      loadURL: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    };
    const createWindow = vi.fn<OAuthHostDeps['createWindow']>(() => oauthWindow);
    const fromPartition = vi.fn<OAuthHostDeps['fromPartition']>(() => ({
      partition: 'oauth-session',
    }));
    const invoke = vi.fn<OAuthHostDeps['invoke']>(async (method) => {
      if (method === 'auth_oauth_prepare') {
        return prepared;
      }
      if (method === 'qqmusic_account_snapshot') {
        return snapshot;
      }
      return { ok: true };
    });
    const handlers = createHostHandlers({
      openExternal: vi.fn(),
      lyrics: mockLyrics(),
      unlock: mockUnlock(),
      capabilities: () => lyricsSurfaceCapabilities({ platform: 'win32', nativeWayland: false }),
      showMainAndOpenSettings: vi.fn(),
      oauth: {
        createWindow,
        fromPartition,
        isPackaged: true,
        invoke,
      },
    });
    expect(createWindow).not.toHaveBeenCalled();
    expect(fromPartition).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();

    const router = new IpcRouter({ methods, hostHandlers: handlers });
    router.registerWindow(1, 'main');
    router.registerWindow(2, 'lyrics-desktop');

    await expect(
      router.invoke(1, { method: 'qqmusic_auth_oauth_start', params: { loginProvider: 'qq' } }),
    ).resolves.toEqual({ ok: true, result: snapshot });
    expect(invoke).toHaveBeenCalledWith('auth_oauth_prepare', { providerKind: 'qq' });
    expect(fromPartition).toHaveBeenCalledWith('oauth:attempt-0', { cache: false });
    expect(String(fromPartition.mock.calls[0]?.[0]).startsWith('persist:')).toBe(false);
    expect(createWindow).toHaveBeenCalledOnce();
    const createdOptions = createWindow.mock.calls[0]?.[0];
    expect(createdOptions).toMatchObject({
      width: 480,
      height: 640,
      show: true,
    });
    expect(createdOptions?.webPreferences).not.toHaveProperty('preload');
    expect(oauthWindow.loadURL).toHaveBeenCalledWith(prepared.url);
    expect(invoke).toHaveBeenCalledWith('qqmusic_account_snapshot');

    invoke.mockClear();
    createWindow.mockClear();
    await expect(
      router.invoke(2, { method: 'qqmusic_auth_oauth_start', params: { loginProvider: 'qq' } }),
    ).resolves.toEqual({
      ok: false,
      error: hostDenied('qqmusic_auth_oauth_start', 'lyrics-desktop'),
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(createWindow).not.toHaveBeenCalled();
  });

  it('leaves qqmusic_auth_oauth_start unimplemented until OAuth deps are injected', async () => {
    const handlers = createHostHandlers({
      openExternal: vi.fn(),
      lyrics: mockLyrics(),
      unlock: mockUnlock(),
      capabilities: () => lyricsSurfaceCapabilities({ platform: 'win32', nativeWayland: false }),
      showMainAndOpenSettings: vi.fn(),
    });
    const router = new IpcRouter({ methods, hostHandlers: handlers });
    router.registerWindow(1, 'main');
    await expect(
      router.invoke(1, { method: 'qqmusic_auth_oauth_start', params: { loginProvider: 'qq' } }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'host.denied',
        message: 'qqmusic_auth_oauth_start is implemented by the host',
        retryable: false,
      },
    });
  });

  it('injects hostPayload into diagnostics export before forwarding to core', async () => {
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
    const handlers = createHostHandlers({
      openExternal: vi.fn(),
      lyrics: mockLyrics(),
      unlock: mockUnlock(),
      capabilities: () => lyricsSurfaceCapabilities({ platform: 'win32', nativeWayland: false }),
      showMainAndOpenSettings: vi.fn(),
      downloadsDir: () => 'D:\\Downloads',
      coreInvoke,
      collectHostPayload: () => hostPayload,
      updater: {
        check: vi.fn(async () => ({ state: 'not-available' })),
        download: vi.fn(async () => ({ state: 'idle' })),
        install: vi.fn(async () => ({ state: 'idle' })),
      },
    });
    const router = new IpcRouter({ methods, hostHandlers: handlers });
    router.registerWindow(1, 'main');
    router.registerWindow(2, 'lyrics-desktop');

    await expect(
      router.invoke(1, {
        method: 'diagnostics_export_bundle_to',
        params: { path: 'D:\\out\\YAQMC-diagnostics.zip', request: { includeLogs: true } },
      }),
    ).resolves.toEqual({ ok: true, result: { path: 'D:\\out\\YAQMC-diagnostics.zip', bytes: 12 } });
    expect(coreInvoke).toHaveBeenCalledWith(
      'diagnostics_export_bundle_to',
      {
        path: 'D:\\out\\YAQMC-diagnostics.zip',
        request: { includeLogs: true, hostPayload },
      },
      'main',
    );

    coreInvoke.mockClear();
    await expect(
      router.invoke(1, {
        method: 'diagnostics_export_bundle_to',
        params: { path: 'report', request: { includeLogs: true } },
      }),
    ).resolves.toEqual({ ok: true, result: { path: 'D:\\out\\YAQMC-diagnostics.zip', bytes: 12 } });
    expect(coreInvoke).toHaveBeenCalledWith(
      'diagnostics_export_bundle_to',
      {
        path: path.join('D:\\Downloads', 'report.zip'),
        request: { includeLogs: true, hostPayload },
      },
      'main',
    );

    coreInvoke.mockClear();
    await expect(
      router.invoke(2, { method: 'diagnostics_export_bundle_to', params: { path: 'x' } }),
    ).resolves.toEqual({
      ok: false,
      error: hostDenied('diagnostics_export_bundle_to', 'lyrics-desktop'),
    });
    expect(coreInvoke).not.toHaveBeenCalled();

    await expect(router.invoke(1, { method: HOST_UPDATER_CHECK_METHOD })).resolves.toEqual({
      ok: true,
      result: { state: 'not-available' },
    });
  });

  it('hydrates managed background dataUri after the Core stdio continuation', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-bg-host-'));
    mkdirSync(path.join(dataDir, 'backgrounds'));
    const png = Buffer.from('\x89PNG\r\n\x1a\nrest', 'binary');
    writeFileSync(path.join(dataDir, 'backgrounds', 'custom-background.png'), png);
    const coreInvoke = vi.fn(async () => ({
      reference: 'backgrounds/custom-background.png',
      dataUri: '',
    }));
    const handlers = createHostHandlers({
      openExternal: vi.fn(),
      lyrics: mockLyrics(),
      unlock: mockUnlock(),
      capabilities: () => lyricsSurfaceCapabilities({ platform: 'win32', nativeWayland: false }),
      showMainAndOpenSettings: vi.fn(),
      coreInvoke,
      dataDir: () => dataDir,
    });
    const router = new IpcRouter({ methods, hostHandlers: handlers });
    router.registerWindow(1, 'main');

    await expect(
      router.invoke(1, {
        method: 'preferences_set_background_from',
        params: { path: 'D:\\Pictures\\wall.png' },
      }),
    ).resolves.toEqual({
      ok: true,
      result: {
        reference: 'backgrounds/custom-background.png',
        dataUri: `data:image/png;base64,${png.toString('base64')}`,
      },
    });
    expect(coreInvoke).toHaveBeenCalledWith(
      'preferences_set_background_from',
      { path: 'D:\\Pictures\\wall.png' },
      'main',
    );
  });

  it('leaves the 32 MiB hard cap unchanged', () => {
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});
