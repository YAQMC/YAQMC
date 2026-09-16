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

function response(method: string, params?: { providerId?: string; profileId?: string }) {
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
    profileId: params?.profileId ?? 'default',
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
    invoke.mockImplementation(
      async (method: string, params?: { providerId?: string; profileId?: string }) =>
        response(method, params),
    );
  });

  it('refreshes, mutates quality, and clears cache for the active provider only', async () => {
    const hook = renderHook(({ id, profile }) => useProviderSettings(id, profile), {
      initialProps: { id: 'provider.a', profile: 'default' },
    });
    await waitFor(() => expect(hook.result.current.status?.providerId).toBe('provider.a'));
    expect(invoke).toHaveBeenCalledWith('provider_status', {
      providerId: 'provider.a',
      profileId: 'default',
    });
    expect(invoke).toHaveBeenCalledWith('provider_cache_stats', {
      providerId: 'provider.a',
      profileId: 'default',
    });

    await act(async () => hook.result.current.setQuality('lossless'));
    await act(async () => hook.result.current.clearCache());
    expect(invoke).toHaveBeenCalledWith('provider_set_preferred_quality', {
      providerId: 'provider.a',
      profileId: 'default',
      quality: 'lossless',
    });
    expect(invoke).toHaveBeenCalledWith('provider_clear_cache', {
      providerId: 'provider.a',
      profileId: 'default',
    });

    hook.rerender({ id: 'provider.b', profile: 'default' });
    await waitFor(() => expect(hook.result.current.status?.providerId).toBe('provider.b'));
    expect(invoke).toHaveBeenCalledWith('provider_status', {
      providerId: 'provider.b',
      profileId: 'default',
    });
    expect(invoke).not.toHaveBeenCalledWith('qqmusic_status');
  });

  it('keeps provider status available on Android when cache stats fail', async () => {
    testRuntime.android = true;
    invoke.mockImplementation(
      async (method: string, params?: { providerId?: string; profileId?: string }) => {
        if (method === 'provider_cache_stats') throw new Error('cache unavailable');
        return response(method, params);
      },
    );

    const hook = renderHook(() => useProviderSettings('provider.android', 'default'));

    await waitFor(() => expect(hook.result.current.status?.providerId).toBe('provider.android'));
    expect(hook.result.current.cache).toBeNull();
    expect(hook.result.current.error).toBe('cache unavailable');
    expect(invoke).not.toHaveBeenCalledWith('audio_output_devices');
  });

  it('binds all provider settings requests to an alternate profile', async () => {
    const hook = renderHook(() => useProviderSettings('provider.a', 'alternate'));

    await waitFor(() => expect(hook.result.current.status?.providerId).toBe('provider.a'));
    await act(async () => hook.result.current.setQuality('lossless'));
    await act(async () => hook.result.current.clearCache());

    expect(invoke).toHaveBeenCalledWith('provider_status', {
      providerId: 'provider.a',
      profileId: 'alternate',
    });
    expect(invoke).toHaveBeenCalledWith('provider_cache_stats', {
      providerId: 'provider.a',
      profileId: 'alternate',
    });
    expect(invoke).toHaveBeenCalledWith('provider_set_preferred_quality', {
      providerId: 'provider.a',
      profileId: 'alternate',
      quality: 'lossless',
    });
    expect(invoke).toHaveBeenCalledWith('provider_clear_cache', {
      providerId: 'provider.a',
      profileId: 'alternate',
    });
  });

  it('does not let an older profile response overwrite the active profile', async () => {
    const pending = new Map<string, (value: unknown) => void>();
    invoke.mockImplementation(
      (method: string, params?: { providerId?: string; profileId?: string }) => {
        if (method === 'audio_output_devices') return Promise.resolve([]);
        return new Promise((resolve) => {
          pending.set(`${method}:${params?.profileId ?? 'default'}`, resolve);
        });
      },
    );

    const hook = renderHook(({ profile }) => useProviderSettings('provider.a', profile), {
      initialProps: { profile: 'default' },
    });
    await waitFor(() => expect(pending.has('provider_status:default')).toBe(true));

    hook.rerender({ profile: 'alternate' });
    await waitFor(() => expect(pending.has('provider_status:alternate')).toBe(true));
    pending.get('provider_status:alternate')?.(
      response('provider_status', {
        providerId: 'provider.a',
        profileId: 'alternate',
      }),
    );
    pending.get('provider_cache_stats:alternate')?.(
      response('provider_cache_stats', {
        providerId: 'provider.a',
        profileId: 'alternate',
      }),
    );
    await waitFor(() => expect(hook.result.current.status?.profileId).toBe('alternate'));

    pending.get('provider_status:default')?.(
      response('provider_status', {
        providerId: 'provider.a',
        profileId: 'default',
      }),
    );
    pending.get('provider_cache_stats:default')?.(
      response('provider_cache_stats', {
        providerId: 'provider.a',
        profileId: 'default',
      }),
    );
    await act(async () => undefined);
    expect(hook.result.current.status?.profileId).toBe('alternate');
  });
});
