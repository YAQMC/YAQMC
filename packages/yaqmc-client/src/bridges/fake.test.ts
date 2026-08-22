import { describe, expect, it } from 'vitest';
import { createFakeBridge } from './fake';
import type { HomeFeed, Song } from '../protocol/dto';

const song: Song = {
  id: 'track-0',
  title: 'track-0',
  artists: [{ id: 'artist', name: 'Artist' }],
  album: { id: 'album', title: 'Album' },
  artwork: { src: '/cover.svg', alt: 'Cover', dominantColor: '#000000' },
  durationMs: 10_000,
  trackNumber: 1,
  isFavorite: false,
  quality: 'lossless',
  availability: { status: 'available' },
};

describe('createFakeBridge', () => {
  it('hydrates, seeks, and fans out player snapshots locally', async () => {
    const bridge = createFakeBridge();
    const seen: number[] = [];
    bridge.listen('player://snapshot', (payload) => {
      seen.push(payload.positionMs);
    });
    await bridge.invoke('player_hydrate_queue', { tracks: [song] });
    await bridge.invoke('player_seek', { positionMs: 4800 });
    const snapshot = await bridge.invoke('player_snapshot');
    expect(snapshot.queue).toHaveLength(1);
    expect(snapshot.positionMs).toBe(4800);
    expect(seen).toEqual([0, 4800]);
    expect(bridge.kind).toBe('fake');
  });

  it('routes catalog home through an injected fake-music-provider-shaped catalog', async () => {
    const home = { featured: { eyebrow: 'x', album: { id: 'a' } } } as unknown as HomeFeed;
    const bridge = createFakeBridge({
      catalog: {
        async getHome(refresh) {
          expect(refresh).toBe(true);
          return home;
        },
      },
    });
    await expect(bridge.invoke('qqmusic_home', { refresh: true })).resolves.toBe(home);
  });
});
