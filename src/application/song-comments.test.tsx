import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';
import { ProviderContext, ProviderRegistryContext } from './provider-context';
import { MusicProviderRegistry } from '../providers/provider-registry';
import { useLyricsCoordinator } from './use-lyrics-coordinator';
import { useLyricsStore } from './lyrics-store';
import { initialPlayerState, usePlayerStore } from './player-store';
import { useSongComments } from './song-comments';
import { FakeMusicProvider } from '../providers/fake/fake-music-provider';
import { allSongs } from '../providers/fake/fixtures';
import type { MusicProvider } from '../providers/music-provider';
import type { SongCommentsPage } from '../domain/music';

const song = {
  ...allSongs[0]!,
  provider: {
    ...allSongs[0]!.provider!,
    providerId: 'fake',
    profileId: 'default',
    trackId: 'native-1',
  },
};
const page: SongCommentsPage = {
  items: [{ id: 'c1', content: 'A comment', author: 'Listener', likedCount: 2 }],
  nextCursor: 'page2',
  total: 2,
  supportedSorts: ['hot', 'new'],
  repliesSupported: true,
};
function setup(getComments = vi.fn().mockResolvedValue(page)) {
  const provider: MusicProvider = new FakeMusicProvider();
  provider.getComments = getComments;
  const wrapper = ({ children }: PropsWithChildren) => (
    <ProviderContext.Provider value={provider}>{children}</ProviderContext.Provider>
  );
  return { provider, getComments, wrapper };
}

