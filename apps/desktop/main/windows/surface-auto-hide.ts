import { CHANNEL_HOST_COMMAND } from '@yaqmc/client';
import type { LyricsSurfaceKind, LyricsSurfaces } from './lyrics-surfaces';

const SURFACE_KINDS: readonly LyricsSurfaceKind[] = ['desktop', 'island'];

export type ParsedHostCommand =
  | { kind: 'surfaceAutoHide'; hidden: boolean }
  | { kind: 'raise' }
  | { kind: 'quit' };

/**
 * Surfaces plus optional per-kind flags. `enabled` / `hideInFullscreen`
 * (and snake_case `hide_in_fullscreen`) are read when present; SURF-01/03
 * helpers do not currently store them, so auto-hide then applies to both.
 */
export type SurfaceAutoHideTarget = Pick<LyricsSurfaces, 'show' | 'hide' | 'get'> & {
  isVisible?(kind: LyricsSurfaceKind): boolean;
  enabled?(kind: LyricsSurfaceKind): boolean;
  hideInFullscreen?(kind: LyricsSurfaceKind): boolean;
  hide_in_fullscreen?(kind: LyricsSurfaceKind): boolean;
};

export type SurfaceAutoHideClient = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
};

type VisibilitySnapshot = Record<LyricsSurfaceKind, boolean>;

const snapshots = new WeakMap<object, VisibilitySnapshot>();

/**
 * Accepted `host://command` payloads:
 * `{ surfaceAutoHide: boolean }` (plan §22.2)
 * `{ command: "raise" | "quit" }` (protocol fixtures)
 *
 * Also unwraps a Core event frame `{ channel: "host://command", payload }`.
 */
export function parseHostCommandPayload(payload: unknown): ParsedHostCommand | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (record.channel === CHANNEL_HOST_COMMAND && 'payload' in record) {
    return parseHostCommandPayload(record.payload);
  }
  if (typeof record.surfaceAutoHide === 'boolean') {
    return { kind: 'surfaceAutoHide', hidden: record.surfaceAutoHide };
  }
  if (record.command === 'raise') {
    return { kind: 'raise' };
  }
  if (record.command === 'quit') {
    return { kind: 'quit' };
  }
  return undefined;
}

export function handleSurfaceHostCommand(
  surfaces: SurfaceAutoHideTarget,
  payload: unknown,
): void {
  const parsed = parseHostCommandPayload(payload);
  if (parsed?.kind !== 'surfaceAutoHide') {
    return;
  }
  applySurfaceAutoHide(surfaces, parsed.hidden);
}

/** Listener that can be attached as `client.on('host://command', listener)`. */
export function surfaceAutoHideListener(
  surfaces: SurfaceAutoHideTarget,
): (payload: unknown) => void {
  return (payload) => handleSurfaceHostCommand(surfaces, payload);
}

/**
 * Hide or restore desktop+island without destroying windows.
 * Cadence (800 ms) is core-side; this consumer only reacts to payloads.
 */
export function applySurfaceAutoHide(surfaces: SurfaceAutoHideTarget, hidden: boolean): void {
  if (hidden) {
    if (!snapshots.has(surfaces)) {
      snapshots.set(surfaces, {
        desktop: readVisible(surfaces, 'desktop'),
        island: readVisible(surfaces, 'island'),
      });
    }
    for (const kind of SURFACE_KINDS) {
      if (!shouldHideForFullscreen(surfaces, kind)) {
        continue;
      }
      surfaces.hide(kind);
    }
    return;
  }
  const snapshot = snapshots.get(surfaces);
  snapshots.delete(surfaces);
  if (!snapshot) {
    return;
  }
  for (const kind of SURFACE_KINDS) {
    if (snapshot[kind]) {
      surfaces.show(kind);
    }
  }
}

/**
 * Subscribe to CoreClient `host://command` and to `event` frames with that
 * channel (current CoreClient demuxes as `event`, not per-channel names).
 * Returns an unsubscribe function. Index wiring is ACCT-01.
 */
export function subscribeSurfaceAutoHide(
  client: SurfaceAutoHideClient,
  surfaces: SurfaceAutoHideTarget,
): () => void {
  const onCommand = surfaceAutoHideListener(surfaces);
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

function readVisible(surfaces: SurfaceAutoHideTarget, kind: LyricsSurfaceKind): boolean {
  if (typeof surfaces.isVisible === 'function') {
    return surfaces.isVisible(kind);
  }
  return surfaces.get(kind) !== undefined;
}

function shouldHideForFullscreen(
  surfaces: SurfaceAutoHideTarget,
  kind: LyricsSurfaceKind,
): boolean {
  if (surfaces.enabled?.(kind) === false) {
    return false;
  }
  if (surfaces.hideInFullscreen?.(kind) === false) {
    return false;
  }
  if (surfaces.hide_in_fullscreen?.(kind) === false) {
    return false;
  }
  return true;
}

function detach(
  client: SurfaceAutoHideClient,
  event: string,
  listener: (...args: unknown[]) => void,
): void {
  if (typeof client.off === 'function') {
    client.off(event, listener);
    return;
  }
  client.removeListener?.(event, listener);
}
