import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testRuntime = vi.hoisted(() => ({ android: false }));
const invoke = vi.hoisted(() => vi.fn());

vi.mock('./native-player-runtime', () => ({ isNativeRuntime: true }));
vi.mock('./host-capabilities', () => ({
  isAndroidRuntime: () => testRuntime.android,
}));
vi.mock('./yaqmc-runtime', () => ({
  getYaqmcClient: () => ({ invoke }),
}));

import { useProviderSettings } from './provider-settings';

function response(method: string, params?: { providerId?: string }) {
  if (method === 'audio_output_devices') return [];
  if (method === 'provider_cache_stats' || method === 'provider_clear_cache') {
    return {
      totalBytes: 0,
      mediaBytes: 0,
      artworkBytes: 0,
      mediaEntries: 0,
      artworkEntries: 0,
      metadataEntries: 0,
      lyricEntries: 0,
      mediaLimitBytes: 1,
      artworkLimitBytes: 1,
    };
  }
  return {
    providerId: params?.providerId ?? 'unknown',
    displayName: params?.providerId ?? 'unknown',
    connection: 'online',
    message: 'ready',
    preferredQuality: 'automatic',
    capabilities: {},
  };
}

describe('useProviderSettings', () => {
  beforeEach(() => {
    testRuntime.android = false;
    invoke.mockReset();
    invoke.mockImplementation(async (method: string, params?: { providerId?: string }) =>
      response(method, params),
    );
  });

  it('refreshes, mutates quality, and clears cache for the active provider only', async () => {
    const hook = renderHook(({ id }) => useProviderSettings(id), {
      initialProps: { id: 'provider.a' },
    });
    await waitFor(() => expect(hook.result.current.status?.providerId).toBe('provider.a'));
    expect(invoke).toHaveBeenCalledWith('provider_status', { providerId: 'provider.a' });
    expect(invoke).toHaveBeenCalledWith('provider_cache_stats', { providerId: 'provider.a' });

    await act(async () => hook.result.current.setQuality('lossless'));
    await act(async () => hook.result.current.clearCache());
    expect(invoke).toHaveBeenCalledWith('provider_set_preferred_quality', {
      providerId: 'provider.a',
      quality: 'lossless',
    });
    expect(invoke).toHaveBeenCalledWith('provider_clear_cache', { providerId: 'provider.a' });

    hook.rerender({ id: 'provider.b' });
    await waitFor(() => expect(hook.result.current.status?.providerId).toBe('provider.b'));
    expect(invoke).toHaveBeenCalledWith('provider_status', { providerId: 'provider.b' });
    expect(invoke).not.toHaveBeenCalledWith('qqmusic_status');
  });

  it('keeps provider status available on Android when cache stats fail', async () => {
    testRuntime.android = true;
    invoke.mockImplementation(async (method: string, params?: { providerId?: string }) => {
      if (method === 'provider_cache_stats') throw new Error('cache unavailable');
      return response(method, params);
    });

    const hook = renderHook(() => useProviderSettings('provider.android'));

    await waitFor(() => expect(hook.result.current.status?.providerId).toBe('provider.android'));
    expect(hook.result.current.cache).toBeNull();
    expect(hook.result.current.error).toBe('cache unavailable');
    expect(invoke).not.toHaveBeenCalledWith('audio_output_devices');
  });
});
