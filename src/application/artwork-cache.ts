import { invoke, isTauri } from '@tauri-apps/api/core';

const memoryCache = new Map<string, Promise<string>>();

function isQQMusicArtwork(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'y.gtimg.cn' || parsed.hostname.endsWith('.music.tc.qq.com'))
    );
  } catch {
    return false;
  }
}

export function cachedArtworkSource(url: string): Promise<string> | null {
  if (!isTauri() || !isQQMusicArtwork(url)) return null;
  const existing = memoryCache.get(url);
  if (existing) return existing;
  const request = invoke<string>('qqmusic_cache_artwork', { url }).catch((error) => {
    memoryCache.delete(url);
    throw error;
  });
  memoryCache.set(url, request);
  return request;
}

export function clearArtworkMemoryCache(): void {
  memoryCache.clear();
}
