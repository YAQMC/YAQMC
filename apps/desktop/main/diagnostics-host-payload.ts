/**
 * DIAG-01 host collector. Pure: no Electron imports, no process reads.
 * Main injects version strings, window list, display facts, updater state,
 * restart counter, and an optional host-log tail.
 */

import type {
  DiagnosticsHostDisplay,
  DiagnosticsHostPayload,
  DiagnosticsHostUpdater,
  DiagnosticsHostWindowState,
} from '@yaqmc/client';

export const HOST_PAYLOAD_SCHEMA_VERSION = 1;
/** Matches the supervisor stderr ring (section 11.1 / SUP-04). */
export const HOST_LOG_TAIL_MAX_BYTES = 64 * 1024;

export type ProcessVersionsInput = {
  electron?: string;
  chrome?: string;
  node?: string;
};

export type CollectDiagnosticsHostPayloadInput = {
  versions: ProcessVersionsInput;
  windows: readonly DiagnosticsHostWindowState[];
  display: DiagnosticsHostDisplay;
  updater: DiagnosticsHostUpdater;
  restartCounter: number;
  log?: string;
};

export function collectDiagnosticsHostPayload(
  input: CollectDiagnosticsHostPayloadInput,
): DiagnosticsHostPayload {
  const payload: DiagnosticsHostPayload = {
    schemaVersion: HOST_PAYLOAD_SCHEMA_VERSION,
    electron: input.versions.electron ?? '',
    chrome: input.versions.chrome ?? '',
    node: input.versions.node ?? '',
    windows: input.windows.map(copyWindow),
    display: {
      backend: input.display.backend,
      capabilities: {
        alwaysOnTop: input.display.capabilities.alwaysOnTop,
        clickThrough: input.display.capabilities.clickThrough,
        globalShortcuts: input.display.capabilities.globalShortcuts,
        transparency: input.display.capabilities.transparency,
      },
    },
    updater: copyUpdater(input.updater),
    restartCounter: input.restartCounter,
  };
  if (typeof input.log === 'string' && input.log.length > 0) {
    payload.log = tailUtf8(input.log, HOST_LOG_TAIL_MAX_BYTES);
  }
  return payload;
}

function copyWindow(window: DiagnosticsHostWindowState): DiagnosticsHostWindowState {
  const next: DiagnosticsHostWindowState = {
    id: window.id,
    role: window.role,
    visible: window.visible,
  };
  if (window.focused !== undefined) {
    next.focused = window.focused;
  }
  if (window.bounds !== undefined) {
    next.bounds = {
      x: window.bounds.x,
      y: window.bounds.y,
      width: window.bounds.width,
      height: window.bounds.height,
    };
  }
  if (window.alwaysOnTop !== undefined) {
    next.alwaysOnTop = window.alwaysOnTop;
  }
  return next;
}

function copyUpdater(updater: DiagnosticsHostUpdater): DiagnosticsHostUpdater {
  const next: DiagnosticsHostUpdater = { state: updater.state };
  if (updater.canInstall !== undefined) {
    next.canInstall = updater.canInstall;
  }
  if (updater.allowPrerelease !== undefined) {
    next.allowPrerelease = updater.allowPrerelease;
  }
  if (updater.channel !== undefined) {
    next.channel = updater.channel;
  }
  if (updater.version !== undefined) {
    next.version = updater.version;
  }
  if (updater.releaseUrl !== undefined) {
    next.releaseUrl = updater.releaseUrl;
  }
  if (updater.error !== undefined) {
    next.error = updater.error;
  }
  return next;
}

function tailUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maxBytes) {
    return value;
  }
  let slice = encoded.subarray(encoded.length - maxBytes);
  while (slice.length > 0 && ((slice[0] ?? 0) & 0xc0) === 0x80) {
    slice = slice.subarray(1);
  }
  return slice.toString('utf8');
}
