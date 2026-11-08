import { useCallback, useEffect, useRef, useState } from 'react';
import type { CacheStats } from '@yaqmc/client';
import { clearArtworkMemoryCache } from './artwork-cache';
import { clearBlurredArtworkCache } from './blurred-artwork';
import { isNativeRuntime } from './native-player-runtime';
import { getYaqmcClient } from './yaqmc-runtime';

export function useStorageSettings() {
  const [cache, setCache] = useState<CacheStats | null>(null);
  const [loading, setLoading] = useState(isNativeRuntime);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<'read' | 'clear' | null>(null);
  const generation = useRef(0);
  const clearPending = useRef(false);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    if (!isNativeRuntime || clearPending.current) return;
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const value = await getYaqmcClient().invoke('app_cache_stats');
      if (mounted.current && request === generation.current) setCache(value);
    } catch {
      if (mounted.current && request === generation.current) setError('read');
    } finally {
      if (mounted.current && request === generation.current) setLoading(false);
    }
  }, []);

  const clearCache = useCallback(async () => {
    if (!isNativeRuntime || clearPending.current) return;
    const request = ++generation.current;
    clearPending.current = true;
    setClearing(true);
    setLoading(false);
    setError(null);
    try {
      const value = await getYaqmcClient().invoke('app_clear_cache');
      if (mounted.current && request === generation.current) {
        clearArtworkMemoryCache();
        clearBlurredArtworkCache();
        setCache(value);
      }
    } catch {
      if (mounted.current && request === generation.current) {
        // The disk operation may have partially completed. Drop stale memory
        // images and require a fresh measurement rather than displaying old usage.
        clearArtworkMemoryCache();
        clearBlurredArtworkCache();
        setCache(null);
        setError('clear');
      }
    } finally {
      clearPending.current = false;
      if (mounted.current && request === generation.current) setClearing(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    mounted.current = true;
    queueMicrotask(() => {
      if (!disposed) void refresh();
    });
    return () => {
      disposed = true;
      mounted.current = false;
      generation.current += 1;
    };
  }, [refresh]);

  return { available: isNativeRuntime, cache, loading, clearing, error, refresh, clearCache };
}
