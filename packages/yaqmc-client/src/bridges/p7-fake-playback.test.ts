import { describe, expect, it } from 'vitest';
import { YaqmcClient } from '../client';
import type { Song } from '../protocol/dto';
import { createFakeBridge } from './fake';

const track = (id: string, durationMs = 10_000): Song => ({
  id,
  title: id,
  artists: [{ id: 'artist', name: 'Artist' }],
  album: { id: 'album', title: 'Album' },
  artwork: { src: '/cover.svg', alt: 'Cover', dominantColor: '#000000' },
  durationMs,
  trackNumber: 1,
  isFavorite: false,
  quality: 'lossless',
  availability: { status: 'available' },
});

describe('PLAY-01 fake-mode assist (not LIVE VERIFY)', () => {
  it('plays, pauses, toggles, seeks, and hydrates a queue on createFakeBridge', async () => {
    const bridge = createFakeBridge();
    const client = new YaqmcClient(bridge);
    client.markReady();

    const a = track('a');
    const b = track('b', 8_000);
    let snapshot = await client.player.hydrateQueue([a, b]);
    expect(snapshot.queue.map((song) => song.id)).toEqual(['a', 'b']);
    expect(snapshot.isPlaying).toBe(false);
    expect(snapshot.playbackState).toBe('paused');

    snapshot = await client.player.play();
    expect(snapshot.isPlaying).toBe(true);
    expect(snapshot.playbackState).toBe('playing');

    snapshot = await client.player.pause();
    expect(snapshot.isPlaying).toBe(false);
    expect(snapshot.playbackState).toBe('paused');

    snapshot = await client.player.toggle();
    expect(snapshot.isPlaying).toBe(true);
    snapshot = await client.player.toggle();
    expect(snapshot.isPlaying).toBe(false);

    snapshot = await client.player.seek(3_200);
    expect(snapshot.positionMs).toBe(3_200);

    snapshot = await client.player.playTracks({ tracks: [b] });
    expect(snapshot.queue).toHaveLength(1);
    expect(snapshot.queue[0]?.id).toBe('b');
    expect(snapshot.isPlaying).toBe(true);
    expect(snapshot.playbackDurationMs).toBe(8_000);

    client.dispose();
  });
});
