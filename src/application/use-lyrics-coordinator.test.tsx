import { createElement, type ReactNode } from 'react';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LyricDocument, Song } from '../domain/music';
import type { MusicProvider } from '../providers/music-provider';
import { useLyricsStore } from './lyrics-store';
import { initialPlayerState, usePlayerStore } from './player-store';
import { ProviderContext } from './provider-context';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('./native-player-runtime', () => ({
  isNativeRuntime: true,
}));

vi.mock('./yaqmc-runtime', () => ({
  getYaqmcClient: () => ({
    invoke,
    on: () => () => undefined,
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { useLyricsCoordinator } from './use-lyrics-coordinator';

const track: Song = {
  id: 'song-1',
  title: 'Song',
  artists: [{ id: 'artist', name: 'Artist' }],
  album: { id: 'album', title: 'Album' },
  artwork: { src: '/cover.svg', alt: 'Cover', dominantColor: '#000' },
  durationMs: 10_000,
  trackNumber: 1,
  isFavorite: false,
  quality: 'high',
  availability: { status: 'available' },
};

const document: LyricDocument = {
  songId: 'song-1',
  syncMode: 'line',
  metadata: { sourceLabel: 'test', offsetMs: 0 },
  vocalists: [],
  lines: [],
};

describe('useLyricsCoordinator', () => {
  const getLyrics = vi.fn();
  const provider = {
    id: 'qqmusic',
    displayName: 'QQ Music',
    getHome: vi.fn(),
    getDiscover: vi.fn(),
    getArea: vi.fn(),
    getSong: vi.fn(),
    getAlbum: vi.fn(),
    getArtist: vi.fn(),
    getArtistCatalog: vi.fn(),
    getPlaylist: vi.fn(),
    getLibrary: vi.fn(),
    getLyrics,
    search: vi.fn(),
  } satisfies MusicProvider;

  function wrapper({ children }: { children: ReactNode }) {
    return createElement(ProviderContext, { value: provider }, children);
  }

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    getLyrics.mockReset();
    getLyrics.mockResolvedValue(document);
    usePlayerStore.setState({
      ...initialPlayerState,
      queue: [track],
      currentIndex: 0,
      sessionId: 4,
      currentQueueEntryId: 'entry-1',
    });
    useLyricsStore.setState({
      songId: null,
      generation: 0,
      status: 'idle',
      document: null,
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('pushes loaded lyrics through player_set_lyrics with the document payload', async () => {
    renderHook(() => useLyricsCoordinator(), { wrapper });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('player_set_lyrics', { document });
    });
    expect(useLyricsStore.getState().document).toBe(document);
  });
});
