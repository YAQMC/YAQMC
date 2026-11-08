import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LyricDocument, Song } from '../domain/music';
import type { MusicProvider } from '../providers/music-provider';
import { useLyricsStore } from './lyrics-store';
import { initialPlayerState, usePlayerStore } from './player-store';
import { defaultPreferences, usePreferencesStore } from './preferences';
import { ProviderContext, ProviderRegistryContext } from './provider-context';
import { MusicProviderRegistry } from '../providers/provider-registry';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('./native-player-runtime', () => ({
  isNativeRuntime: true,
}));

vi.mock('./yaqmc-runtime', () => ({
  getYaqmcClient: () => ({
    invoke,
    on: () => () => undefined,
  }),
  getHostBridge: () => ({ kind: 'electron' }),
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
    profileId: 'default',
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

  it('loads lyrics from the playing track provider while browsing another platform', async () => {
    const origin = {
      ...provider,
      id: 'music.netease',
      profileId: 'work',
      getLyrics: vi.fn().mockResolvedValue({ ...document, songId: '123' }),
    };
    const active = { ...provider, id: 'music.spotify', getLyrics: vi.fn() };
    const registry = new MusicProviderRegistry(
      { providerId: active.id, profileId: active.profileId },
      [origin, active],
    );
    usePlayerStore.setState({
      queue: [
        {
          ...track,
          id: 'routed-song',
          provider: { providerId: origin.id, profileId: origin.profileId, trackId: '123' },
        },
      ],
    });
    renderHook(() => useLyricsCoordinator(), {
      wrapper: ({ children }) =>
        createElement(
          ProviderRegistryContext,
          { value: registry },
          createElement(ProviderContext, { value: active }, children),
        ),
    });
    await waitFor(() => expect(useLyricsStore.getState().status).toBe('ready'));
    expect(origin.getLyrics).toHaveBeenCalledWith('123', expect.any(AbortSignal));
    expect(active.getLyrics).not.toHaveBeenCalled();
    expect(useLyricsStore.getState().document?.songId).toBe('routed-song');
  });

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    usePreferencesStore.setState({ lyrics: defaultPreferences.lyrics });
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

  it.each([
    ['cmn', '十年', undefined],
    ['cmn', '十年', 'shí nián'],
    ['ja', '夢ならば', 'yu me na ra ba'],
    ['yue', '拦路雨', 'laan lou jyu'],
    ['vi', 'Em ơi', undefined],
  ])(
    'preserves provider romanization for %s without filling missing data',
    async (language, text, romanization) => {
      const provided: LyricDocument = {
        ...document,
        metadata: { ...document.metadata, language },
        lines: [{ id: 'l1', startMs: 0, endMs: 1000, text, words: [], romanization }],
      };
      usePreferencesStore.setState({
        lyrics: { ...defaultPreferences.lyrics, romanization: 'hide' },
      });
      getLyrics.mockResolvedValue(provided);
      renderHook(() => useLyricsCoordinator(), { wrapper });
      await waitFor(() => expect(useLyricsStore.getState().document).toBe(provided));
      act(() =>
        usePreferencesStore.setState({
          lyrics: { ...defaultPreferences.lyrics, romanization: 'show' },
        }),
      );
      expect(useLyricsStore.getState().document).toBe(provided);
      expect(invoke).toHaveBeenCalledExactlyOnceWith('player_set_lyrics', { document: provided });
      expect(getLyrics).toHaveBeenCalledTimes(1);
    },
  );

  it('does not publish a previous track response after switching tracks', async () => {
    let finish: (value: LyricDocument) => void = () => undefined;
    const nextDocument = { ...document, songId: 'song-2' };
    getLyrics
      .mockReturnValueOnce(new Promise<LyricDocument>((resolve) => (finish = resolve)))
      .mockResolvedValue(nextDocument);
    renderHook(() => useLyricsCoordinator(), { wrapper });
    await waitFor(() => expect(getLyrics).toHaveBeenCalledTimes(1));
    const signal = getLyrics.mock.calls[0]?.[1] as AbortSignal;
    act(() => usePlayerStore.setState({ queue: [{ ...track, id: 'song-2' }] }));
    await waitFor(() => expect(useLyricsStore.getState().document).toBe(nextDocument));
    expect(signal.aborted).toBe(true);
    await act(async () => finish(document));
    expect(invoke).toHaveBeenCalledExactlyOnceWith('player_set_lyrics', { document: nextDocument });
  });
});
