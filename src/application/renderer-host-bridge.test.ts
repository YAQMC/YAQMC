import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelName } from '@yaqmc/client';
import { selectHostBridge, windowRoleFromSearch } from './renderer-host-bridge';

describe('windowRoleFromSearch', () => {
  it('classifies surface and unlock query params', () => {
    expect(windowRoleFromSearch('')).toBe('main');
    expect(windowRoleFromSearch('?surface=desktop')).toBe('lyrics-desktop');
    expect(windowRoleFromSearch('?surface=island')).toBe('lyrics-island');
    expect(windowRoleFromSearch('?unlockSurface=desktop')).toBe('unlock-desktop');
    expect(windowRoleFromSearch('?unlockSurface=island')).toBe('unlock-island');
    expect(windowRoleFromSearch('?unlockSurface=desktop&surface=island')).toBe('unlock-desktop');
    expect(windowRoleFromSearch('?surface=other')).toBe('main');
  });
});

describe('selectHostBridge', () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, 'yaqmc');
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'yaqmc');
  });

  it('keeps ?provider=fake on createFakeBridge even when window.yaqmc is present', () => {
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

  it('routes private dialog methods through window.yaqmc.invoke', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce('D:\\exports\\YAQMC-diagnostics.zip')
      .mockResolvedValueOnce('D:\\plugins\\sample.yaqmc-plugin');
    Reflect.set(window, 'yaqmc', { invoke, on: vi.fn(() => () => undefined) });

    const bridge = selectHostBridge('');
    await expect(bridge.dialog?.pickSave({ defaultPath: 'YAQMC-diagnostics.zip' })).resolves.toBe(
      'D:\\exports\\YAQMC-diagnostics.zip',
    );
    await expect(bridge.dialog?.pickFile({ kind: 'plugin-package' })).resolves.toBe(
      'D:\\plugins\\sample.yaqmc-plugin',
    );
    expect(invoke).toHaveBeenCalledWith('dialog.pickSave', {
      defaultPath: 'YAQMC-diagnostics.zip',
    });
    expect(invoke).toHaveBeenCalledWith('dialog.pickFile', { kind: 'plugin-package' });
  });

  it('falls back to createFakeBridge outside Electron', async () => {
    const bridge = selectHostBridge('?unlockSurface=island');
    expect(bridge.kind).toBe('fake');
    expect(bridge.windowRole).toBe('unlock-island');
    await expect(bridge.dialog?.pickSave()).resolves.toBe(null);
    await expect(bridge.dialog?.pickFile({ kind: 'background-image' })).resolves.toBe(null);
  });
});
