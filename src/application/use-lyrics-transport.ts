import { useSyncExternalStore } from 'react';
import {
  resolveLyricsTransport,
  subscribeTransportCatalog,
  transportCatalogVersion,
  type ResolvedLyricsTransportDefinition,
  type LyricsTransportSurface,
} from './lyrics-transport';
import { usePreferencesStore } from './preferences';

/**
 * Resolves the configured transport bar for a surface.
 *
 * Plugin load/unload and permission revocation bump the catalog version, so the
 * bar re-resolves immediately instead of keeping a stale or unauthorized
 * declaration; unknown or revoked selections fall back to the built-in preset.
 */
export function useLyricsTransportDefinition(
  surface: LyricsTransportSurface,
): ResolvedLyricsTransportDefinition {
  const transport = usePreferencesStore((state) => state.transport);
  useSyncExternalStore(subscribeTransportCatalog, transportCatalogVersion, () => 0);
  return resolveLyricsTransport(transport, surface);
}
