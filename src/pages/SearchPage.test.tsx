import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { ProviderContext } from '../application/provider-context';
import type { SearchResult, Song } from '../domain/music';
import { FakeMusicProvider } from '../providers/fake/fake-music-provider';
import { allSongs, homeFeed } from '../providers/fake/fixtures';
import { SearchPage } from './SearchPage';

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
    query,
    songs: [{ ...allSongs[0]!, id: `track-${query}`, title: `${query} result` }],
    albums: [],
    playlists: [],
    page: 1,
    hasMore: false,
  };
}

describe('SearchPage', () => {
  beforeEach(() => usePlayerStore.setState(initialPlayerState));

  it('renders every song appended by pagination', async () => {
    const provider = new FakeMusicProvider();
    vi.spyOn(provider, 'search').mockImplementation(async (query, _signal, page = 1) => ({
      query,
      songs: Array.from({ length: 8 }, (_, offset) => pagedSong((page - 1) * 8 + offset)),
      albums: [],
      playlists: [],
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

    fireEvent.click(screen.getByRole('button', { name: 'Load more songs' }));
    await waitFor(() => expect(container.querySelectorAll('.track-row')).toHaveLength(16));
    expect(screen.getByText('Page track 15')).toBeInTheDocument();
  });

  it('keeps the latest query authoritative when an aborted older request resolves last', async () => {
    const provider = new FakeMusicProvider();
    const first = deferred<Awaited<ReturnType<FakeMusicProvider['search']>>>();
    const second = deferred<Awaited<ReturnType<FakeMusicProvider['search']>>>();
    const signals: AbortSignal[] = [];
    vi.spyOn(provider, 'search').mockImplementation((query, signal) => {
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
    await waitFor(() => expect(provider.search).toHaveBeenCalledWith('邓紫棋', expect.anything()));

    fireEvent.change(input, { target: { value: '周杰伦' } });
    await waitFor(() => expect(provider.search).toHaveBeenCalledWith('周杰伦', expect.anything()));
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
});
