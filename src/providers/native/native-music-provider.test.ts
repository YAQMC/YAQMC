import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderDescriptor } from '@yaqmc/client';

const invoke = vi.hoisted(() => vi.fn());
const host = vi.hoisted(() => ({ kind: 'android' }));

vi.mock('../../application/yaqmc-runtime', () => ({
  getYaqmcClient: () => ({ invoke }),
  getHostBridge: () => host,
}));

import { isAccountMusicProvider, isShareMusicProvider } from '../music-provider';
import { createNativeMusicProvider } from './native-music-provider';

function descriptor(
  capabilities: Partial<ProviderDescriptor['capabilities']> = {},
): ProviderDescriptor {
  return {
    providerId: 'plugin.example',
    displayName: 'Example Music',
    isDefault: false,
    available: true,
    capabilities: {
      catalog: true,
      playback: false,
      recommendations: false,
      lyrics: false,
      share: false,
      account: false,
      ...capabilities,
    },
  };
}

describe('NativeMusicProvider', () => {
  beforeEach(() => {
    host.kind = 'android';
    invoke.mockReset();
    invoke.mockResolvedValue({ ok: true });
  });

  it('binds every catalog request to the provider instance ID', async () => {
    const provider = createNativeMusicProvider(descriptor());
    await provider.search('ambient', 'song', undefined, 2, 8);
    expect(invoke).toHaveBeenCalledWith('provider_search', {
      providerId: 'plugin.example',
      query: 'ambient',
      kind: 'song',
      page: 2,
      limit: 8,
    });
  });

  it('exposes only declared account and sharing capabilities', async () => {
    const catalogOnly = createNativeMusicProvider(descriptor());
    expect(isAccountMusicProvider(catalogOnly)).toBe(false);
    expect(isShareMusicProvider(catalogOnly)).toBe(false);

    const provider = createNativeMusicProvider(descriptor({ account: true, share: true }));
    expect(isAccountMusicProvider(provider)).toBe(true);
    expect(isShareMusicProvider(provider)).toBe(true);
    if (!isAccountMusicProvider(provider) || !isShareMusicProvider(provider)) {
      throw new Error('capability projection failed');
    }
    expect(provider.getLoginMethods).toBeTypeOf('function');
    await provider.getLoginMethods!();
    await provider.startWebLogin('browser-oauth');
    await provider.getSongShareTarget('track-1');
    expect(invoke.mock.calls).toEqual([
      ['provider_account_login_methods', { providerId: 'plugin.example' }],
      ['provider_auth_oauth_start', { providerId: 'plugin.example', methodId: 'browser-oauth' }],
      ['catalog_share_song', { providerId: 'plugin.example', id: 'track-1' }],
    ]);
  });

  it('never exposes unknown native error details and honors pre-aborted calls', async () => {
    const provider = createNativeMusicProvider(descriptor());
    invoke.mockRejectedValueOnce(new Error('https://secret.example/?token=raw-secret'));
    await expect(provider.getSong('track-1')).rejects.toMatchObject({
      code: 'provider-failure',
      message: 'Example Music request failed.',
      retryable: false,
    });

    const controller = new AbortController();
    controller.abort();
    invoke.mockClear();
    await expect(provider.getSong('track-2', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('binds a reopen request to the existing attempt without invoking QR generation', async () => {
    const provider = createNativeMusicProvider({
      ...descriptor({ account: true }),
      providerId: 'qqmusic',
    });
    if (!isAccountMusicProvider(provider)) throw new Error('missing account provider');
    await provider.reopenLogin!('synthetic-attempt');
    expect(invoke).toHaveBeenCalledExactlyOnceWith('provider_auth_oauth_start', {
      providerId: 'qqmusic',
      methodId: 'qq',
      attemptId: 'synthetic-attempt',
    });
  });

  it('does not turn a reopen request into a new OAuth attempt on non-Android hosts', async () => {
    host.kind = 'electron';
    const provider = createNativeMusicProvider({
      ...descriptor({ account: true }),
      providerId: 'qqmusic',
    });
    if (!isAccountMusicProvider(provider)) throw new Error('missing account provider');
    await expect(provider.reopenLogin!('synthetic-attempt')).rejects.toMatchObject({
      code: 'unsupported-operation',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('restores provider error semantics from desktop and Android Core envelopes', async () => {
    const provider = createNativeMusicProvider(descriptor());
    invoke
      .mockRejectedValueOnce({
        code: 'core.command_error',
        message: 'request failed',
        retryable: true,
        details: { code: 'offline', message: 'provider is offline', retryable: true },
      })
      .mockRejectedValueOnce({
        code: 'core.command_error',
        message: 'request failed',
        data: {
          retryable: true,
          details: { code: 'timeout', message: 'provider timed out', retryable: true },
        },
      });

    await expect(provider.getSong('track-desktop')).rejects.toMatchObject({
      code: 'offline',
      message: 'provider is offline',
      retryable: true,
    });
    await expect(provider.getSong('track-android')).rejects.toMatchObject({
      code: 'timeout',
      message: 'provider timed out',
      retryable: true,
    });
  });
});
