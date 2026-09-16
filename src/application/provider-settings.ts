import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_PROFILE_ID,
  type AudioQualityPreference,
  type CatalogProviderCapabilities,
} from '../domain/music';
import { clearArtworkMemoryCache } from './artwork-cache';
import { isAndroidRuntime } from './host-capabilities';
import { isNativeRuntime } from './native-player-runtime';
import { getYaqmcClient } from './yaqmc-runtime';

export interface ProviderStatus {
  providerId: string;
  profileId: string;
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
  scope: string;
  token: symbol;
  value: T;
}

function providerScope(providerId: string, profileId: string): string {
  return `${providerId}\0${profileId}`;
}

export function useProviderSettings(providerId: string, profileId = DEFAULT_PROFILE_ID) {
  const scope = providerScope(providerId, profileId);
  const scopeToken = useMemo(() => Symbol(scope), [scope]);
  const refreshGenerationRef = useRef(0);
  const qualityGenerationRef = useRef(0);
  const outputGenerationRef = useRef(0);
  const cacheGenerationRef = useRef(0);
  const [statusState, setStatusState] = useState<ProviderScopedValue<ProviderStatus> | null>(null);
  const [cacheState, setCacheState] = useState<ProviderScopedValue<CacheStats> | null>(null);
  const [devicesState, setDevicesState] = useState<ProviderScopedValue<AudioOutputDevice[]> | null>(
    null,
  );
  const [busyState, setBusyState] = useState<ProviderScopedValue<boolean> | null>(null);
  const [errorState, setErrorState] = useState<ProviderScopedValue<string> | null>(null);
  const status = statusState?.token === scopeToken ? statusState.value : null;
  const cache = cacheState?.token === scopeToken ? cacheState.value : null;
  const devices = devicesState?.token === scopeToken ? devicesState.value : [];
  const busy = busyState?.token === scopeToken && busyState.value;
  const error = errorState?.token === scopeToken ? errorState.value : null;

  const refresh = useCallback(async () => {
    if (!isNativeRuntime) return;
    const generation = ++refreshGenerationRef.current;
    setErrorState(null);
    const client = getYaqmcClient();
    const [statusResult, cacheResult, devicesResult] = await Promise.allSettled([
      client.invoke('provider_status', { providerId, profileId }),
      client.invoke('provider_cache_stats', { providerId, profileId }),
      isAndroidRuntime() ? Promise.resolve([]) : client.invoke('audio_output_devices'),
    ]);
    if (generation !== refreshGenerationRef.current) return;
    if (statusResult.status === 'fulfilled') {
      setStatusState({ scope, token: scopeToken, value: statusResult.value });
    }
    if (cacheResult.status === 'fulfilled') {
      setCacheState({ scope, token: scopeToken, value: cacheResult.value });
    }
    if (devicesResult.status === 'fulfilled')
      setDevicesState({ scope, token: scopeToken, value: devicesResult.value });
    const failure = [statusResult, cacheResult, devicesResult].find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) setErrorState({ scope, token: scopeToken, value: message(failure.reason) });
  }, [profileId, providerId, scope, scopeToken]);

  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed && isNativeRuntime) void refresh();
    });
    return () => {
      disposed = true;
      refreshGenerationRef.current += 1;
      qualityGenerationRef.current += 1;
      outputGenerationRef.current += 1;
      cacheGenerationRef.current += 1;
    };
  }, [refresh]);

  const setQuality = useCallback(
    async (quality: AudioQualityPreference) => {
      const generation = ++qualityGenerationRef.current;
      setBusyState({ scope, token: scopeToken, value: true });
      setErrorState(null);
      try {
        const value = await getYaqmcClient().invoke('provider_set_preferred_quality', {
          providerId,
          profileId,
          quality,
        });
        if (generation === qualityGenerationRef.current) {
          setStatusState({ scope, token: scopeToken, value });
        }
      } catch (caught) {
        if (generation === qualityGenerationRef.current) {
          setErrorState({ scope, token: scopeToken, value: message(caught) });
        }
      } finally {
        if (generation === qualityGenerationRef.current) {
          setBusyState({ scope, token: scopeToken, value: false });
        }
      }
    },
    [profileId, providerId, scope, scopeToken],
  );

  const setOutputDevice = useCallback(
    async (deviceId: string) => {
      const generation = ++outputGenerationRef.current;
      setBusyState({ scope, token: scopeToken, value: true });
      setErrorState(null);
      try {
        const value = await getYaqmcClient().invoke('audio_set_output_device', { deviceId });
        if (generation === outputGenerationRef.current) {
          setDevicesState({ scope, token: scopeToken, value });
        }
      } catch (caught) {
        if (generation === outputGenerationRef.current) {
          setErrorState({ scope, token: scopeToken, value: message(caught) });
        }
      } finally {
        if (generation === outputGenerationRef.current) {
          setBusyState({ scope, token: scopeToken, value: false });
        }
      }
    },
    [scope, scopeToken],
  );

  const clearCache = useCallback(async () => {
    const generation = ++cacheGenerationRef.current;
    setBusyState({ scope, token: scopeToken, value: true });
    setErrorState(null);
    try {
      const value = await getYaqmcClient().invoke('provider_clear_cache', {
        providerId,
        profileId,
      });
      if (generation === cacheGenerationRef.current) {
        setCacheState({ scope, token: scopeToken, value });
        clearArtworkMemoryCache();
      }
    } catch (caught) {
      if (generation === cacheGenerationRef.current) {
        setErrorState({ scope, token: scopeToken, value: message(caught) });
      }
    } finally {
      if (generation === cacheGenerationRef.current) {
        setBusyState({ scope, token: scopeToken, value: false });
      }
    }
  }, [profileId, providerId, scope, scopeToken]);

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
