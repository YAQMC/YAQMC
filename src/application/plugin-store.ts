import type { PluginStoreAsset, PluginStoreRelease, PluginStoreRepository } from '@yaqmc/client';
import type { PluginRecord } from './plugin-runtime';

export type StorePlatform = 'android' | 'windows' | 'linux' | 'macos';

const PLATFORM_TOKENS: Record<StorePlatform, readonly string[]> = {
  android: ['android'],
  windows: ['windows', 'win64', 'win32'],
  linux: ['linux'],
  macos: ['macos', 'darwin', 'osx'],
};

function platformsNamedBy(assetName: string): StorePlatform[] {
  const tokens = assetName.toLowerCase().split(/[^a-z0-9]+/);
  return (Object.keys(PLATFORM_TOKENS) as StorePlatform[]).filter((platform) =>
    PLATFORM_TOKENS[platform].some((token) => tokens.includes(token)),
  );
}

/**
 * Preselects an asset only when the choice is unambiguous: the single package, or
 * the single package whose name targets this platform. Names are hints only; the
 * downloaded manifest decides compatibility. Returns null when the user must choose.
 */
export function defaultStoreAsset(
  assets: readonly PluginStoreAsset[],
  platform: StorePlatform | null,
): PluginStoreAsset | null {
  const named = assets.map((asset) => ({ asset, platforms: platformsNamedBy(asset.name) }));
  const [only] = named;
  if (!only) return null;
  if (named.length === 1) {
    // A package explicitly named for other platforms is never the default.
    return only.platforms.length > 0 && platform && !only.platforms.includes(platform)
      ? null
      : only.asset;
  }
  if (!platform) return null;
  const matches = named.filter((candidate) => candidate.platforms.includes(platform));
  return matches.length === 1 ? (matches[0]?.asset ?? null) : null;
}

/** Store installs record `github:owner/repo/releases/<id>` as their plugin source. */
export function storeSourceRepository(
  source: string,
): { repository: string; releaseId: number | null } | null {
  const match = /^github:([^/]+\/[^/]+)(?:\/releases\/(\d+))?$/.exec(source);
  if (!match?.[1]) return null;
  return { repository: match[1].toLowerCase(), releaseId: match[2] ? Number(match[2]) : null };
}

export interface StoreInstallState {
  /** Installed plugins whose recorded source is this repository. */
  installed: PluginRecord[];
  /** Newest stable release with packages is newer than every installed release. */
  candidateUpdate: boolean;
}

export function storeInstallState(
  repository: Pick<PluginStoreRepository, 'fullName'>,
  plugins: readonly PluginRecord[],
  latest: PluginStoreRelease | null,
): StoreInstallState {
  const fullName = repository.fullName.toLowerCase();
  const installed = plugins.filter(
    (plugin) => storeSourceRepository(plugin.source)?.repository === fullName,
  );
  const installedReleases = installed
    .map((plugin) => storeSourceRepository(plugin.source)?.releaseId ?? null)
    .filter((id): id is number => id !== null);
  // Release ids grow monotonically on GitHub; tags are not compared as versions.
  const candidateUpdate =
    installed.length > 0 &&
    latest !== null &&
    latest.assets.length > 0 &&
    installedReleases.every((id) => latest.id > id);
  return { installed, candidateUpdate };
}

export function latestInstallableRelease(
  releases: readonly PluginStoreRelease[],
): PluginStoreRelease | null {
  return releases.find((release) => release.assets.length > 0) ?? null;
}

export type StoreErrorKind =
  | 'rate-limited'
  | 'offline'
  | 'timeout'
  | 'not-found'
  | 'invalid-query'
  | 'not-plugin-repository'
  | 'asset-unavailable'
  | 'asset-too-large'
  | 'digest-mismatch'
  | 'cancelled'
  | 'other';

export interface StoreError {
  kind: StoreErrorKind;
  /** Epoch milliseconds when GitHub allows requests again, if known. */
  resetAtMs?: number;
  detail: string;
}

const STORE_ERROR_KINDS: Record<string, StoreErrorKind> = {
  'store-offline': 'offline',
  'store-timeout': 'timeout',
  'store-not-found': 'not-found',
  'store-invalid-query': 'invalid-query',
  'store-invalid-repository': 'not-found',
  'store-not-a-plugin-repository': 'not-plugin-repository',
  'store-release-unavailable': 'asset-unavailable',
  'store-asset-unavailable': 'asset-unavailable',
  'store-asset-too-large': 'asset-too-large',
  'update-size-mismatch': 'asset-too-large',
  'store-asset-digest-mismatch': 'digest-mismatch',
  'update-hash-mismatch': 'digest-mismatch',
  'store-cancelled': 'cancelled',
  'update-cancelled': 'cancelled',
  'update-download-timeout': 'timeout',
  'update-download-failed': 'offline',
  'update-dns-failed': 'offline',
  'update-dns-timeout': 'timeout',
};

/** Maps Core store/download error codes (possibly wrapped in a message) to UI states. */
export function parseStoreError(error: unknown): StoreError {
  const detail = error instanceof Error ? error.message : String(error);
  const code = /(store|update)-[a-z-]+(?::\d+)?/.exec(detail)?.[0] ?? '';
  if (code.startsWith('store-rate-limited')) {
    const reset = Number(code.split(':')[1]);
    return { kind: 'rate-limited', resetAtMs: reset > 0 ? reset : undefined, detail };
  }
  return { kind: STORE_ERROR_KINDS[code] ?? 'other', detail };
}

export function currentStorePlatform(
  hostKind: string,
  userAgent = globalThis.navigator?.userAgent ?? '',
): StorePlatform | null {
  if (hostKind === 'android') return 'android';
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(userAgent)) return 'macos';
  if (/Linux/i.test(userAgent)) return 'linux';
  return null;
}

/** Monotonic request token: only the newest search may update the view. */
export function createLatestGate() {
  let generation = 0;
  return {
    next(): number {
      generation += 1;
      return generation;
    },
    isCurrent(token: number): boolean {
      return token === generation;
    },
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
