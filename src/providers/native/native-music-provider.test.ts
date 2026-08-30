import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderDescriptor } from '@yaqmc/client';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../application/yaqmc-runtime', () => ({
  getYaqmcClient: () => ({ invoke }),
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
});
