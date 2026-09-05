import { useCallback, useEffect, useState } from 'react';
import type { AudioQualityPreference, CatalogProviderCapabilities } from '../domain/music';
import { clearArtworkMemoryCache } from './artwork-cache';
import { isAndroidRuntime } from './host-capabilities';
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

interface ProviderScopedValue<T> {
  providerId: string;
  value: T;
}

export function useProviderSettings(providerId: string) {
  const [statusState, setStatusState] = useState<ProviderScopedValue<ProviderStatus> | null>(null);
  const [cacheState, setCacheState] = useState<ProviderScopedValue<CacheStats> | null>(null);
  const [devices, setDevices] = useState<AudioOutputDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [errorState, setErrorState] = useState<ProviderScopedValue<string> | null>(null);
  const status = statusState?.providerId === providerId ? statusState.value : null;
  const cache = cacheState?.providerId === providerId ? cacheState.value : null;
  const error = errorState?.providerId === providerId ? errorState.value : null;

  const refresh = useCallback(async () => {
    if (!isNativeRuntime) return;
    setErrorState(null);
    const client = getYaqmcClient();
    const [statusResult, cacheResult, devicesResult] = await Promise.allSettled([
      client.invoke('provider_status', { providerId }),
      client.invoke('provider_cache_stats', { providerId }),
      isAndroidRuntime() ? Promise.resolve([]) : client.invoke('audio_output_devices'),
    ]);
    if (statusResult.status === 'fulfilled') {
      setStatusState({ providerId, value: statusResult.value });
    }
    if (cacheResult.status === 'fulfilled') {
      setCacheState({ providerId, value: cacheResult.value });
    }
    if (devicesResult.status === 'fulfilled') setDevices(devicesResult.value);
    const failure = [statusResult, cacheResult, devicesResult].find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) setErrorState({ providerId, value: message(failure.reason) });
  }, [providerId]);

  useEffect(() => {
    if (!isNativeRuntime) return;
    let active = true;
    const client = getYaqmcClient();
    void Promise.allSettled([
      client.invoke('provider_status', { providerId }),
      client.invoke('provider_cache_stats', { providerId }),
      isAndroidRuntime() ? Promise.resolve([]) : client.invoke('audio_output_devices'),
    ]).then(([statusResult, cacheResult, devicesResult]) => {
      if (!active) return;
      if (statusResult.status === 'fulfilled') {
        setStatusState({ providerId, value: statusResult.value });
      }
      if (cacheResult.status === 'fulfilled') {
        setCacheState({ providerId, value: cacheResult.value });
      }
      if (devicesResult.status === 'fulfilled') setDevices(devicesResult.value);
      const failure = [statusResult, cacheResult, devicesResult].find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failure) setErrorState({ providerId, value: message(failure.reason) });
    });
    return () => {
      active = false;
    };
  }, [providerId]);

  const setQuality = useCallback(
    async (quality: AudioQualityPreference) => {
      setBusy(true);
      setErrorState(null);
      try {
        setStatusState({
          providerId,
          value: await getYaqmcClient().invoke('provider_set_preferred_quality', {
            providerId,
            quality,
          }),
        });
      } catch (caught) {
        setErrorState({ providerId, value: message(caught) });
      } finally {
        setBusy(false);
      }
    },
    [providerId],
  );

  const setOutputDevice = useCallback(
    async (deviceId: string) => {
      setBusy(true);
      setErrorState(null);
      try {
        setDevices(await getYaqmcClient().invoke('audio_set_output_device', { deviceId }));
      } catch (caught) {
        setErrorState({ providerId, value: message(caught) });
      } finally {
        setBusy(false);
      }
    },
    [providerId],
  );

  const clearCache = useCallback(async () => {
    setBusy(true);
    setErrorState(null);
    try {
      setCacheState({
        providerId,
        value: await getYaqmcClient().invoke('provider_clear_cache', { providerId }),
      });
      clearArtworkMemoryCache();
    } catch (caught) {
      setErrorState({ providerId, value: message(caught) });
    } finally {
      setBusy(false);
    }
  }, [providerId]);

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
