import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../application/yaqmc-runtime', () => ({
  getYaqmcClient: () => ({
    invoke,
    on: () => () => undefined,
  }),
}));

import { QQMusicProvider } from './qq-music-provider';

describe('QQMusicProvider', () => {
  const provider = new QQMusicProvider();

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ ok: true });
  });

  it('invokes void catalog methods without a params object', async () => {
    await provider.getLibrary();
    expect(invoke).toHaveBeenCalledWith('qqmusic_library');
  });

  it('forwards the typed artist catalog page without adding an upstream route', async () => {
    await provider.getArtistCatalog('qqmusic:artist:mid', 'album', undefined, 2, 8);
    expect(invoke).toHaveBeenCalledWith('qqmusic_artist_catalog', {
      id: 'qqmusic:artist:mid',
      kind: 'album',
      page: 2,
      limit: 8,
    });
  });

  it('keeps NamedRequest { request } shapes for account mutations', async () => {
    const request = {
      trackId: 'song-1',
      favorite: true,
      clientOperationId: 'op-1',
    };
    await provider.setFavorite(request);
    expect(invoke).toHaveBeenCalledWith('qqmusic_set_favorite', { request });
  });

  it('forwards optional cursor and limit without rewriting them to null', async () => {
    await provider.getFavoriteSongs(undefined, 20);
    expect(invoke).toHaveBeenCalledWith('qqmusic_favorite_songs', {
      cursor: undefined,
      limit: 20,
    });
  });

  it('includes the default profile on provider-scoped legacy façade calls', async () => {
    await provider.refreshAccount();
    expect(invoke).toHaveBeenCalledWith('provider_account_refresh', {
      providerId: 'qqmusic',
      profileId: 'default',
    });

    invoke.mockReset();
    await provider.getSongShareTarget('song-1');
    expect(invoke).toHaveBeenCalledWith('catalog_share_song', {
      providerId: 'qqmusic',
      profileId: 'default',
      id: 'song-1',
    });
  });
});
