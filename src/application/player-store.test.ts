import { beforeEach, describe, expect, it } from 'vitest';
import type { Song } from '../domain/music';
import { initialPlayerState, usePlayerStore } from './player-store';

const track = (id: string, durationMs = 10_000): Song => ({
  id,
  title: id,
  artists: [{ id: 'artist', name: 'Artist' }],
  album: { id: 'album', title: 'Album' },
  artwork: { src: '/cover.svg', alt: 'Cover', dominantColor: '#000' },
  durationMs,
  trackNumber: 1,
  isFavorite: false,
  quality: 'high',
  availability: { status: 'available' },
});

describe('player store', () => {
  beforeEach(() => {
    usePlayerStore.setState(initialPlayerState);
  });

  it('starts a requested track in a new queue', () => {
    usePlayerStore.getState().playTracks([track('one'), track('two')], 'two');

    expect(usePlayerStore.getState()).toMatchObject({
      currentIndex: 1,
      positionMs: 0,
      isPlaying: true,
    });
  });

  it('advances when a track reaches its duration', () => {
    usePlayerStore.getState().playTracks([track('one'), track('two')]);
    usePlayerStore.getState().tick(10_000);

    expect(usePlayerStore.getState()).toMatchObject({ currentIndex: 1, positionMs: 0 });
  });

  it('stops at the end when repeat is disabled', () => {
    usePlayerStore.getState().playTracks([track('one')]);
    usePlayerStore.getState().tick(10_000);

    expect(usePlayerStore.getState()).toMatchObject({ isPlaying: false, positionMs: 0 });
  });

  it('keeps the active track stable when removing an earlier queue entry', () => {
    usePlayerStore.getState().playTracks([track('one'), track('two'), track('three')], 'two');
    usePlayerStore.getState().removeFromQueue(0);

    const state = usePlayerStore.getState();
    expect(state.currentIndex).toBe(0);
    expect(state.queue[state.currentIndex]?.id).toBe('two');
  });
});
