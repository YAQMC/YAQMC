import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { ProviderContext } from '../application/provider-context';
import { NavigationProvider } from '../application/navigation-context';
import type {
  AlbumPreview,
  ArtistPreview,
  PlaylistPreview,
  SearchResult,
  Song,
} from '../domain/music';
import { FakeMusicProvider } from '../providers/fake/fake-music-provider';
import { allSongs, homeFeed } from '../providers/fake/fixtures';
import { SearchPage } from './SearchPage';

const hostRuntime = vi.hoisted(() => ({ android: false }));

vi.mock('../application/host-capabilities', () => ({
  isAndroidRuntime: () => hostRuntime.android,
}));

function pagedSong(index: number): Song {
  const fixture = allSongs[0]!;
  return { ...fixture, id: `page-track-${index}`, title: `Page track ${index}` };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function resultFor(query: string): SearchResult {
  return {
    kind: 'song',
    query,
    items: [{ ...allSongs[0]!, id: `track-${query}`, title: `${query} result` }],
    page: 1,
    hasMore: false,
  };
}

function artistResult(query: string): SearchResult {
  const item: ArtistPreview = {
    id: 'artist-1',
    name: 'Artist result',
    artwork: { src: '', alt: 'Artist result', dominantColor: '#000' },
  };
  return { kind: 'artist', query, items: [item], page: 1, hasMore: false };
}

function albumResult(query: string): SearchResult {
  const item: AlbumPreview = {
    id: 'album-1',
    title: 'Album result',
    artist: {
      id: 'artist-1',
      name: 'Album artist',
      artwork: { src: '', alt: 'Album artist', dominantColor: '#000' },
    },
    artwork: { src: '', alt: 'Album result', dominantColor: '#000' },
    releaseYear: 2024,
  };
  return { kind: 'album', query, items: [item], page: 1, hasMore: false };
}

function playlistResult(query: string): SearchResult {
  const item: PlaylistPreview = {
    id: 'playlist-1',
    title: 'Playlist result',
    creator: 'Playlist creator',
    artwork: { src: '', alt: 'Playlist result', dominantColor: '#000' },
    trackCount: 42,
  };
  return { kind: 'playlist', query, items: [item], page: 1, hasMore: false };
}

function emptyIdResults(query: string): SearchResult {
  return {
    kind: 'artist',
    query,
    items: [
      {
        id: ' ',
        name: 'No artist ID',
        artwork: { src: '', alt: 'No artist ID', dominantColor: '#000' },
      },
    ],
    page: 1,
    hasMore: false,
  };
}

describe('SearchPage', () => {
  const intersectionCallbacks: IntersectionObserverCallback[] = [];

  beforeEach(() => {
    hostRuntime.android = false;
    usePlayerStore.setState(initialPlayerState);
    intersectionCallbacks.length = 0;
    vi.stubGlobal(
      'IntersectionObserver',
      class MockIntersectionObserver implements IntersectionObserver {
        readonly root = null;
        readonly rootMargin = '';
        readonly scrollMargin = '';
        readonly thresholds = [];

        constructor(callback: IntersectionObserverCallback) {
          intersectionCallbacks.push(callback);
        }

        disconnect() {}
        observe() {}
        takeRecords() {
          return [];
        }
        unobserve() {}
      },
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('buffers Android IME composition and lets the keyboard search action submit once', async () => {
    hostRuntime.android = true;
    const provider = new FakeMusicProvider();
    vi.spyOn(provider, 'search').mockImplementation(async (query) => resultFor(query));
    render(
      <ProviderContext.Provider value={provider}>
        <SearchPage feed={homeFeed} onNavigate={() => undefined} />
      </ProviderContext.Provider>,
    );

    const input = screen.getByRole('textbox', { name: 'Search music' });
    expect(input).toHaveAttribute('enterkeyhint', 'search');
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '周' } });
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 320)));
    expect(provider.search).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '周杰伦' } });
    fireEvent.compositionEnd(input);
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() =>
      expect(provider.search).toHaveBeenCalledWith(
        '周杰伦',
        'song',
        expect.any(AbortSignal),
        1,
        20,
      ),
    );
    expect(provider.search).toHaveBeenCalledTimes(1);
  });

  it('replaces the live query when navigation supplies a different search route', async () => {
    const provider = new FakeMusicProvider();
    vi.spyOn(provider, 'search').mockImplementation(async (query) => resultFor(query));
    const view = (initialQuery: string) => (
      <ProviderContext.Provider value={provider}>
        <SearchPage
          key={`search:${initialQuery}`}
          initialQuery={initialQuery}
          feed={homeFeed}
          onNavigate={() => undefined}
        />
      </ProviderContext.Provider>
    );
    const { rerender } = render(view('first'));

    await screen.findByText('first result');
    rerender(view('second'));

    expect(screen.getByRole('textbox', { name: 'Search music' })).toHaveValue('second');
    await screen.findByText('second result');
    expect(screen.queryByText('first result')).not.toBeInTheDocument();
  });

  it('automatically appends the next page when the bottom sentinel intersects', async () => {
    const provider = new FakeMusicProvider();
    vi.spyOn(provider, 'search').mockImplementation(async (query, _kind, _signal, page = 1) => ({
      kind: 'song',
      query,
      items: Array.from({ length: 8 }, (_, offset) => pagedSong((page - 1) * 8 + offset)),
      page,
      hasMore: page === 1,
    }));

    const { container } = render(
      <ProviderContext.Provider value={provider}>
        <SearchPage feed={homeFeed} onNavigate={() => undefined} />
      </ProviderContext.Provider>,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Search music' }), {
      target: { value: 'page' },
    });
    await waitFor(() => expect(container.querySelectorAll('.track-row')).toHaveLength(8));
    await waitFor(() => expect(intersectionCallbacks).toHaveLength(1));
    expect(screen.queryByRole('button', { name: /Load more/i })).not.toBeInTheDocument();

    act(() => {
      intersectionCallbacks[0]?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    await waitFor(() => expect(container.querySelectorAll('.track-row')).toHaveLength(16));
    expect(screen.getByText('Page track 15')).toBeInTheDocument();
    expect(provider.search).toHaveBeenLastCalledWith(
      'page',
      'song',
      expect.any(AbortSignal),
      2,
      20,
    );
  });

  it('keeps the latest query authoritative when an aborted older request resolves last', async () => {
    const provider = new FakeMusicProvider();
    const first = deferred<Awaited<ReturnType<FakeMusicProvider['search']>>>();
    const second = deferred<Awaited<ReturnType<FakeMusicProvider['search']>>>();
    const signals: AbortSignal[] = [];
    vi.spyOn(provider, 'search').mockImplementation((query, _kind, signal) => {
      if (signal) signals.push(signal);
      return query === '邓紫棋' ? first.promise : second.promise;
    });

    render(
      <ProviderContext.Provider value={provider}>
        <SearchPage feed={homeFeed} onNavigate={() => undefined} />
      </ProviderContext.Provider>,
    );

    const input = screen.getByRole('textbox', { name: 'Search music' });
    fireEvent.change(input, { target: { value: '邓紫棋' } });
    await waitFor(() =>
      expect(provider.search).toHaveBeenCalledWith('邓紫棋', 'song', expect.anything(), 1, 20),
    );

    fireEvent.change(input, { target: { value: '周杰伦' } });
    await waitFor(() =>
      expect(provider.search).toHaveBeenCalledWith('周杰伦', 'song', expect.anything(), 1, 20),
    );
    expect(signals[0]?.aborted).toBe(true);
    expect(screen.queryByText('邓紫棋 result')).not.toBeInTheDocument();

    second.resolve(resultFor('周杰伦'));
    await waitFor(() => expect(screen.getByText('周杰伦 result')).toBeInTheDocument());
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('“周杰伦”');

    first.resolve(resultFor('邓紫棋'));
    await Promise.resolve();
    expect(screen.getByText('周杰伦 result')).toBeInTheDocument();
    expect(screen.queryByText('邓紫棋 result')).not.toBeInTheDocument();
    expect(input).toHaveValue('周杰伦');
  });

  it('hides the previous payload as soon as the input changes', async () => {
    const provider = new FakeMusicProvider();
    const next = deferred<Awaited<ReturnType<FakeMusicProvider['search']>>>();
    vi.spyOn(provider, 'search').mockImplementation((query) =>
      query === '邓紫棋' ? Promise.resolve(resultFor(query)) : next.promise,
    );

    render(
      <ProviderContext.Provider value={provider}>
        <SearchPage feed={homeFeed} onNavigate={() => undefined} />
      </ProviderContext.Provider>,
    );

    const input = screen.getByRole('textbox', { name: 'Search music' });
    fireEvent.change(input, { target: { value: '邓紫棋' } });
    await screen.findByText('邓紫棋 result');

    fireEvent.change(input, { target: { value: '林俊杰' } });
    expect(screen.queryByText('邓紫棋 result')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '“邓紫棋”' })).not.toBeInTheDocument();

    next.resolve(resultFor('林俊杰'));
    await screen.findByText('林俊杰 result');
  });

  it('does not discard a result when only surrounding input whitespace changes', async () => {
    const provider = new FakeMusicProvider();
    vi.spyOn(provider, 'search').mockImplementation(async (query) => resultFor(query));

    render(
      <ProviderContext.Provider value={provider}>
        <SearchPage feed={homeFeed} onNavigate={() => undefined} />
      </ProviderContext.Provider>,
    );

    const input = screen.getByRole('textbox', { name: 'Search music' });
    fireEvent.change(input, { target: { value: '周杰伦' } });
    await screen.findByText('周杰伦 result');

    fireEvent.change(input, { target: { value: ' 周杰伦 ' } });

    expect(screen.getByText('周杰伦 result')).toBeInTheDocument();
    expect(provider.search).toHaveBeenCalledTimes(1);
  });

  it('requests only the active kind and reuses a ready category within a query', async () => {
    const provider = new FakeMusicProvider();
    vi.spyOn(provider, 'search').mockImplementation(async (query, kind) => {
      if (kind === 'artist') return artistResult(query);
      if (kind === 'album') return albumResult(query);
      if (kind === 'playlist') return playlistResult(query);
      return resultFor(query);
    });

    render(
      <ProviderContext.Provider value={provider}>
        <NavigationProvider onNavigate={() => undefined}>
          <SearchPage feed={homeFeed} onNavigate={() => undefined} />
        </NavigationProvider>
      </ProviderContext.Provider>,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Search music' }), {
      target: { value: 'needle' },
    });
    await waitFor(() => expect(provider.search).toHaveBeenCalledTimes(1));
    expect(provider.search).toHaveBeenLastCalledWith(
      'needle',
      'song',
      expect.any(AbortSignal),
      1,
      20,
    );
    expect(screen.getByRole('tab', { name: 'Songs' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('tab', { name: 'Artists' }));
    await screen.findByText('Artist result');
    expect(provider.search).toHaveBeenLastCalledWith(
      'needle',
      'artist',
      expect.any(AbortSignal),
      1,
      20,
    );
    expect(provider.search).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('tab', { name: 'Songs' }));
    await screen.findByText('needle result');
    expect(provider.search).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('tab', { name: 'Playlists' }));
    await screen.findByText('Playlist result');
    expect(provider.search).toHaveBeenLastCalledWith(
      'needle',
      'playlist',
      expect.any(AbortSignal),
      1,
      20,
    );
    expect(provider.search).toHaveBeenCalledTimes(3);
  });

  it('uses exact artist, album, and playlist routes without adding preview play controls', async () => {
    const provider = new FakeMusicProvider();
    const onNavigate = vi.fn();
    vi.spyOn(provider, 'search').mockImplementation(async (query, kind) => {
      if (kind === 'artist') return artistResult(query);
      if (kind === 'album') return albumResult(query);
      if (kind === 'playlist') return playlistResult(query);
      return resultFor(query);
    });

    render(
      <ProviderContext.Provider value={provider}>
        <NavigationProvider onNavigate={onNavigate}>
          <SearchPage feed={homeFeed} onNavigate={onNavigate} />
        </NavigationProvider>
      </ProviderContext.Provider>,
    );
    const input = screen.getByRole('textbox', { name: 'Search music' });
    fireEvent.change(input, { target: { value: 'needle' } });
    await waitFor(() => expect(provider.search).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('tab', { name: 'Artists' }));
    await screen.findByText('Artist result');
    fireEvent.click(screen.getByRole('button', { name: 'Artist result' }));
    expect(onNavigate).toHaveBeenCalledWith({ page: 'artist', id: 'artist-1' });

    fireEvent.click(screen.getByRole('tab', { name: 'Albums' }));
    await screen.findByText('Album result');
    expect(screen.queryByRole('button', { name: /play/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Album result' }));
    fireEvent.click(screen.getByRole('button', { name: 'Album artist' }));
    expect(onNavigate).toHaveBeenCalledWith({ page: 'album', id: 'album-1' });
    expect(onNavigate).toHaveBeenCalledWith({ page: 'artist', id: 'artist-1' });

    fireEvent.click(screen.getByRole('tab', { name: 'Playlists' }));
    await screen.findByText('Playlist result');
    expect(screen.getByText('Playlist creator')).toBeInTheDocument();
    expect(screen.getByText('42 tracks')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Playlist result' }));
    expect(onNavigate).toHaveBeenCalledWith({ page: 'playlist', id: 'playlist-1' });
  });

  it('keeps invalid preview IDs semantic and exposes all four search categories', async () => {
    const provider = new FakeMusicProvider();
    const onNavigate = vi.fn();
    vi.spyOn(provider, 'search').mockImplementation(async (query, kind) => {
      if (kind === 'artist') return emptyIdResults(query);
      if (kind === 'album') {
        return {
          kind: 'album',
          query,
          items: [
            {
              id: '',
              title: 'No album ID',
              artist: {
                id: ' ',
                name: 'No album artist ID',
                artwork: { src: '', alt: '', dominantColor: '#000' },
              },
              artwork: { src: '', alt: 'No album ID', dominantColor: '#000' },
              releaseYear: 0,
            },
          ],
          page: 1,
          hasMore: false,
        };
      }
      if (kind === 'playlist') {
        return {
          kind: 'playlist',
          query,
          items: [
            {
              id: ' ',
              title: 'No playlist ID',
              creator: '',
              artwork: { src: '', alt: 'No playlist ID', dominantColor: '#000' },
              trackCount: 0,
            },
          ],
          page: 1,
          hasMore: false,
        };
      }
      return resultFor(query);
    });
    render(
      <ProviderContext.Provider value={provider}>
        <NavigationProvider onNavigate={onNavigate}>
          <SearchPage feed={homeFeed} onNavigate={onNavigate} />
        </NavigationProvider>
      </ProviderContext.Provider>,
    );
    const input = screen.getByRole('textbox', { name: 'Search music' });
    expect(input).toHaveAttribute('placeholder', 'Search songs, artists, albums, and playlists');
    fireEvent.change(input, { target: { value: 'needle' } });
    await waitFor(() => expect(provider.search).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('tab', { name: 'Playlists' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Artists' }));
    await screen.findByText('No artist ID');
    expect(screen.queryByRole('button', { name: 'No artist ID' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('No artist ID'));
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: 'Albums' }));
    await screen.findByText('No album ID');
    expect(screen.queryByRole('button', { name: 'No album ID' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'No album artist ID' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Playlists' }));
    await screen.findByText('No playlist ID');
    expect(screen.queryByRole('button', { name: 'No playlist ID' })).not.toBeInTheDocument();
  });

  it('supports roving Arrow/Home/End tab focus including preventDefault at boundaries', async () => {
    const provider = new FakeMusicProvider();
    vi.spyOn(provider, 'search').mockImplementation(async (query, kind) =>
      kind === 'song'
        ? resultFor(query)
        : kind === 'artist'
          ? artistResult(query)
          : kind === 'album'
            ? albumResult(query)
            : playlistResult(query),
    );
    render(
      <ProviderContext.Provider value={provider}>
        <NavigationProvider onNavigate={() => undefined}>
          <SearchPage feed={homeFeed} onNavigate={() => undefined} />
        </NavigationProvider>
      </ProviderContext.Provider>,
    );
    const input = screen.getByRole('textbox', { name: 'Search music' });
    fireEvent.change(input, { target: { value: 'needle' } });
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Songs' })).toHaveAttribute('aria-selected', 'true'),
    );
    const songsTab = screen.getByRole('tab', { name: 'Songs' });
    songsTab.focus();
    const home = createEvent.keyDown(songsTab, { key: 'Home' });
    const homePreventDefault = vi.spyOn(home, 'preventDefault');
    fireEvent(songsTab, home);
    expect(homePreventDefault).toHaveBeenCalled();
    expect(document.activeElement).toBe(songsTab);

    fireEvent.keyDown(songsTab, { key: 'ArrowRight' });
    const artistsTab = screen.getByRole('tab', { name: 'Artists' });
    expect(document.activeElement).toBe(artistsTab);
    expect(artistsTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(artistsTab, { key: 'End' });
    const playlistsTab = screen.getByRole('tab', { name: 'Playlists' });
    expect(document.activeElement).toBe(playlistsTab);
    const end = createEvent.keyDown(playlistsTab, { key: 'End' });
    const endPreventDefault = vi.spyOn(end, 'preventDefault');
    fireEvent(playlistsTab, end);
    expect(endPreventDefault).toHaveBeenCalled();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'search-tab-playlist');
  });

  it('does not emit duplicate-key warnings for repeated initial previews', async () => {
    const provider = new FakeMusicProvider();
    vi.spyOn(provider, 'search').mockImplementation(async (query, kind) => {
      if (kind === 'artist') {
        const item = {
          ...(artistResult(query).items[0] as ArtistPreview),
          id: 'duplicate-artist',
          name: 'duplicate-artist',
        };
        return { kind, query, items: [item, { ...item }], page: 1, hasMore: false };
      }
      return resultFor(query);
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(
        <ProviderContext.Provider value={provider}>
          <NavigationProvider onNavigate={() => undefined}>
            <SearchPage feed={homeFeed} onNavigate={() => undefined} />
          </NavigationProvider>
        </ProviderContext.Provider>,
      );
      const input = screen.getByRole('textbox', { name: 'Search music' });
      fireEvent.change(input, { target: { value: 'needle' } });
      await waitFor(() => expect(provider.search).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole('tab', { name: 'Artists' }));
      await screen.findAllByText('duplicate-artist');
      expect(consoleError).not.toHaveBeenCalledWith(
        expect.stringContaining('Each child in a list'),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
