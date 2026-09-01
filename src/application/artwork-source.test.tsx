import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clientMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  native: true,
}));

vi.mock('./native-player-runtime', () => ({
  get isNativeRuntime() {
    return clientMocks.native;
  },
}));

vi.mock('./yaqmc-runtime', () => ({
  getYaqmcClient: () => ({
    invoke: clientMocks.invoke,
    on: () => () => undefined,
  }),
}));

import {
  cachedArtworkSource,
  clearArtworkMemoryCache,
  isCacheableArtworkSource,
  isCachedArtworkDataUri,
} from './artwork-cache';
import { classifyArtworkSource, useSafeArtworkSource } from './artwork-source';

const currentOrigin = 'https://app.localhost';
const pngA = 'data:image/png;base64,AA==';
const pngB = 'data:image/png;base64,AQ==';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('artwork source policy', () => {
  beforeEach(() => {
    clientMocks.native = true;
    clientMocks.invoke.mockReset();
    clearArtworkMemoryCache();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each([
    '/artwork/a.svg',
    './a.svg',
    '../a.svg',
    'https://app.localhost/a.svg',
    'data:image/png;base64,AA==',
    'asset:/a.png',
    'http://asset.localhost/a.png',
  ])('classifies %s as a direct native source', (source) => {
    expect(classifyArtworkSource(source, currentOrigin)).toEqual({ kind: 'direct', source });
  });

  it.each(['//y.gtimg.cn/a.jpg', '//app.localhost/a.jpg'])(
    'rejects protocol-relative source %s before URL resolution',
    (source) => {
      expect(classifyArtworkSource(source, currentOrigin)).toBeNull();
    },
  );

  it.each([
    'https://y.gtimg.cn/a.jpg',
    'https://y.gtimg.cn:443/a.jpg',
    'https://qpic.y.qq.com/a.jpg',
    'https://music-file.y.qq.com/songlist/cover.jpg',
    'https://q.qlogo.cn/avatar.jpg',
    'https://thirdwx.qlogo.cn/avatar.jpg',
    'https://thirdqq.qlogo.cn/avatar.jpg',
    'https://y.qq.com/m/resource/calendar/0901_300.jpg',
    'https://y.qq.com/music/common/upload/MUSIC_FOCUS/focus.png',
  ])('classifies exact QQ artwork origin %s for native caching', (source) => {
    expect(isCacheableArtworkSource(source)).toBe(true);
    expect(classifyArtworkSource(source, currentOrigin)).toEqual({ kind: 'cache', source });
  });

  it.each([
    'http://y.gtimg.cn/a.jpg',
    'https://sub.y.gtimg.cn/a.jpg',
    'https://user:password@y.gtimg.cn/a.jpg',
    'https://y.gtimg.cn:444/a.jpg',
    'https://aqqmusic.tc.qq.com/a.jpg',
    'https://music.tc.qq.com/a.jpg',
    'https://example.com/a.jpg',
    'http://music-file.y.qq.com/songlist/cover.jpg',
    'https://cdn.music-file.y.qq.com/songlist/cover.jpg',
    'https://y.qq.com/portal/player.html',
    'https://y.qq.com/music/common/uploaded/not-allowed.jpg',
  ])('rejects non-allowlisted native artwork source %s', (source) => {
    expect(isCacheableArtworkSource(source)).toBe(false);
    expect(classifyArtworkSource(source, currentOrigin)).toBeNull();
  });

  it.each([pngA, 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/webp;base64,AQIDBA=='])(
    'accepts canonical cached image data URI %s',
    (value) => {
      expect(isCachedArtworkDataUri(value)).toBe(true);
    },
  );

  it.each([
    'https://y.gtimg.cn/a.jpg',
    'data:text/plain;base64,QQ==',
    'data:image/png,raw',
    'data:image/png;base64,',
    'data:image/png;base64,%%%',
    'data:image/png;base64,AB==',
  ])('rejects malformed or non-image cached result %s', (value) => {
    expect(isCachedArtworkDataUri(value)).toBe(false);
  });

  it('can hide the remote URL on lyrics surfaces until the native cache resolves', async () => {
    const pending = deferred<unknown>();
    clientMocks.invoke.mockReturnValue(pending.promise);
    const remote = 'https://qpic.y.qq.com/lyrics-pending.jpg';

    const { result } = renderHook(() => useSafeArtworkSource(remote, { pendingRemote: 'hide' }));

    expect(result.current).toBeNull();
    expect(clientMocks.invoke).toHaveBeenCalledWith('qqmusic_cache_artwork', { url: remote });
    await act(async () => pending.resolve(pngA));
    await waitFor(() => expect(result.current).toBe(pngA));
  });

  it('returns the allowlisted remote URL while native cache resolution is pending', async () => {
    const pending = deferred<unknown>();
    clientMocks.invoke.mockReturnValue(pending.promise);
    const remote = 'https://qpic.y.qq.com/pending.jpg';

    const { result } = renderHook(() => useSafeArtworkSource(remote));

    expect(result.current).toBe(remote);
    expect(clientMocks.invoke).toHaveBeenCalledWith('qqmusic_cache_artwork', { url: remote });
    await act(async () => pending.resolve(pngA));
    await waitFor(() => expect(result.current).toBe(pngA));
  });

  it('keeps browser development artwork direct without invoking native caching', () => {
    clientMocks.native = false;
    const remote = 'https://example.com/browser-only.jpg';

    const { result } = renderHook(() => useSafeArtworkSource(remote));

    expect(result.current).toBe(remote);
    expect(clientMocks.invoke).not.toHaveBeenCalled();
  });

  it('falls back to the allowlisted remote URL when native cache is rejected', async () => {
    clientMocks.invoke.mockRejectedValue(new Error('cache unavailable'));

    const { result } = renderHook(() => useSafeArtworkSource('https://y.gtimg.cn/rejected.jpg'));

    await waitFor(() => expect(clientMocks.invoke).toHaveBeenCalledTimes(1));
    expect(result.current).toBe('https://y.gtimg.cn/rejected.jpg');
  });

  it.each([
    'https://qpic.y.qq.com/raw-result.jpg',
    'data:text/plain;base64,QQ==',
    'data:image/png,raw',
    'data:image/png;base64,',
    'data:image/png;base64,%%%',
    { source: 'object' },
    null,
  ])('never exposes malformed native IPC result %#', async (ipcValue) => {
    clientMocks.invoke.mockResolvedValue(ipcValue);
    const remote = `https://qpic.y.qq.com/malformed-${String(ipcValue)}.jpg`;

    const { result } = renderHook(() => useSafeArtworkSource(remote));

    await waitFor(() => expect(clientMocks.invoke).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());
    expect(result.current).toBe(remote);
    expect(result.current).not.toEqual(ipcValue);
  });

  it('discards an older cache result after the source changes', async () => {
    const oldRequest = deferred<unknown>();
    const latestRequest = deferred<unknown>();
    const oldSource = 'https://qpic.y.qq.com/old.jpg';
    const latestSource = 'https://qpic.y.qq.com/latest.jpg';
    clientMocks.invoke.mockImplementation((_command: string, args: { url: string }) =>
      args.url === oldSource ? oldRequest.promise : latestRequest.promise,
    );
    const { rerender, result } = renderHook(
      ({ source }: { source: string }) => useSafeArtworkSource(source),
      { initialProps: { source: oldSource } },
    );

    rerender({ source: latestSource });
    await act(async () => oldRequest.resolve(pngA));
    expect(result.current).toBe(latestSource);
    await act(async () => latestRequest.resolve(pngB));
    await waitFor(() => expect(result.current).toBe(pngB));
  });

  it('does not publish a cache result after unmount', async () => {
    const pending = deferred<unknown>();
    clientMocks.invoke.mockReturnValue(pending.promise);
    const { result, unmount } = renderHook(() =>
      useSafeArtworkSource('https://y.gtimg.cn/unmounted.jpg'),
    );

    expect(result.current).toBe('https://y.gtimg.cn/unmounted.jpg');
    unmount();
    await act(async () => pending.resolve(pngA));
    expect(result.current).toBe('https://y.gtimg.cn/unmounted.jpg');
  });

  it('does not let a cleared older request replace the current cache generation', async () => {
    const older = deferred<unknown>();
    const current = deferred<unknown>();
    const remote = 'https://qpic.y.qq.com/cache-generation.jpg';
    clientMocks.invoke.mockReturnValueOnce(older.promise).mockReturnValueOnce(current.promise);

    const olderResult = cachedArtworkSource(remote);
    clearArtworkMemoryCache();
    const currentResult = cachedArtworkSource(remote);
    await act(async () => older.resolve(pngA));

    await expect(olderResult).resolves.toBe(pngA);
    expect(cachedArtworkSource(remote)).toBe(currentResult);
    await act(async () => current.resolve(pngB));
    await expect(currentResult).resolves.toBe(pngB);
    await expect(cachedArtworkSource(remote)).resolves.toBe(pngB);
    expect(clientMocks.invoke).toHaveBeenCalledTimes(2);
  });

  it('does not cache a malformed IPC value for later callers', async () => {
    const remote = 'https://qpic.y.qq.com/retry-malformed.jpg';
    clientMocks.invoke
      .mockResolvedValueOnce('https://qpic.y.qq.com/raw-result.jpg')
      .mockResolvedValueOnce(pngB);

    await expect(cachedArtworkSource(remote)).rejects.toThrow();
    await expect(cachedArtworkSource(remote)).resolves.toBe(pngB);
    expect(clientMocks.invoke).toHaveBeenCalledTimes(2);
  });
});
