import { describe, expect, it } from 'vitest';
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
});
