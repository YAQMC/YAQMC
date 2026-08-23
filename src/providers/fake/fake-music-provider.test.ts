import { describe, expect, it } from 'vitest';
import { isAccountMusicProvider } from '../music-provider';
import { QQMusicProvider } from '../qqmusic/qq-music-provider';
import { FakeMusicProvider } from './fake-music-provider';

describe('FakeMusicProvider', () => {
  const provider = new FakeMusicProvider();

  it('returns detached fixture data', async () => {
    const first = await provider.getHome();
    first.featured.album.title = 'Changed by a consumer';

    const second = await provider.getHome();
    expect(second.featured.album.title).toBe('Afterglow');
  });

  it('searches normalized domain fields case-insensitively', async () => {
    const result = await provider.search('  MIRA  ');

    expect(result.songs.length).toBeGreaterThan(0);
    expect(result.albums.map((album) => album.title)).toContain('Afterglow');
  });

  it('reports unknown fixture entities as typed provider errors', async () => {
    await expect(provider.getAlbum('missing')).rejects.toMatchObject({
      code: 'malformed-response',
      retryable: false,
    });
  });

  it('looks up fixture songs and artists through the catalog detail boundary', async () => {
    const song = await provider.getSong('quiet-light');
    expect(song.title).toBe('Quiet Light');

    const artist = await provider.getArtist('artist-mira-vale');
    expect(artist.name).toBe('Mira Vale');
    expect(artist.topSongs.map((candidate) => candidate.id)).toContain('quiet-light');
    expect(artist.albums.map((candidate) => candidate.id)).toContain('album-afterglow');
  });

  it('reports unknown song and artist lookups as not-found provider errors', async () => {
    await expect(provider.getSong('missing')).rejects.toMatchObject({ code: 'not-found' });
    await expect(provider.getArtist('missing')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('remains a catalog-only provider', () => {
    expect(isAccountMusicProvider(provider)).toBe(false);
    expect(isAccountMusicProvider(new QQMusicProvider())).toBe(true);
  });
});
