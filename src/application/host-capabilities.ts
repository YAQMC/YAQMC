import type { HostBridge, HostCapabilities } from '@yaqmc/client';
import { defaultHostCapabilities } from '@yaqmc/client';
import { getHostBridge } from './yaqmc-runtime';

/** Central capability gate for renderer features owned by a host. */
export function hostCapabilities(): HostCapabilities {
  const bridge = getHostBridge();
  return bridge.capabilities ?? defaultHostCapabilities(bridge.kind);
}

export function hasHostCapability(capability: keyof HostCapabilities): boolean {
  return Boolean(hostCapabilities()[capability]);
}

export function isAndroidRuntime(): boolean {
  return getHostBridge().kind === 'android';
}

export function isAndroidPhoneRuntime(
  kind: HostBridge['kind'] = getHostBridge().kind,
  display: Pick<Screen, 'width' | 'height'> | null = typeof globalThis.screen === 'undefined'
    ? null
    : globalThis.screen,
): boolean {
  if (kind !== 'android' || !display) return false;
  const smallestWidth = Math.min(display.width, display.height);
  return Number.isFinite(smallestWidth) && smallestWidth > 0 && smallestWidth < 600;
}

export function supportsWindowControls(): boolean {
  return hostCapabilities().windowControls;
}

export function supportsLyricsSurfaces(): boolean {
  return hostCapabilities().lyricsSurfaces;
}
