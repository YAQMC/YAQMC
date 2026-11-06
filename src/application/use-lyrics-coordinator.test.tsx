import { createElement, type ReactNode } from 'react';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LyricDocument, Song } from '../domain/music';
import type { MusicProvider } from '../providers/music-provider';
import { useLyricsStore } from './lyrics-store';
import { initialPlayerState, usePlayerStore } from './player-store';
import { defaultPreferences, usePreferencesStore } from './preferences';
import { ProviderContext, ProviderRegistryContext } from './provider-context';
import { MusicProviderRegistry } from '../providers/provider-registry';

const invoke = vi.hoisted(() => vi.fn());
const generate = vi.hoisted(() => vi.fn());

vi.mock('./lyrics-pinyin', async (importActual) => ({
  ...(await importActual<object>()),
  withGeneratedPinyin: generate,
}));

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
    generate.mockReset();
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

  const line = { id: 'l1', startMs: 0, endMs: 1000, text: '十年', words: [] };
  const mandarin: LyricDocument = {
    ...document,
    metadata: { ...document.metadata, language: 'cmn' },
    lines: [line],
  };
  const withPinyin: LyricDocument = {
    ...mandarin,
    lines: [{ ...line, romanization: 'shí nián' }],
  };

  it('publishes generated pinyin for Mandarin lyrics after the provider document', async () => {
    getLyrics.mockResolvedValue(mandarin);
    generate.mockResolvedValue(withPinyin);
    renderHook(() => useLyricsCoordinator(), { wrapper });

    await waitFor(() => expect(useLyricsStore.getState().document).toBe(withPinyin));
    expect(generate).toHaveBeenCalledWith(mandarin, expect.any(AbortSignal));
    expect(invoke).toHaveBeenNthCalledWith(1, 'player_set_lyrics', { document: mandarin });
    expect(invoke).toHaveBeenNthCalledWith(2, 'player_set_lyrics', { document: withPinyin });
  });

  it('does not generate when romanization is hidden or the language is not Mandarin', async () => {
    usePreferencesStore.setState({
      lyrics: { ...defaultPreferences.lyrics, romanization: 'hide' },
    });
    getLyrics.mockResolvedValue(mandarin);
    renderHook(() => useLyricsCoordinator(), { wrapper });
    await waitFor(() => expect(useLyricsStore.getState().document).toBe(mandarin));
    cleanup();

    usePreferencesStore.setState({ lyrics: defaultPreferences.lyrics });
    const cantonese = { ...mandarin, metadata: { ...mandarin.metadata, language: 'yue' } };
    getLyrics.mockResolvedValue(cantonese);
    usePlayerStore.setState({ sessionId: 5 });
    renderHook(() => useLyricsCoordinator(), { wrapper });
    await waitFor(() => expect(useLyricsStore.getState().document).toBe(cantonese));
    expect(generate).not.toHaveBeenCalled();
  });

  it('drops pinyin generated for a track that is no longer playing', async () => {
    let finish: (value: LyricDocument) => void = () => undefined;
    getLyrics.mockResolvedValueOnce(mandarin).mockResolvedValue(document);
    generate.mockReturnValue(new Promise<LyricDocument>((resolve) => (finish = resolve)));
    renderHook(() => useLyricsCoordinator(), { wrapper });
    await waitFor(() => expect(generate).toHaveBeenCalled());

    usePlayerStore.setState({ queue: [{ ...track, id: 'song-2' }] });
    await waitFor(() => expect(useLyricsStore.getState().songId).toBe('song-2'));
    // The track change cancels the worker for the old track.
    expect((generate.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
    finish(withPinyin);
    await Promise.resolve();

    expect(invoke).not.toHaveBeenCalledWith('player_set_lyrics', { document: withPinyin });
    expect(useLyricsStore.getState().document).not.toBe(withPinyin);
  });
});
