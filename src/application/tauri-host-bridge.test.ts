import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { YaqmcClient } from '@yaqmc/client';
import type { ChannelName } from '@yaqmc/client';

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
  listen: vi.fn(),
  minimize: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  setFullscreen: vi.fn().mockResolvedValue(undefined),
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
  isTauri: () => tauriMocks.isTauri(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: tauriMocks.listen,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: tauriMocks.minimize,
    toggleMaximize: tauriMocks.toggleMaximize,
    close: tauriMocks.close,
    setFullscreen: tauriMocks.setFullscreen,
  }),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: tauriMocks.openUrl,
}));

import {
  createTauriHostBridge,
  selectHostBridge,
  windowRoleFromSearch,
} from './tauri-host-bridge';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('windowRoleFromSearch', () => {
  it('classifies surface and unlock query params the same way as main.tsx', () => {
    expect(windowRoleFromSearch('')).toBe('main');
    expect(windowRoleFromSearch('?surface=desktop')).toBe('lyrics-desktop');
    expect(windowRoleFromSearch('?surface=island')).toBe('lyrics-island');
    expect(windowRoleFromSearch('?unlockSurface=desktop')).toBe('unlock-desktop');
    expect(windowRoleFromSearch('?unlockSurface=island')).toBe('unlock-island');
    expect(windowRoleFromSearch('?unlockSurface=desktop&surface=island')).toBe('unlock-desktop');
    expect(windowRoleFromSearch('?surface=other')).toBe('main');
  });
});