describe('song comments', () => {
  it('continues beyond 500 rows with a bounded display window and stable danmaku', async () => {
    const { getComments, wrapper } = setup();
    getComments.mockImplementation(async ({ cursor }: { cursor: string | null }) => {
      const start = Number(cursor ?? 0);
      return {
        ...page,
        items: Array.from({ length: 20 }, (_, offset) => ({
          ...page.items[0]!,
          id: String(start + offset),
        })),
        nextCursor: String(start + 20),
      };
    });
    const { result } = renderHook(() => useSongComments(song, true), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    for (let next = 20; next <= 520; next += 20) {
      await act(async () => result.current.loadMore());
      expect(result.current.items.at(-1)?.id).toBe(String(next + 19));
    }
    expect(result.current.items).toHaveLength(500);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.windowStart).toBe(40);
    expect(result.current.popularItems[0]?.id).toBe('0');
    await act(async () => result.current.restart());
    expect(result.current.items[0]?.id).toBe('0');
    expect(result.current.windowStart).toBe(0);
  });
  it('drains every row of an oversized final page before ending pagination', async () => {
    const { getComments, wrapper } = setup();
    getComments.mockResolvedValue({
      ...page,
      items: Array.from({ length: 505 }, (_, id) => ({ ...page.items[0]!, id: String(id) })),
      nextCursor: null,
    });
    const { result } = renderHook(() => useSongComments(song, true), { wrapper });
    await waitFor(() => expect(result.current.items).toHaveLength(500));
    expect(result.current.items.at(-1)?.id).toBe('499');
    expect(result.current.hasMore).toBe(true);
    await act(async () => result.current.loadMore());
    expect(result.current.items.at(-1)?.id).toBe('504');
    expect(result.current.items).toHaveLength(500);
    expect(result.current.hasMore).toBe(false);
    expect(getComments).toHaveBeenCalledTimes(1);
  });
  beforeEach(() => {
    useLyricsStore.setState({ songId: null, document: null, status: 'idle', generation: 0 });
    usePlayerStore.setState(initialPlayerState);
  });
  it('shares requests between the panel and danmaku and forwards original track IDs', async () => {
    const { getComments, wrapper } = setup();
    const { result } = renderHook(
      () => [useSongComments(song, true), useSongComments(song, true)],
      { wrapper },
    );
    await waitFor(() => expect(result.current[0]!.status).toBe('ready'));
    expect(getComments).toHaveBeenCalledTimes(1);
    expect(getComments.mock.calls[0]![0]).toMatchObject({
      songId: 'native-1',
      sort: 'hot',
      limit: 20,
    });
    expect(result.current[0]!.items).toBe(result.current[1]!.items);
  });
  it('does not fetch while closed or use a different provider/profile', () => {
    const { getComments, wrapper } = setup();
    const { result } = renderHook(
      () => [
        useSongComments(song, false),
        useSongComments({ ...song, provider: { ...song.provider, profileId: 'other' } }, true),
      ],
      { wrapper },
    );
    expect(result.current[1]!.status).toBe('unsupported');
    expect(getComments).not.toHaveBeenCalled();
  });

  it('reports a bounded reply-thread limitation separately from retryable loading failures', async () => {
    const { getComments, wrapper } = setup();
    getComments.mockRejectedValue({ code: 'comments-limit-exceeded', retryable: false });
    const { result } = renderHook(() => useSongComments(song, true, 'new', 'parent'), { wrapper });
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.limited).toBe(true);
    expect(result.current.items).toHaveLength(0);
  });

  it('trims closed entries to forty while retaining concurrently viewed entries', async () => {
    const { getComments, wrapper } = setup();
    const viewers: Array<{ unmount: () => void }> = [];
    for (let index = 0; index < 45; index++) {
      const viewer = renderHook(
        () =>
          useSongComments(
            { ...song, provider: { ...song.provider, trackId: `idle-${index}` } },
            true,
          ),
        { wrapper },
      );
      // Avoid multiplying the default 50 ms polling delay by 45 sequential viewers.
      await waitFor(() => expect(viewer.result.current.status).toBe('ready'), { interval: 1 });
      viewers.push(viewer);
    }
    act(() => viewers.forEach((viewer) => viewer.unmount()));
    getComments.mockImplementation(() => new Promise(() => {}));
    const oldest = renderHook(
      () => useSongComments({ ...song, provider: { ...song.provider, trackId: 'idle-0' } }, true),
      { wrapper },
    );
    expect(oldest.result.current.items).toHaveLength(0);
    const newest = renderHook(
      () => useSongComments({ ...song, provider: { ...song.provider, trackId: 'idle-44' } }, true),
      { wrapper },
    );
    expect(newest.result.current.items).toHaveLength(1);
  });
  it('deduplicates page overlap, stops repeated cursors and keeps loaded comments on failure', async () => {
    const { getComments, wrapper } = setup();
    getComments
      .mockResolvedValueOnce(page)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ...page, items: [...page.items, { ...page.items[0]!, id: 'c2' }] });
    const { result } = renderHook(() => useSongComments(song, true), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.items).toHaveLength(1);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.nextCursor).toBeNull();
    expect(getComments.mock.calls[2]![0]).toMatchObject({ cursor: 'page2' });
  });
  it('cancels on song changes and ignores late responses', async () => {
    let finish!: (value: SongCommentsPage) => void;
    const getComments = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<SongCommentsPage>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ ...page, items: [{ ...page.items[0]!, id: 'new-song' }] });
    const { wrapper } = setup(getComments);
    const { result, rerender } = renderHook(({ current }) => useSongComments(current, true), {
      wrapper,
      initialProps: { current: song },
    });
    const signal = getComments.mock.calls[0]![1] as AbortSignal;
    rerender({
      current: { ...song, id: 'different', provider: { ...song.provider, trackId: 'native-2' } },
    });
    await waitFor(() => expect(result.current.items[0]?.id).toBe('new-song'));
    expect(signal.aborted).toBe(true);
    await act(async () => finish(page));
    expect(result.current.items[0]!.id).toBe('new-song');
  });
  it('falls back to legacy lyric comments with popular-only sorting', async () => {
    const { provider, wrapper } = setup();
    delete provider.getComments;
    vi.spyOn(provider, 'getLyrics').mockResolvedValue({
      songId: 'native-1',
      syncMode: 'line',
      metadata: { sourceLabel: 'Legacy', offsetMs: 0 },
      lines: [],
      vocalists: [],
      comments: page.items,
    });
    const { result } = renderHook(() => useSongComments(song, true), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.supportedSorts).toEqual(['hot']);
    expect(result.current.repliesSupported).toBe(false);
  });
  it('reloads the first page on reopening and replaces old pagination without hiding cached items', async () => {
    let finish!: (value: SongCommentsPage) => void;
    const { getComments, wrapper } = setup();
    getComments
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce({
        ...page,
        items: [{ ...page.items[0]!, id: 'old-page-2' }],
        nextCursor: 'page3',
      })
      .mockImplementationOnce(
        () =>
          new Promise<SongCommentsPage>((resolve) => {
            finish = resolve;
          }),
      );
    const { result, rerender } = renderHook(
      ({ enabled }) => useSongComments(song, enabled, 'new'),
      {
        wrapper,
        initialProps: { enabled: true },
      },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(result.current.items).toHaveLength(2);
    expect(result.current.status).toBe('ready');
    expect(getComments.mock.calls[2]![0]).toMatchObject({ cursor: null, sort: 'new' });
    await act(async () =>
      finish({
        ...page,
        items: [{ ...page.items[0]!, id: 'fresh' }],
        nextCursor: 'fresh-page2',
        total: 3,
      }),
    );
    expect(result.current.items.map((item) => item.id)).toEqual(['fresh']);
    expect(result.current.nextCursor).toBe('fresh-page2');
    expect(result.current.total).toBe(3);
  });
  it('retries a failed first-page refresh instead of advancing its cached cursor', async () => {
    const { getComments, wrapper } = setup();
    getComments
      .mockResolvedValueOnce(page)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ...page, items: [{ ...page.items[0]!, content: 'fresh' }] });
    const { result, rerender } = renderHook(({ enabled }) => useSongComments(song, enabled), {
      wrapper,
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ enabled: false });
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.items).toHaveLength(1);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.items[0]?.content).toBe('fresh'));
    expect(getComments.mock.calls[2]![0]).toMatchObject({ cursor: null });
  });
  it('loads legacy comments from the requested profile when another profile has same-ID lyrics', async () => {
    const { provider } = setup();
    delete provider.getComments;
    const document = {
      songId: 'native-1',
      syncMode: 'line' as const,
      metadata: { sourceLabel: 'legacy', offsetMs: 0 },
      lines: [],
      vocalists: [],
      comments: page.items,
    };
    const getLyrics = vi.spyOn(provider, 'getLyrics').mockResolvedValue(document);
    const source = new FakeMusicProvider();
    Object.defineProperty(source, 'profileId', { value: 'other' });
    vi.spyOn(source, 'getLyrics').mockResolvedValue({
      ...document,
      comments: [{ ...page.items[0]!, content: 'other profile' }],
    });
    const registry = new MusicProviderRegistry(
      { providerId: provider.id, profileId: provider.profileId },
      [provider, source],
    );
    const wrapper = ({ children }: PropsWithChildren) => (
      <ProviderRegistryContext.Provider value={registry}>
        <ProviderContext.Provider value={provider}>{children}</ProviderContext.Provider>
      </ProviderRegistryContext.Provider>
    );
    usePlayerStore.setState({
      queue: [{ ...song, id: 'native-1', provider: { ...song.provider, profileId: 'other' } }],
      currentIndex: 0,
      sessionId: 4,
      currentQueueEntryId: 'entry-1',
    });
    renderHook(() => useLyricsCoordinator(), { wrapper });
    await waitFor(() => expect(useLyricsStore.getState().status).toBe('ready'));
    const { result } = renderHook(() => useSongComments({ ...song, id: 'native-1' }, true), {
      wrapper,
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(getLyrics).toHaveBeenCalledWith('native-1', expect.any(AbortSignal));
    expect(result.current.items[0]?.content).toBe('A comment');
  });
});
