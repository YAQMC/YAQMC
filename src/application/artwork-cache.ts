import { isNativeRuntime } from './native-player-runtime';
import { getYaqmcClient } from './yaqmc-runtime';

const memoryCache = new Map<string, string>();
const pendingCache = new Map<string, Promise<string>>();
let cacheGeneration = 0;

export function isCacheableArtworkSource(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'y.gtimg.cn' || parsed.hostname === 'qpic.y.qq.com') &&
      parsed.username === '' &&
      parsed.password === '' &&
      (parsed.port === '' || parsed.port === '443')
    );
  } catch {
    return false;
  }
}

export function isCachedArtworkDataUri(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^data:(image\/[a-z0-9][a-z0-9!#$&^_.+-]*);base64,([a-z0-9+/]+={0,2})$/i.exec(
    value,
  );
  const payload = match?.[2];
  if (!payload || payload.length % 4 !== 0) return false;
  try {
    return globalThis.btoa(globalThis.atob(payload)) === payload;
  } catch {
    return false;
  }
}

export function cachedArtworkSource(url: string): Promise<string> | null {
  if (!isNativeRuntime || !isCacheableArtworkSource(url)) return null;
  const existing = memoryCache.get(url);
  if (existing) return Promise.resolve(existing);
  const pending = pendingCache.get(url);
  if (pending) return pending;
  const requestGeneration = cacheGeneration;
  const request = getYaqmcClient()
    .invoke('qqmusic_cache_artwork', { url })
    .then((value) => {
      if (!isCachedArtworkDataUri(value)) {
        throw new Error('The native artwork cache returned an invalid image payload');
      }
      if (cacheGeneration === requestGeneration) memoryCache.set(url, value);
      return value;
    })
    .finally(() => {
      if (pendingCache.get(url) === request) pendingCache.delete(url);
    });
  pendingCache.set(url, request);
  return request;
}

export function clearArtworkMemoryCache(): void {
  cacheGeneration += 1;
  memoryCache.clear();
  pendingCache.clear();
}
