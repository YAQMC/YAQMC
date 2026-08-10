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

  it('opens lyrics, closes the queue, and preserves playback state', () => {
    usePlayerStore.setState({
      ...initialPlayerState,
      queue: [track('one')],
      currentIndex: 0,
      positionMs: 3_210,
      isPlaying: true,
      playbackState: 'playing',
      playbackDurationMs: 10_000,
      observedAtMs: 123,
      queueOpen: true,
      lyricsOpen: false,
    });
    const before = usePlayerStore.getState();

    usePlayerStore.getState().openLyrics();

    const after = usePlayerStore.getState();
    expect(after).toMatchObject({ queueOpen: false, lyricsOpen: true });
    expect({
      queue: after.queue,
      currentIndex: after.currentIndex,
      positionMs: after.positionMs,
      isPlaying: after.isPlaying,
      volume: after.volume,
      isMuted: after.isMuted,
      repeat: after.repeat,
      shuffle: after.shuffle,
      playbackState: after.playbackState,
      playbackDurationMs: after.playbackDurationMs,
      playbackError: after.playbackError,
      observedAtMs: after.observedAtMs,
    }).toEqual({
      queue: before.queue,
      currentIndex: before.currentIndex,
      positionMs: before.positionMs,
      isPlaying: before.isPlaying,
      volume: before.volume,
      isMuted: before.isMuted,
      repeat: before.repeat,
      shuffle: before.shuffle,
      playbackState: before.playbackState,
      playbackDurationMs: before.playbackDurationMs,
      playbackError: before.playbackError,
      observedAtMs: before.observedAtMs,
    });
  });
});