describe('createTauriHostBridge', () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    tauriMocks.invoke.mockResolvedValue({ ok: true });
    tauriMocks.listen.mockReset();
    tauriMocks.listen.mockResolvedValue(() => undefined);
    tauriMocks.minimize.mockClear();
    tauriMocks.toggleMaximize.mockClear();
    tauriMocks.close.mockClear();
    tauriMocks.setFullscreen.mockClear();
    tauriMocks.openUrl.mockClear();
  });

  it('maps invoke params through in the current frontend shape', async () => {
    const bridge = createTauriHostBridge();
    expect(bridge.kind).toBe('tauri');
    expect(bridge.windowRole).toBe('main');

    await bridge.invoke('player_play');
    expect(tauriMocks.invoke).toHaveBeenCalledWith('player_play');

    await bridge.invoke('player_seek', { positionMs: 4800 });
    expect(tauriMocks.invoke).toHaveBeenCalledWith('player_seek', { positionMs: 4800 });

    await bridge.invoke('player_play_tracks', {
      request: { tracks: [], startAtId: null, shuffle: null },
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith('player_play_tracks', {
      request: { tracks: [], startAtId: null, shuffle: null },
    });
  });

  it('unwraps Tauri event payloads and unsubscribes', async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    tauriMocks.listen.mockImplementation(async (channel: string, handler) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    });

    const bridge = createTauriHostBridge();
    const seen: number[] = [];
    const stop = bridge.listen('player://snapshot', (payload) => {
      seen.push(payload.positionMs);
    });
    await Promise.resolve();

    handlers.get('player://snapshot')?.({
      payload: { positionMs: 1200 },
    });
    expect(seen).toEqual([1200]);

    stop();
    handlers.get('player://snapshot')?.({
      payload: { positionMs: 2400 },
    });
    expect(seen).toEqual([1200]);
  });

  it('unsubscribes even if listen resolves after cancel', async () => {
    const pending = deferred<() => void>();
    tauriMocks.listen.mockReturnValueOnce(pending.promise);
    const bridge = createTauriHostBridge();
    const stop = bridge.listen('player://snapshot', () => undefined);
    const unlisten = vi.fn();
    stop();
    pending.resolve(unlisten);
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('forwards window and shell calls to the current Tauri APIs', async () => {
    const bridge = createTauriHostBridge('lyrics-desktop');
    expect(bridge.windowRole).toBe('lyrics-desktop');
    await bridge.window.minimize();
    await bridge.window.toggleMaximize();
    await bridge.window.close();
    await bridge.window.setFullscreen(true);
    await bridge.shell.openExternal('https://example.invalid/docs');
    expect(tauriMocks.minimize).toHaveBeenCalledTimes(1);
    expect(tauriMocks.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(tauriMocks.close).toHaveBeenCalledTimes(1);
    expect(tauriMocks.setFullscreen).toHaveBeenCalledWith(true);
    expect(tauriMocks.openUrl).toHaveBeenCalledWith('https://example.invalid/docs');
  });

  it('leaves dialog.pickSave unused (returns null without Tauri invoke)', async () => {
    const bridge = createTauriHostBridge();
    await expect(bridge.dialog?.pickSave({ defaultPath: 'YAQMC-diagnostics.zip' })).resolves.toBe(null);
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it('constructs YaqmcClient over the Tauri adapter', async () => {
    tauriMocks.invoke.mockResolvedValue({ ok: true });
    const bridge = createTauriHostBridge();
    const client = new YaqmcClient(bridge);
    client.markReady();
    await expect(client.invoke('core_ping')).resolves.toEqual({ ok: true });
    expect(tauriMocks.invoke).toHaveBeenCalledWith('core_ping');
    client.dispose();
  });
});

describe('selectHostBridge', () => {
  beforeEach(() => {
    tauriMocks.isTauri.mockReturnValue(false);
    tauriMocks.listen.mockReset();
    tauriMocks.listen.mockResolvedValue(() => undefined);
    tauriMocks.invoke.mockReset();
    tauriMocks.invoke.mockResolvedValue(undefined);
    Reflect.deleteProperty(window, 'yaqmc');
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'yaqmc');
    tauriMocks.isTauri.mockReturnValue(false);
  });

  it('keeps ?provider=fake on createFakeBridge even when Tauri or window.yaqmc is present', () => {
    tauriMocks.isTauri.mockReturnValue(true);
    Reflect.set(window, 'yaqmc', {
      invoke: vi.fn(),
      on: vi.fn(() => () => undefined),
    });
    const bridge = selectHostBridge('?provider=fake&surface=desktop');
    expect(bridge.kind).toBe('fake');
    expect(bridge.windowRole).toBe('lyrics-desktop');
  });

  it('wraps window.yaqmc.invoke/on without inventing a second protocol', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const listeners = new Map<string, (payload: unknown) => void>();
    const on = vi.fn((channel: string, handler: (payload: unknown) => void) => {
      listeners.set(channel, handler);
      return () => listeners.delete(channel);
    });
    Reflect.set(window, 'yaqmc', { invoke, on });

    const bridge = selectHostBridge('?surface=island');
    expect(bridge.kind).toBe('electron');
    expect(bridge.windowRole).toBe('lyrics-island');

    await bridge.invoke('player_play');
    expect(invoke).toHaveBeenCalledWith('player_play');
    await bridge.invoke('plugin_install', { request: { path: 'plugin.zip' } });
    expect(invoke).toHaveBeenCalledWith('plugin_install', { request: { path: 'plugin.zip' } });

    const seen: ChannelName[] = [];
    const stop = bridge.listen('plugin://changed', () => {
      seen.push('plugin://changed');
    });
    listeners.get('plugin://changed')?.({ pluginId: 'dev.example', enabled: true });
    expect(seen).toEqual(['plugin://changed']);
    stop();
    expect(on).toHaveBeenCalledWith('plugin://changed', expect.any(Function));
  });

  it('routes window chrome and shell.openExternal through window.yaqmc.invoke', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    Reflect.set(window, 'yaqmc', { invoke, on: vi.fn(() => () => undefined) });

    const bridge = selectHostBridge('');
    expect(bridge.kind).toBe('electron');
    await bridge.window.minimize();
    await bridge.window.toggleMaximize();
    await bridge.window.close();
    await bridge.window.setFullscreen(true);
    await bridge.shell.openExternal('https://github.com/YAQMC/YAQMC');
    expect(invoke).toHaveBeenCalledWith('window.minimize');
    expect(invoke).toHaveBeenCalledWith('window.toggleMaximize');
    expect(invoke).toHaveBeenCalledWith('window.close');
    expect(invoke).toHaveBeenCalledWith('window.setFullscreen', { enabled: true });
    expect(invoke).toHaveBeenCalledWith('shell.openExternal', {
      url: 'https://github.com/YAQMC/YAQMC',
    });
  });

  it('routes dialog.pickSave through window.yaqmc.invoke, not inventory MethodName', async () => {
    const invoke = vi.fn().mockResolvedValue('D:\\exports\\YAQMC-diagnostics.zip');
    Reflect.set(window, 'yaqmc', { invoke, on: vi.fn(() => () => undefined) });

    const bridge = selectHostBridge('');
    expect(bridge.kind).toBe('electron');
    await expect(
      bridge.dialog?.pickSave({ defaultPath: 'YAQMC-diagnostics.zip' }),
    ).resolves.toBe('D:\\exports\\YAQMC-diagnostics.zip');
    expect(invoke).toHaveBeenCalledWith('dialog.pickSave', { defaultPath: 'YAQMC-diagnostics.zip' });
  });

  it('selects TauriHostBridge when isTauri() and window.yaqmc is absent', () => {
    tauriMocks.isTauri.mockReturnValue(true);
    const bridge = selectHostBridge('?unlockSurface=island');
    expect(bridge.kind).toBe('tauri');
    expect(bridge.windowRole).toBe('unlock-island');
  });

  it('falls back to createFakeBridge outside Tauri and Electron', async () => {
    const bridge = selectHostBridge('');
    expect(bridge.kind).toBe('fake');
    expect(bridge.windowRole).toBe('main');
    await expect(bridge.dialog?.pickSave()).resolves.toBe(null);
  });
});
