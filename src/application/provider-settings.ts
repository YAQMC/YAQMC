import { useCallback, useEffect, useState } from 'react';
import type { AudioQualityPreference, CatalogProviderCapabilities } from '../domain/music';
import { clearArtworkMemoryCache } from './artwork-cache';
import { isNativeRuntime } from './native-player-runtime';
import { getYaqmcClient } from './yaqmc-runtime';

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
  selectionKind: 'system-default' | 'specific-device';
  resolvedOutput: {
    name: string;
    driver: string;
    host: string;
    sampleRate: number;
    channels: number;
    sampleFormat: string;
  } | null;
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
      const client = getYaqmcClient();
      const [nextStatus, nextCache, nextDevices] = await Promise.all([
        client.invoke('qqmusic_status'),
        client.invoke('qqmusic_cache_stats'),
        client.invoke('audio_output_devices'),
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
    const client = getYaqmcClient();
    void Promise.all([
      client.invoke('qqmusic_status'),
      client.invoke('qqmusic_cache_stats'),
      client.invoke('audio_output_devices'),
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
      setStatus(await getYaqmcClient().invoke('qqmusic_set_preferred_quality', { quality }));
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
      setDevices(await getYaqmcClient().invoke('audio_set_output_device', { deviceId }));
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
      setCache(await getYaqmcClient().invoke('qqmusic_clear_cache'));
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
