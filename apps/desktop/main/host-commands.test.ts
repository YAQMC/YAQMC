import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CHANNEL_HOST_COMMAND, FRAME_HARD_CAP_BYTES, type PlatformAttach } from '@yaqmc/client';
import {
  buildPlatformAttach,
  handleHostCommand,
  nativeWindowHandleHex,
  raiseMainWindow,
  subscribeHostCommands,
} from './host-commands';

function hwndBuffer(value: bigint): Buffer {
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(value);
  return handle;
}

describe('handleHostCommand', () => {
  it('raises the main window and quits without opening OAuth', () => {
    const raise = vi.fn();
    const quit = vi.fn();
    handleHostCommand({ command: 'raise' }, { raiseMainWindow: raise, quit });
    handleHostCommand({ command: 'quit' }, { raiseMainWindow: raise, quit });
    handleHostCommand({ surfaceAutoHide: true }, { raiseMainWindow: raise, quit });
    expect(raise).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('unwraps host://command event frames', () => {
    const raise = vi.fn();
    handleHostCommand(
      { channel: CHANNEL_HOST_COMMAND, payload: { command: 'raise' } },
      { raiseMainWindow: raise, quit: vi.fn() },
    );
    expect(raise).toHaveBeenCalledTimes(1);
  });
});

describe('raiseMainWindow', () => {
  it('restores a minimized window then show/focus', () => {
    const window = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    raiseMainWindow(window);
    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it('skips destroyed windows', () => {
    const window = {
      isDestroyed: () => true,
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    raiseMainWindow(window);
    raiseMainWindow(undefined);
    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
  });
});

describe('subscribeHostCommands', () => {
  it('handles raise/quit on the host://command stream and unsubscribes', () => {
    const client = new EventEmitter();
    const raise = vi.fn();
    const quit = vi.fn();
    const unsubscribe = subscribeHostCommands(client, { raiseMainWindow: raise, quit });

    client.emit(CHANNEL_HOST_COMMAND, { command: 'raise' });
    client.emit('event', {
      kind: 'event',
      seq: 1,
      channel: CHANNEL_HOST_COMMAND,
      payload: { command: 'quit' },
    });
    client.emit(CHANNEL_HOST_COMMAND, { surfaceAutoHide: true });
    expect(raise).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);

    unsubscribe();
    client.emit(CHANNEL_HOST_COMMAND, { command: 'raise' });
    expect(raise).toHaveBeenCalledTimes(1);
  });
});

describe('buildPlatformAttach', () => {
  it('sends a Windows HWND hex from the injected getNativeWindowHandle', () => {
    const attach: PlatformAttach = buildPlatformAttach({
      platform: 'win32',
      getNativeWindowHandle: () => hwndBuffer(0x123456n),
    });
    expect(attach).toEqual({
      platformKind: 'windows',
      mainWindowHandle: '0000000000123456',
    });
    expect(nativeWindowHandleHex(hwndBuffer(0x123456n))).toBe('0000000000123456');
  });

  it('omits the native handle on Linux and in smoke', () => {
    const reader = vi.fn(() => hwndBuffer(0x123456n));
    expect(
      buildPlatformAttach({
        platform: 'linux',
        nativeWayland: false,
        getNativeWindowHandle: reader,
      }),
    ).toEqual({ platformKind: 'linux', displayBackend: 'x11' });
    expect(
      buildPlatformAttach({
        platform: 'linux',
        nativeWayland: true,
        getNativeWindowHandle: reader,
      }),
    ).toEqual({ platformKind: 'linux', displayBackend: 'wayland' });
    expect(
      buildPlatformAttach({
        platform: 'win32',
        smoke: true,
        getNativeWindowHandle: reader,
      }),
    ).toEqual({ platformKind: 'windows' });
    expect(reader).not.toHaveBeenCalled();
  });

  it('omits the handle when getNativeWindowHandle throws', () => {
    expect(
      buildPlatformAttach({
        platform: 'win32',
        getNativeWindowHandle: () => {
          throw new Error('no hwnd');
        },
      }),
    ).toEqual({ platformKind: 'windows' });
  });

  it('leaves the 32 MiB hard cap unchanged', () => {
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});
