import {
  CHANNEL_HOST_COMMAND,
  type DisplayBackend,
  type PlatformAttach,
  type PlatformKind,
} from '@yaqmc/client';
import { hostPlatformKind } from './core/supervisor';
import { parseHostCommandPayload } from './windows/surface-auto-hide';

export type HostCommandActions = {
  raiseMainWindow: () => void;
  quit: () => void;
};

export type HostCommandClient = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
};

export type RaiseableWindow = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
};

export type PlatformAttachOptions = {
  platform?: NodeJS.Platform | string;
  smoke?: boolean;
  nativeWayland?: boolean;
  getNativeWindowHandle?: () => Buffer;
};

/**
 * `{command:"raise"}` shows/focuses/restores the main window (no OAuth).
 * `{command:"quit"}` calls `actions.quit` (caller sets `stopping` then `app.quit()`).
 * `surfaceAutoHide` is owned by `subscribeSurfaceAutoHide`.
 */
export function handleHostCommand(payload: unknown, actions: HostCommandActions): void {
  const parsed = parseHostCommandPayload(payload);
  if (parsed?.kind === 'raise') {
    actions.raiseMainWindow();
    return;
  }
  if (parsed?.kind === 'quit') {
    actions.quit();
  }
}

export function raiseMainWindow(window: RaiseableWindow | undefined): void {
  if (!window || window.isDestroyed()) {
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
}

export function subscribeHostCommands(
  client: HostCommandClient,
  actions: HostCommandActions,
): () => void {
  const onCommand = (payload: unknown) => handleHostCommand(payload, actions);
  const onEvent = (frame: unknown) => {
    if (!frame || typeof frame !== 'object') {
      return;
    }
    const record = frame as { channel?: unknown; payload?: unknown };
    if (record.channel === CHANNEL_HOST_COMMAND) {
      onCommand(record.payload);
    }
  };
  client.on(CHANNEL_HOST_COMMAND, onCommand);
  client.on('event', onEvent);
  return () => {
    detach(client, CHANNEL_HOST_COMMAND, onCommand);
    detach(client, 'event', onEvent);
  };
}

/** HWND / pointer Buffer → hex, matching protocol fixtures (`0000000000123456`). */
export function nativeWindowHandleHex(handle: Buffer): string {
  if (handle.length >= 8) {
    return handle.readBigUInt64LE(0).toString(16).padStart(16, '0');
  }
  if (handle.length >= 4) {
    return handle.readUInt32LE(0).toString(16).padStart(16, '0');
  }
  return Buffer.from(handle).toString('hex');
}

/**
 * PLAT-04 host half. Windows may send `mainWindowHandle`; Linux omits it.
 * Smoke skips the native-handle read. Does not claim SMTC/MPRIS.
 */
export function buildPlatformAttach(options: PlatformAttachOptions = {}): PlatformAttach {
  const platform = options.platform ?? process.platform;
  const platformKind: PlatformKind = hostPlatformKind(platform);
  const attach: PlatformAttach = { platformKind };
  if (platformKind === 'linux') {
    const displayBackend: DisplayBackend = options.nativeWayland ? 'wayland' : 'x11';
    attach.displayBackend = displayBackend;
  }
  if (options.smoke || platformKind !== 'windows' || !options.getNativeWindowHandle) {
    return attach;
  }
  try {
    attach.mainWindowHandle = nativeWindowHandleHex(options.getNativeWindowHandle());
  } catch {
    // Headless / missing HWND — still send platformKind.
  }
  return attach;
}

function detach(
  client: HostCommandClient,
  event: string,
  listener: (...args: unknown[]) => void,
): void {
  if (typeof client.off === 'function') {
    client.off(event, listener);
    return;
  }
  client.removeListener?.(event, listener);
}
