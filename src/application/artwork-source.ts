import { useEffect, useRef, useState } from 'react';
import { isNativeRuntime } from './native-player-runtime';
import {
  cachedArtworkSource,
  isCacheableArtworkSource,
  isCachedArtworkDataUri,
} from './artwork-cache';

export type ArtworkSourceClassification =
  { kind: 'direct'; source: string } | { kind: 'cache'; source: string };

function hasSameOrigin(left: URL, right: URL): boolean {
  return (
    left.protocol === right.protocol && left.hostname === right.hostname && left.port === right.port
  );
}

export function classifyArtworkSource(
  source: string | null | undefined,
  currentOrigin: string,
): ArtworkSourceClassification | null {
  const candidate = source?.trim();
  if (!candidate || candidate.startsWith('//')) return null;
  const lowerCandidate = candidate.toLowerCase();
  if (lowerCandidate.startsWith('data:') || lowerCandidate.startsWith('asset:')) {
    return { kind: 'direct', source: candidate };
  }

  let current: URL;
  let parsed: URL;
  try {
    current = new URL(currentOrigin);
    parsed = new URL(candidate, current);
  } catch {
    return null;
  }

  if (hasSameOrigin(parsed, current) || parsed.origin === 'http://asset.localhost') {
    return { kind: 'direct', source: candidate };
  }
  if (isCacheableArtworkSource(candidate)) {
    return { kind: 'cache', source: candidate };
  }
  return null;
}

interface ResolvedArtwork {
  requested: string;
  source: string;
}

export function useSafeArtworkSource(
  source: string | null | undefined,
  options?: { pendingRemote?: 'allow' | 'hide' },
): string | null {
  const native = isNativeRuntime;
  const hidePendingRemote = options?.pendingRemote === 'hide';
  const candidate = source?.trim() || null;
  const currentOrigin = globalThis.location?.origin ?? '';
  const classification = candidate ? classifyArtworkSource(candidate, currentOrigin) : null;
  const cacheRequest = native && classification?.kind === 'cache' ? classification.source : null;
  const [resolved, setResolved] = useState<ResolvedArtwork | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    if (!cacheRequest) return;
    const request = cachedArtworkSource(cacheRequest);
    if (!request) return;
    void request
      .then((value) => {
        if (generation.current === requestGeneration && isCachedArtworkDataUri(value)) {
          setResolved({ requested: cacheRequest, source: value });
        }
      })
      .catch(() => undefined);
    return () => {
      if (generation.current === requestGeneration) generation.current += 1;
    };
  }, [cacheRequest]);

  if (!candidate) return null;
  if (!native) return candidate;
  if (classification?.kind === 'direct') return classification.source;
  if (cacheRequest && resolved?.requested === cacheRequest) return resolved.source;
  if (classification?.kind === 'cache') return hidePendingRemote ? null : classification.source;
  return null;
}
