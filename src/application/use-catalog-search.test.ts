import { act, render } from '@testing-library/react';
import { createElement, StrictMode, useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { MusicProvider } from '../providers/music-provider';
import type {
  AlbumPreview,
  ArtistPreview,
  CatalogSearchKind,
  SearchResult,
  Song,
} from '../domain/music';
import { useCatalogSearch } from './use-catalog-search';

const song = (id: string): Song => ({
  id,
  title: id,
  artists: [],
  album: { id: `album-${id}`, title: 'Album' },
  artwork: { src: '', alt: id, dominantColor: '#000' },
  durationMs: 1000,
  trackNumber: 1,
  isFavorite: false,
  quality: 'standard',
  availability: { status: 'available' },
});

const artist = (id: string): ArtistPreview => ({
  id,
  name: id,
  artwork: { src: '', alt: id, dominantColor: '#000' },
});

const album = (id: string): AlbumPreview => ({
  id,
  title: id,
  artist: artist(`artist-${id}`),
  artwork: { src: '', alt: id, dominantColor: '#000' },
  releaseYear: 2024,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function rejectingDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function result<K extends CatalogSearchKind>(
  kind: K,
  query: string,
  items: K extends 'song' ? Song[] : K extends 'artist' ? ArtistPreview[] : AlbumPreview[],
  page = 1,
  hasMore = false,
): SearchResult {
  return { kind, query, items, page, hasMore } as SearchResult;
}

function createProvider(search: MusicProvider['search']): MusicProvider {
  return {
    id: 'test',
    displayName: 'Test',
    search,
  } as MusicProvider;
}

function Harness({
  provider,
  query,
  onValue,
}: {
  provider: MusicProvider;
  query: string;
  onValue: (value: ReturnType<typeof useCatalogSearch>) => void;
}) {
  const value = useCatalogSearch({ provider, query });
  useEffect(() => onValue(value), [onValue, value]);
  return null;
}

describe('useCatalogSearch', () => {
  it('loads only the default song category and lazily loads the selected category', async () => {
    const search = vi.fn(async (query: string, kind: CatalogSearchKind) =>
      kind === 'song'
        ? result('song', query, [song('song-1')])
        : result('artist', query, [artist('artist-1')]),
    );
    const provider = createProvider(search);
    let value!: ReturnType<typeof useCatalogSearch>;
    const onValue = (next: ReturnType<typeof useCatalogSearch>) => {
      value = next;
    };
    const view = render(createElement(Harness, { provider, query: 'needle', onValue }));

    await vi.waitFor(() =>
      expect(search).toHaveBeenCalledWith('needle', 'song', expect.any(AbortSignal), 1, 20),
    );
    expect(search).toHaveBeenCalledTimes(1);

    act(() => value.setActiveKind('artist'));
    await vi.waitFor(() =>
      expect(search).toHaveBeenCalledWith('needle', 'artist', expect.any(AbortSignal), 1, 20),
    );
    expect(search).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('clears every category on query changes and suppresses late old-query responses', async () => {
    let resolveOld!: (value: SearchResult) => void;
    let resolveNew!: (value: SearchResult) => void;
    const search = vi.fn(
      (query: string) =>
        new Promise<SearchResult>((resolve) => {
          if (query === 'old') resolveOld = resolve;
          else resolveNew = resolve;
        }),
    );
    const provider = createProvider(search);
    let value!: ReturnType<typeof useCatalogSearch>;
    const values: ReturnType<typeof useCatalogSearch>[] = [];
    const onValue = (next: ReturnType<typeof useCatalogSearch>) => {
      value = next;
      values.push(next);
    };
    const Wrapper = ({ query }: { query: string }) =>
      createElement(Harness, { provider, query, onValue });
    const view = render(createElement(Wrapper, { query: 'old' }));
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    expect(value.categories.song.status).toBe('loading');

    view.rerender(createElement(Wrapper, { query: 'new' }));
    expect(value.categories.song.items).toEqual([]);
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    expect(value.categories.song.items).toEqual([]);
    expect(value.query).toBe('new');

    act(() => resolveOld(result('song', 'old', [song('old-song')])));
    await Promise.resolve();
    expect(value.categories.song.items).toEqual([]);

    act(() => resolveNew(result('song', 'new', [song('new-song')])));
    await vi.waitFor(() => expect(value.categories.song.items).toEqual([song('new-song')]));
    expect(
      values.some((next) => next.categories.song.items.some((item) => item.id === 'old-song')),
    ).toBe(false);
    view.unmount();
  });

  it('appends and deduplicates pages per category while preserving items on page failure', async () => {
    let page = 1;
    const search = vi.fn(
      async (query: string, kind: CatalogSearchKind, _signal?: AbortSignal, requestedPage = 1) => {
        page = requestedPage;
        if (requestedPage > 1) throw new Error('page failed');
        return kind === 'song'
          ? result('song', query, [song('same'), song('first')], 1, true)
          : result('artist', query, [artist('artist')]);
      },
    );
    const provider = createProvider(search);
    let value!: ReturnType<typeof useCatalogSearch>;
    const onValue = (next: ReturnType<typeof useCatalogSearch>) => {
      value = next;
    };
    const view = render(createElement(Harness, { provider, query: 'needle', onValue }));
    await vi.waitFor(() => expect(value.categories.song.status).toBe('ready'));

    await act(async () => value.loadMore());
    expect(page).toBe(2);
    expect(value.categories.song.items.map((item) => item.id)).toEqual(['same', 'first']);
    expect(value.categories.song.paginationError).toBeTruthy();
    expect(value.categories.song.status).toBe('ready');
    view.unmount();
  });

  it('deduplicates initial non-empty IDs but preserves every empty-ID preview', async () => {
    const provider = createProvider(
      vi.fn(async (query: string) =>
        result('song', query, [song('same'), song('same'), song(''), song(' '), song('')]),
      ),
    );
    let value!: ReturnType<typeof useCatalogSearch>;
    const onValue = (next: ReturnType<typeof useCatalogSearch>) => {
      value = next;
    };
    const view = render(createElement(Harness, { provider, query: 'needle', onValue }));
    await vi.waitFor(() => expect(value.categories.song.status).toBe('ready'));
    expect(value.categories.song.items.map((item) => item.id)).toEqual(['same', '', ' ', '']);
    view.unmount();
  });

  it('turns a synchronous initial provider throw into a category error and retry can succeed', async () => {
    let attempts = 0;
    const search = vi.fn((query: string) => {
      attempts += 1;
      if (attempts === 1) throw new Error('sync failure');
      return Promise.resolve(result('song', query, [song('recovered')]));
    });
    const provider = createProvider(search);
    let value!: ReturnType<typeof useCatalogSearch>;
    const onValue = (next: ReturnType<typeof useCatalogSearch>) => {
      value = next;
    };
    const view = render(createElement(Harness, { provider, query: 'needle', onValue }));
    await vi.waitFor(() => expect(value.categories.song.status).toBe('error'));
    await act(async () => value.retry());
    await vi.waitFor(() => expect(value.categories.song.items).toEqual([song('recovered')]));
    expect(search).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('keeps a ready category isolated while another category retries', async () => {
    let artistAttempts = 0;
    const search = vi.fn(async (query: string, kind: CatalogSearchKind) => {
      if (kind === 'song') return result('song', query, [song('song-ready')]);
      artistAttempts += 1;
      if (artistAttempts === 1) throw new Error('artist failure');
      return result('artist', query, [artist('artist-recovered')]);
    });
    const provider = createProvider(search);
    let value!: ReturnType<typeof useCatalogSearch>;
    const onValue = (next: ReturnType<typeof useCatalogSearch>) => {
      value = next;
    };
    const view = render(createElement(Harness, { provider, query: 'needle', onValue }));
    await vi.waitFor(() => expect(value.categories.song.items).toEqual([song('song-ready')]));
    act(() => value.setActiveKind('artist'));
    await vi.waitFor(() => expect(value.categories.artist.status).toBe('error'));
    expect(value.categories.song.items).toEqual([song('song-ready')]);
    await act(async () => value.retry());
    await vi.waitFor(() =>
      expect(value.categories.artist.items).toEqual([artist('artist-recovered')]),
    );
    expect(value.categories.song.items).toEqual([song('song-ready')]);
    view.unmount();
  });

  it('does not request blank queries', async () => {
    const search = vi.fn(async () => result('song', 'ignored', [song('ignored')]));
    const provider = createProvider(search);
    const view = render(
      createElement(Harness, { provider, query: '   ', onValue: () => undefined }),
    );
    await Promise.resolve();
    expect(search).not.toHaveBeenCalled();
    view.unmount();
  });

  it('restarts an initial request after StrictMode effect cleanup', async () => {
    const requests: ReturnType<typeof deferred<SearchResult>>[] = [];
    const search = vi.fn((_query: string) => {
      const request = deferred<SearchResult>();
      requests.push(request);
      return request.promise;
    });
    const provider = createProvider(search);
    let value!: ReturnType<typeof useCatalogSearch>;
    const onValue = (next: ReturnType<typeof useCatalogSearch>) => {
      value = next;
    };
    const view = render(
      createElement(
        StrictMode,
        null,
        createElement(Harness, { provider, query: 'needle', onValue }),
      ),
    );
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    requests[1]!.resolve(result('song', 'needle', [song('strict-mode')]));
    await vi.waitFor(() => expect(value.categories.song.items).toEqual([song('strict-mode')]));
    view.unmount();
  });

  it('cancels an inactive category and refetches it when selected again', async () => {
    const pending = new Map<CatalogSearchKind, ReturnType<typeof deferred<SearchResult>>>();
    const signals: AbortSignal[] = [];
    const search = vi.fn((_query: string, kind: CatalogSearchKind, signal?: AbortSignal) => {
      const next = deferred<SearchResult>();
      pending.set(kind, next);
      if (signal) signals.push(signal);
      return next.promise;
    });
    const provider = createProvider(search);
    let value!: ReturnType<typeof useCatalogSearch>;
    const onValue = (next: ReturnType<typeof useCatalogSearch>) => {
      value = next;
    };
    const view = render(createElement(Harness, { provider, query: 'needle', onValue }));
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    act(() => value.setActiveKind('artist'));
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    expect(signals[0]?.aborted).toBe(true);
    act(() => value.setActiveKind('song'));
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(3));
    expect(signals[1]?.aborted).toBe(true);
    pending.get('song')?.resolve(result('song', 'needle', [song('song-2')]));
    await vi.waitFor(() => expect(value.categories.song.items).toEqual([song('song-2')]));
    view.unmount();
  });

  it('aborts, clears, and refetches when the provider object changes even with the same ID', async () => {
    const oldRequest = deferred<SearchResult>();
    const oldSearch = vi.fn((_query: string, _kind: CatalogSearchKind, signal?: AbortSignal) => {
      void signal;
      return oldRequest.promise;
    });
    const nextSearch = vi.fn(async (query: string) => result('song', query, [song('new')]));
    const firstProvider = createProvider(oldSearch);
    const secondProvider = createProvider(nextSearch);
    let value!: ReturnType<typeof useCatalogSearch>;
    const onValue = (next: ReturnType<typeof useCatalogSearch>) => {
      value = next;
    };
    const Wrapper = ({ provider }: { provider: MusicProvider }) =>
      createElement(Harness, { provider, query: 'needle', onValue });
    const view = render(createElement(Wrapper, { provider: firstProvider }));
    await vi.waitFor(() => expect(oldSearch).toHaveBeenCalledTimes(1));
    const oldSignal = oldSearch.mock.calls[0]?.[2];
    view.rerender(createElement(Wrapper, { provider: secondProvider }));
    await vi.waitFor(() => expect(nextSearch).toHaveBeenCalledTimes(1));
    expect(oldSignal?.aborted).toBe(true);
    expect(value.categories.artist.items).toEqual([]);
    await vi.waitFor(() => expect(value.categories.song.items).toEqual([song('new')]));
    view.unmount();
  });

  it('suppresses a late rejection from the previous query', async () => {
    const oldRequest = rejectingDeferred<SearchResult>();
    const newRequest = deferred<SearchResult>();
    const search = vi.fn((query: string) =>
      query === 'old' ? oldRequest.promise : newRequest.promise,
    );
    const provider = createProvider(search);
    let value!: ReturnType<typeof useCatalogSearch>;
    const onValue = (next: ReturnType<typeof useCatalogSearch>) => {
      value = next;
    };
    const Wrapper = ({ query }: { query: string }) =>
      createElement(Harness, { provider, query, onValue });
    const view = render(createElement(Wrapper, { query: 'old' }));
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    view.rerender(createElement(Wrapper, { query: 'new' }));
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    oldRequest.reject(new Error('late old failure'));
    await Promise.resolve();
    expect(value.categories.song.status).toBe('loading');
    newRequest.resolve(result('song', 'new', [song('new')]));
    await vi.waitFor(() => expect(value.categories.song.items).toEqual([song('new')]));
    view.unmount();
  });

  it('does not reuse category slots across A-to-B-to-A query changes', async () => {
    const search = vi.fn(async (query: string) => result('song', query, [song(query)]));
    const provider = createProvider(search);
    let value!: ReturnType<typeof useCatalogSearch>;
    const onValue = (next: ReturnType<typeof useCatalogSearch>) => {
      value = next;
    };
    const Wrapper = ({ query }: { query: string }) =>
      createElement(Harness, { provider, query, onValue });
    const view = render(createElement(Wrapper, { query: 'A' }));
    await vi.waitFor(() => expect(value.categories.song.items).toEqual([song('A')]));
    view.rerender(createElement(Wrapper, { query: 'B' }));
    expect(value.categories.artist.items).toEqual([]);
    await vi.waitFor(() => expect(value.categories.song.items).toEqual([song('B')]));
    view.rerender(createElement(Wrapper, { query: 'A' }));
    await vi.waitFor(() => expect(value.categories.song.items).toEqual([song('A')]));
    expect(search).toHaveBeenCalledTimes(3);
    view.unmount();
  });

  it('paginates each active kind with its own page and query and deduplicates non-empty IDs', async () => {
    const search = vi.fn(
      async (query: string, kind: CatalogSearchKind, _signal?: AbortSignal, page = 1) => {
        if (kind === 'song') {
          return page === 1
            ? result('song', query, [song('song-1')], 1, true)
            : result('song', query, [song('song-1'), song('song-2')], 2, false);
        }
        if (kind === 'artist') {
          return page === 1
            ? result('artist', query, [artist('artist-1')], 1, true)
            : result('artist', query, [artist('artist-1'), artist('artist-2')], 2, false);
        }
        return page === 1
          ? result('album', query, [album('album-1')], 1, true)
          : result('album', query, [album('album-1'), album('album-2')], 2, false);
      },
    );
    const provider = createProvider(search);
    let value!: ReturnType<typeof useCatalogSearch>;
    const onValue = (next: ReturnType<typeof useCatalogSearch>) => {
      value = next;
    };
    const view = render(createElement(Harness, { provider, query: 'needle', onValue }));
    await vi.waitFor(() => expect(value.categories.song.status).toBe('ready'));
    await act(async () => value.loadMore());
    expect(search).toHaveBeenLastCalledWith('needle', 'song', expect.any(AbortSignal), 2, 20);
    expect(value.categories.song.items.map((item) => item.id)).toEqual(['song-1', 'song-2']);

    act(() => value.setActiveKind('artist'));
    await vi.waitFor(() => expect(value.categories.artist.status).toBe('ready'));
    await act(async () => value.loadMore());
    expect(search).toHaveBeenLastCalledWith('needle', 'artist', expect.any(AbortSignal), 2, 20);
    expect(value.categories.artist.items.map((item) => item.id)).toEqual(['artist-1', 'artist-2']);

    act(() => value.setActiveKind('album'));
    await vi.waitFor(() => expect(value.categories.album.status).toBe('ready'));
    await act(async () => value.loadMore());
    expect(search).toHaveBeenLastCalledWith('needle', 'album', expect.any(AbortSignal), 2, 20);
    expect(value.categories.album.items.map((item) => item.id)).toEqual(['album-1', 'album-2']);
    view.unmount();
  });

  it('moves wrong initial kind/query/page responses to category-local errors', async () => {
    const search = vi.fn(async () => result('artist', 'wrong', [artist('wrong')]));
    const provider = createProvider(search);
    let value!: ReturnType<typeof useCatalogSearch>;
    const onValue = (next: ReturnType<typeof useCatalogSearch>) => {
      value = next;
    };
    const view = render(createElement(Harness, { provider, query: 'needle', onValue }));
    await vi.waitFor(() => expect(value.categories.song.status).toBe('error'));
    expect(value.categories.song.items).toEqual([]);
    view.unmount();

    const pageSearch = vi.fn(
      async (_query: string, _kind: CatalogSearchKind, _signal?: AbortSignal, page = 1) =>
        page === 1
          ? result('song', 'needle', [song('first')], 1, true)
          : result('song', 'needle', [song('next')], 3, false),
    );
    const pageProvider = createProvider(pageSearch);
    value = undefined!;
    const pageView = render(
      createElement(Harness, { provider: pageProvider, query: 'needle', onValue }),
    );
    await vi.waitFor(() => expect(value.categories.song.status).toBe('ready'));
    await act(async () => value.loadMore());
    expect(value.categories.song.items.map((item) => item.id)).toEqual(['first']);
    expect(value.categories.song.paginationError).toBeTruthy();
    pageView.unmount();
  });
});
