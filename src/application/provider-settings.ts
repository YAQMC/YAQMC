import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';
import type { AudioQualityPreference, CatalogProviderCapabilities } from '../domain/music';
import { clearArtworkMemoryCache } from './artwork-cache';
import { isNativeRuntime } from './native-player-runtime';

export interface ProviderStatus {
  providerId: string;
  displayName: string;
  connection: 'online' | 'cached' | 'offline';
  message: string;
  preferredQuality: AudioQualityPreference;
  capabilities: CatalogProviderCapabilities;
}

export interface CacheStats {
  totalBytes: number;
  mediaBytes: number;
  artworkBytes: number;
  mediaEntries: number;
  artworkEntries: number;
  metadataEntries: number;
  lyricEntries: number;
  mediaLimitBytes: number;
  artworkLimitBytes: number;
}

export interface AudioOutputDevice {
  id: string;
  label: string;
  isDefault: boolean;
  isSelected: boolean;
}

function message(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return error instanceof Error ? error.message : String(error);
}

export function useProviderSettings() {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [cache, setCache] = useState<CacheStats | null>(null);
  const [devices, setDevices] = useState<AudioOutputDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isNativeRuntime) return;
    setError(null);
    try {
      const [nextStatus, nextCache, nextDevices] = await Promise.all([
        invoke<ProviderStatus>('qqmusic_status'),
        invoke<CacheStats>('qqmusic_cache_stats'),
        invoke<AudioOutputDevice[]>('audio_output_devices'),
      ]);
      setStatus(nextStatus);
      setCache(nextCache);
      setDevices(nextDevices);
    } catch (caught) {
      setError(message(caught));
    }
  }, []);

  useEffect(() => {
    if (!isNativeRuntime) return;
    let active = true;
    void Promise.all([
      invoke<ProviderStatus>('qqmusic_status'),
      invoke<CacheStats>('qqmusic_cache_stats'),
      invoke<AudioOutputDevice[]>('audio_output_devices'),
    ])
      .then(([nextStatus, nextCache, nextDevices]) => {
        if (!active) return;
        setStatus(nextStatus);
        setCache(nextCache);
        setDevices(nextDevices);
      })
      .catch((caught: unknown) => {
        if (active) setError(message(caught));
      });
    return () => {
      active = false;
    };
  }, []);

  const setQuality = useCallback(async (quality: AudioQualityPreference) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await invoke<ProviderStatus>('qqmusic_set_preferred_quality', { quality }));
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  const setOutputDevice = useCallback(async (deviceId: string) => {
    setBusy(true);
    setError(null);
    try {
      setDevices(await invoke<AudioOutputDevice[]>('audio_set_output_device', { deviceId }));
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  const clearCache = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setCache(await invoke<CacheStats>('qqmusic_clear_cache'));
      clearArtworkMemoryCache();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    available: isNativeRuntime,
    status,
    cache,
    devices,
    busy,
    error,
    refresh,
    setQuality,
    setOutputDevice,
    clearCache,
  };
}
