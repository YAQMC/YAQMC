import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Song } from '../domain/music';
import type { MusicProvider } from '../providers/music-provider';
import { setPlayerCommandAdapter } from './player-command-adapter';
import { initialPlayerState, usePlayerStore } from './player-store';
import { useGuessContinuation } from './use-guess-continuation';

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

const provider: MusicProvider = {
  id: 'qqmusic',
  displayName: 'QQ Music',
  getHome: vi.fn(),
  getDiscover: vi.fn(),
  getArea: vi.fn(),
  getAlbum: vi.fn(),
  getPlaylist: vi.fn(),
  getLibrary: vi.fn(),
  getLyrics: vi.fn(),
  search: vi.fn(),
  getGuessNext: vi.fn(),
};

describe('useGuessContinuation', () => {
  beforeEach(() => {
    setPlayerCommandAdapter(null);
    usePlayerStore.setState(initialPlayerState);
    vi.mocked(provider.getGuessNext).mockReset();
  });

  afterEach(() => {
    setPlayerCommandAdapter(null);
    vi.restoreAllMocks();
  });

  it('fetches the next group when the guess session ends and appends it to the queue', async () => {
    const first = [track('guess-1'), track('guess-2')];
    const next = [track('guess-3'), track('guess-4')];
    vi.mocked(provider.getGuessNext).mockResolvedValue(next);

    renderHook(() => useGuessContinuation(provider));

    act(() => {
      const store = usePlayerStore.getState();
      store.playTracks(first);
      store.startGuessSession();
    });

    expect(usePlayerStore.getState().queue).toHaveLength(2);
    expect(usePlayerStore.getState().currentIndex).toBe(0);

    act(() => {
      usePlayerStore.getState().tick(first[0]!.durationMs);
      usePlayerStore.getState().tick(first[1]!.durationMs);
    });

    await waitFor(() => {
      expect(provider.getGuessNext).toHaveBeenCalledWith(5);
    });
    await waitFor(() => {
      const state = usePlayerStore.getState();
      expect(state.queue).toHaveLength(4);
      expect(state.queue[2]?.id).toBe('guess-3');
      expect(state.currentIndex).toBe(2);
      expect(state.isPlaying).toBe(true);
    });
  });

  it('stops the session when the provider returns no more songs', async () => {
    const first = [track('guess-1'), track('guess-2')];
    vi.mocked(provider.getGuessNext).mockResolvedValue([]);

    renderHook(() => useGuessContinuation(provider));

    act(() => {
      const store = usePlayerStore.getState();
      store.playTracks(first);
      store.startGuessSession();
    });

    act(() => {
      usePlayerStore.getState().tick(first[0]!.durationMs);
      usePlayerStore.getState().tick(first[1]!.durationMs);
    });

    await waitFor(() => {
      expect(usePlayerStore.getState().guessSessionActive).toBe(false);
    });
    expect(usePlayerStore.getState().queue).toHaveLength(2);
  });
});
