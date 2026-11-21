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
import { nativeProviderRequest } from './native-request';

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
      musicVideos: false,
      share: false,
      account: false,
      ...capabilities,
    },
  };
}

describe('NativeMusicProvider', () => {
  it.each(['provider_lyrics', 'qqmusic_lyrics'] as const)(
    'cancels legacy comment reads through %s',
    async (command) => {
      invoke.mockImplementation((method: string) =>
        method === command ? new Promise(() => {}) : Promise.resolve(),
      );
      const controller = new AbortController();
      const args =
        command === 'qqmusic_lyrics'
          ? { songId: 'track' }
          : { providerId: 'plugin.example', profileId: 'work', id: 'track' };
      const pending = nativeProviderRequest(command, args, controller.signal);
      const observed = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      const requestId = invoke.mock.calls[0]![1].requestId;
      controller.abort();
      await observed;
      expect(invoke).toHaveBeenLastCalledWith('provider_comments_cancel', {
        providerId: command === 'qqmusic_lyrics' ? 'qqmusic' : 'plugin.example',
        profileId: command === 'qqmusic_lyrics' ? undefined : 'work',
        requestId,
      });
    },
  );
  it.each([
    [
      'provider_search',
      {
        providerId: 'plugin.example',
        profileId: 'work',
        query: 'needle',
        kind: 'song',
        page: 1,
        limit: 20,
      },
      'plugin.example',
      'work',
    ],
    ['qqmusic_search', { query: 'needle', kind: 'song', page: 1, limit: 20 }, 'qqmusic', undefined],
  ] as const)(
    'cancels pending %s requests through the shared search token',
    async (command, args, providerId, profileId) => {
      invoke.mockImplementation((method: string) =>
        method === command ? new Promise(() => {}) : Promise.resolve(),
      );
      const controller = new AbortController();
      const pending = nativeProviderRequest(command, args, controller.signal);
      const observed = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      const requestId = invoke.mock.calls[0]![1].requestId;
      controller.abort();
      await observed;
      expect(invoke).toHaveBeenLastCalledWith('provider_search_cancel', {
        providerId,
        profileId,
        requestId,
      });
    },
  );
  it('cancels the exact native comment read immediately without waiting for its reply', async () => {
    const provider = createNativeMusicProvider(descriptor({ comments: true }), 'work');
    invoke.mockImplementation((method: string) =>
      method === 'provider_comments' ? new Promise(() => {}) : Promise.resolve(),
    );
    const controller = new AbortController();
    const pending = provider.getComments!(
      { songId: 'track', sort: 'hot', limit: 20 },
      controller.signal,
    );
    const observed = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const requestId = invoke.mock.calls[0]![1].requestId;
    controller.abort();
    await observed;
    expect(invoke).toHaveBeenLastCalledWith('provider_comments_cancel', {
      providerId: 'plugin.example',
      profileId: 'work',
      requestId,
    });
  });
  it('exposes declared music videos and sends playback through the scoped native command', async () => {
    const catalogOnly = createNativeMusicProvider(descriptor(), 'work');
    expect(catalogOnly.getMusicVideo).toBeUndefined();

    const provider = createNativeMusicProvider(descriptor({ musicVideos: true }), 'work');
    expect(provider.getMusicVideo).toBeTypeOf('function');
    await provider.getMusicVideo!('qqmusic:mv:fixture');
    expect(invoke).toHaveBeenCalledWith('provider_mv', {
      providerId: 'plugin.example',
      profileId: 'work',
      id: 'qqmusic:mv:fixture',
    });
  });
  it('exposes declared comments and preserves provider/profile, cursor and parent', async () => {
    const provider = createNativeMusicProvider(descriptor({ comments: true }), 'work');
    const request = {
      songId: 'source-track',
      sort: 'new' as const,
      limit: 20,
      cursor: 'opaque',
      parentId: 'parent',
    };
    await provider.getComments!(request);
    expect(invoke).toHaveBeenCalledWith('provider_comments', {
      providerId: 'plugin.example',
      profileId: 'work',
      request,
    });
    expect(createNativeMusicProvider(descriptor()).getComments).toBeUndefined();
  });
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
      profileId: 'default',
      query: 'ambient',
      kind: 'song',
      page: 2,
      limit: 8,
    });
  });

  it('binds every IPC request to the explicitly bound profile', async () => {
    const provider = createNativeMusicProvider(descriptor(), 'work');
    await provider.getHome();
    expect(invoke).toHaveBeenCalledWith('provider_home', {
      providerId: 'plugin.example',
      profileId: 'work',
      refresh: false,
    });
  });

  it('rejects profile IDs that are unsafe for native scope routing', () => {
    expect(() => createNativeMusicProvider(descriptor(), 'not safe')).toThrow(/Profile ID/);
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
      ['provider_account_login_methods', { providerId: 'plugin.example', profileId: 'default' }],
      [
        'provider_auth_oauth_start',
        { providerId: 'plugin.example', profileId: 'default', methodId: 'browser-oauth' },
      ],
      ['catalog_share_song', { providerId: 'plugin.example', profileId: 'default', id: 'track-1' }],
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
      profileId: 'default',
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
