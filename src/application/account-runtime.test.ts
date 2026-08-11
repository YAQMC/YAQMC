import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderError,
  type AccountPlaylistDetail,
  type AccountPlaylistSummary,
  type AccountSnapshot,
  type Page,
} from '../domain/music';
import type { AccountMusicProvider, MusicProvider } from '../providers/music-provider';
import { allSongs, homeFeed, librarySnapshot, playlists } from '../providers/fake/fixtures';
import { MusicProviderRoot } from './provider-root';
import { useCatalog } from './use-catalog';
import { resetAccountRuntimeForTest, useAccountRuntime, useAccountStore } from './account-runtime';

const capabilities = {
  qrLogin: true,
  favoriteRead: false,
  favoriteWrite: false,
  playlistRead: false,
  playlistWrite: false,
  recentHistoryRead: false,
};

function guestSnapshot(revision = 1): AccountSnapshot {
  return {
    state: 'guest',
    profile: null,
    entitlement: null,
    revision,
    capabilities,
  };
}

function waitingSnapshot(revision = 2): AccountSnapshot {
  return {
    state: 'waiting-for-scan',
    attemptId: 'attempt-a',
    ownerLeaseId: 'lease-a',
    qrImageDataUri: 'data:image/png;base64,AA==',
    expiresAtMs: 1_800_000_000_000,
    pollAfterMs: 5_000,
    profile: null,
    entitlement: null,
    revision,
    capabilities,
  };
}

function authenticatedSnapshot(revision = 3): AccountSnapshot {
  return {
    state: 'authenticated',
    profile: {
      avatarUrl: 'https://qpic.y.qq.com/synthetic-avatar.png',
      nickname: 'Synthetic Listener',
      maskedIdentity: '10******01',
    },
    entitlement: {
      tier: 'music-vip',
      membership: 'active',
      expiresAtMs: 1_800_000_000_000,
      permittedQualities: ['standard'],
      observedMaximumQuality: 'standard',
      restrictions: [],
    },
    revision,
    capabilities: {
      ...capabilities,
      favoriteRead: true,
      playlistRead: true,
      recentHistoryRead: true,
    },
  };
}

function page<T>(items: T[], revision: number, nextCursor: string | null = null): Page<T> {
  return {
    items,
    nextCursor,
    total: items.length,
    fetchedAtMs: 1_800_000_000_000,
    stale: false,
    authRevision: revision,
  };
}

function accountPlaylistSummary(id = 'account-playlist-a'): AccountPlaylistSummary {
  const fixture = playlists[0]!;
  return {
    id,
    title: 'Synthetic account playlist',
    description: fixture.description,
    owner: { id: 'account-owner', displayName: 'Synthetic Listener' },
    artwork: fixture.artwork,
    ownership: 'owned',
    capabilities: {
      canAddTracks: true,
      canRemoveTracks: true,
      canRename: true,
      canDelete: true,
      canReorder: false,
    },
    trackCount: 3,
    updatedAtMs: 1_800_000_000_000,
  };
}

function cancelledSnapshot(revision = 4): AccountSnapshot {
  return {
    state: 'cancelled',
    attemptId: 'attempt-a',
    profile: null,
    entitlement: null,
    revision,
    capabilities,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function accountProvider(
  overrides: Partial<MusicProvider & AccountMusicProvider> = {},
): MusicProvider & AccountMusicProvider {
  const unsupported = async () => {
    throw new Error('unused test provider method');
  };
  return {
    id: 'account-test',
    displayName: 'Account Test',
    getHome: unsupported,
    getAlbum: unsupported,
    getPlaylist: unsupported,
    getLibrary: unsupported,
    getLyrics: unsupported,
    search: unsupported,
    getAccountSnapshot: vi.fn().mockResolvedValue(guestSnapshot()),
    startQrLogin: vi.fn().mockResolvedValue(waitingSnapshot()),
    heartbeatQrLogin: vi.fn().mockResolvedValue(waitingSnapshot(3)),
    cancelQrLogin: vi.fn().mockResolvedValue(cancelledSnapshot()),
    refreshQrLogin: vi.fn().mockResolvedValue(waitingSnapshot(5)),
    signOut: vi.fn().mockResolvedValue(guestSnapshot(6)),
    getFavoriteSongs: unsupported,
    getAccountPlaylists: unsupported,
    getAccountPlaylistTracks: unsupported,
    getAccountRecentlyPlayed: unsupported,
    setFavorite: unsupported,
    createPlaylist: unsupported,
    renamePlaylist: unsupported,
    addPlaylistTrack: unsupported,
    removePlaylistTrack: unsupported,
    deletePlaylist: unsupported,
    ...overrides,
  } as MusicProvider & AccountMusicProvider;
}

describe('account runtime', () => {
  beforeEach(() => {
    resetAccountRuntimeForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAccountRuntimeForTest();
  });

  it('drops an older account snapshot after a newer generation wins', async () => {
    const first = deferred<AccountSnapshot>();
    const second = deferred<AccountSnapshot>();
    const provider = accountProvider({
      getAccountSnapshot: vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
    });

    const firstRequest = useAccountStore.getState().refreshSnapshot(provider);
    const secondRequest = useAccountStore.getState().refreshSnapshot(provider);
    second.resolve(authenticatedSnapshot());
    await secondRequest;
    first.resolve(guestSnapshot());
    await firstRequest;

    expect(useAccountStore.getState().snapshot.state).toBe('authenticated');
  });

  it('clears the QR projection before cancelling on dialog close and cancels once', async () => {
    const cancellation = deferred<AccountSnapshot>();
    const cancelQrLogin = vi.fn(() => cancellation.promise);
    const provider = accountProvider({ cancelQrLogin });
    const waiting = waitingSnapshot();
    if (waiting.state !== 'waiting-for-scan') throw new Error('invalid waiting fixture');
    useAccountStore.setState({
      snapshot: waiting,
      displayedQrImageDataUri: waiting.qrImageDataUri,
      dialogOpen: true,
    });

    const close = useAccountStore.getState().closeDialog(provider);
    const duplicate = useAccountStore.getState().closeDialog(provider);
    expect(useAccountStore.getState()).toMatchObject({
      displayedQrImageDataUri: null,
      dialogOpen: false,
    });
    expect(cancelQrLogin).toHaveBeenCalledOnce();
    expect(cancelQrLogin).toHaveBeenCalledWith('attempt-a', undefined);

    cancellation.resolve(cancelledSnapshot());
    await Promise.all([close, duplicate]);
    expect(useAccountStore.getState().snapshot.state).toBe('cancelled');
  });

  it('cancels ownership returned after the dialog closed during QR startup', async () => {
    const startup = deferred<AccountSnapshot>();
    const cancelQrLogin = vi.fn().mockResolvedValue(cancelledSnapshot());
    const provider = accountProvider({
      startQrLogin: vi.fn(() => startup.promise),
      cancelQrLogin,
    });
    useAccountStore.setState({ snapshot: guestSnapshot(), dialogOpen: true });

    const start = useAccountStore.getState().startLogin(provider);
    await useAccountStore.getState().closeDialog(provider);
    expect(cancelQrLogin).not.toHaveBeenCalled();

    startup.resolve(waitingSnapshot());
    await start;

    expect(cancelQrLogin).toHaveBeenCalledOnce();
    expect(cancelQrLogin).toHaveBeenCalledWith('attempt-a', undefined);
    expect(useAccountStore.getState()).toMatchObject({
      snapshot: { state: 'guest' },
      dialogOpen: false,
      displayedQrImageDataUri: null,
    });
  });

  it('heartbeats the exact owner pair and stops/cancels after rejection', async () => {
    vi.useFakeTimers();
    const heartbeatQrLogin = vi.fn().mockRejectedValue(new Error('private native detail'));
    const cancelQrLogin = vi.fn().mockResolvedValue(cancelledSnapshot());
    const provider = accountProvider({
      getAccountSnapshot: vi.fn().mockResolvedValue(waitingSnapshot(4)),
      heartbeatQrLogin,
      cancelQrLogin,
    });
    const { unmount } = renderHook(() => useAccountRuntime(provider));
    await act(async () => Promise.resolve());

    const waiting = waitingSnapshot();
    if (waiting.state !== 'waiting-for-scan') throw new Error('invalid waiting fixture');
    act(() => {
      useAccountStore.setState({
        snapshot: waiting,
        displayedQrImageDataUri: waiting.qrImageDataUri,
        dialogOpen: true,
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(heartbeatQrLogin).toHaveBeenCalledOnce();
    expect(heartbeatQrLogin).toHaveBeenCalledWith('attempt-a', 'lease-a', expect.any(AbortSignal));
    expect(cancelQrLogin).toHaveBeenCalledOnce();
    expect(useAccountStore.getState().displayedQrImageDataUri).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(heartbeatQrLogin).toHaveBeenCalledOnce();
    expect(cancelQrLogin).toHaveBeenCalledOnce();
    unmount();
    expect(cancelQrLogin).toHaveBeenCalledOnce();
  });

  it('keeps a completed login when the owner heartbeat loses the native completion race', async () => {
    const heartbeatQrLogin = vi
      .fn()
      .mockRejectedValue(new ProviderError('cancelled', 'owner already completed', false));
    const cancelQrLogin = vi.fn().mockResolvedValue(cancelledSnapshot());
    const provider = accountProvider({
      getAccountSnapshot: vi.fn().mockResolvedValue(authenticatedSnapshot()),
      heartbeatQrLogin,
      cancelQrLogin,
    });
    const waiting = waitingSnapshot();
    useAccountStore.setState({ snapshot: waiting, dialogOpen: true });

    await useAccountStore.getState().heartbeatLogin(provider);

    expect(useAccountStore.getState()).toMatchObject({
      snapshot: { state: 'authenticated' },
      error: null,
      displayedQrImageDataUri: null,
    });
    expect(cancelQrLogin).not.toHaveBeenCalled();
  });

  it('clamps a slow native snapshot cadence to two seconds', async () => {
    vi.useFakeTimers();
    const getAccountSnapshot = vi.fn().mockResolvedValue(waitingSnapshot(4));
    const provider = accountProvider({ getAccountSnapshot });
    const { unmount } = renderHook(() => useAccountRuntime(provider));
    await act(async () => Promise.resolve());
    const waiting = waitingSnapshot();
    act(() => {
      useAccountStore.setState({ snapshot: waiting, dialogOpen: true });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(getAccountSnapshot).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getAccountSnapshot).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('pagehide and unmount clear ownership once and reject a late refresh result', async () => {
    const initial = deferred<AccountSnapshot>();
    const cancelQrLogin = vi.fn().mockResolvedValue(cancelledSnapshot());
    const provider = accountProvider({
      getAccountSnapshot: vi.fn(() => initial.promise),
      cancelQrLogin,
    });
    const { unmount } = renderHook(() => useAccountRuntime(provider));
    const waiting = waitingSnapshot();
    if (waiting.state !== 'waiting-for-scan') throw new Error('invalid waiting fixture');
    act(() => {
      useAccountStore.setState({
        snapshot: waiting,
        displayedQrImageDataUri: waiting.qrImageDataUri,
        dialogOpen: true,
      });
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
    });

    expect(useAccountStore.getState().displayedQrImageDataUri).toBeNull();
    expect(cancelQrLogin).toHaveBeenCalledOnce();
    initial.resolve(authenticatedSnapshot());
    await act(async () => initial.promise);
    expect(useAccountStore.getState().snapshot.state).not.toBe('authenticated');

    unmount();
    expect(cancelQrLogin).toHaveBeenCalledOnce();
  });

  it('is inert for a catalog-only provider', async () => {
    const provider = {
      id: 'catalog-only',
      displayName: 'Catalog only',
    } as MusicProvider;
    const before = useAccountStore.getState().snapshot;
    const { unmount } = renderHook(() => useAccountRuntime(provider));
    await act(async () => Promise.resolve());
    expect(useAccountStore.getState().snapshot).toBe(before);
    unmount();
  });

  it('marks a guest resource account-required without invoking a private read', async () => {
    const getFavoriteSongs = vi.fn();
    const provider = accountProvider({ getFavoriteSongs });
    useAccountStore.setState({ snapshot: guestSnapshot() });

    await useAccountStore.getState().loadFavorites(provider);

    expect(getFavoriteSongs).not.toHaveBeenCalled();
    expect(useAccountStore.getState().favorites).toEqual({ status: 'account-required' });
  });

  it('appends paged favorites with stable first-seen deduplication', async () => {
    const [first, second, third] = allSongs;
    if (!first || !second || !third) throw new Error('missing song fixtures');
    const getFavoriteSongs = vi
      .fn()
      .mockResolvedValueOnce(page([first, second], 3, 'next-a'))
      .mockResolvedValueOnce(page([second, third], 3));
    const provider = accountProvider({ getFavoriteSongs });
    useAccountStore.setState({ snapshot: authenticatedSnapshot(3) });

    await useAccountStore.getState().loadFavorites(provider);
    await useAccountStore.getState().loadNext(provider, 'favorites');

    expect(getFavoriteSongs).toHaveBeenNthCalledWith(1, undefined, 100, undefined);
    expect(getFavoriteSongs).toHaveBeenNthCalledWith(2, 'next-a', 100, undefined);
    expect(useAccountStore.getState().favorites).toMatchObject({
      status: 'ready',
      data: [first, second, third],
      nextCursor: null,
      authRevision: 3,
    });
  });

  it('keeps stale data visible and maps authentication expiry to reauthorization', async () => {
    const song = allSongs[0]!;
    const stalePage = { ...page([song], 3), stale: true };
    const getFavoriteSongs = vi
      .fn()
      .mockResolvedValueOnce(stalePage)
      .mockRejectedValueOnce(
        new ProviderError('authentication-expired', 'private native detail', false),
      );
    const provider = accountProvider({ getFavoriteSongs });
    useAccountStore.setState({ snapshot: authenticatedSnapshot(3) });

    await useAccountStore.getState().loadFavorites(provider);
    expect(useAccountStore.getState().favorites).toMatchObject({
      status: 'stale',
      data: [song],
    });

    await useAccountStore.getState().loadFavorites(provider, true);
    expect(useAccountStore.getState().favorites).toEqual({
      status: 'reauthentication-required',
    });
  });

  it('discards an old page after the authenticated revision changes', async () => {
    const pendingPage = deferred<Page<(typeof allSongs)[number]>>();
    const provider = accountProvider({
      getFavoriteSongs: vi.fn(() => pendingPage.promise),
      getAccountSnapshot: vi.fn().mockResolvedValue(authenticatedSnapshot(4)),
    });
    useAccountStore.setState({ snapshot: authenticatedSnapshot(3) });

    const load = useAccountStore.getState().loadFavorites(provider);
    await useAccountStore.getState().refreshSnapshot(provider);
    pendingPage.resolve(page([allSongs[0]!], 3));
    await load;

    expect(useAccountStore.getState()).toMatchObject({
      snapshot: { state: 'authenticated', revision: 4 },
      favorites: { status: 'idle' },
    });
  });

  it('loads account playlist pages through the private detail API and deduplicates tracks', async () => {
    const [first, second, third] = allSongs;
    if (!first || !second || !third) throw new Error('missing song fixtures');
    const summary = accountPlaylistSummary();
    const firstDetail: AccountPlaylistDetail = {
      summary,
      tracks: page([first, second], 3, 'detail-next'),
    };
    const secondDetail: AccountPlaylistDetail = {
      summary,
      tracks: page([second, third], 3),
    };
    const getAccountPlaylistTracks = vi
      .fn()
      .mockResolvedValueOnce(firstDetail)
      .mockResolvedValueOnce(secondDetail);
    const provider = accountProvider({ getAccountPlaylistTracks });
    useAccountStore.setState({ snapshot: authenticatedSnapshot(3) });

    await useAccountStore.getState().loadAccountPlaylist(provider, summary.id);
    await useAccountStore.getState().loadNextAccountPlaylist(provider, summary.id);

    expect(getAccountPlaylistTracks).toHaveBeenNthCalledWith(
      1,
      summary.id,
      undefined,
      100,
      undefined,
    );
    expect(getAccountPlaylistTracks).toHaveBeenNthCalledWith(
      2,
      summary.id,
      'detail-next',
      100,
      undefined,
    );
    expect(useAccountStore.getState().accountPlaylistDetails[summary.id]).toMatchObject({
      status: 'ready',
      data: { tracks: { items: [first, second, third] } },
      nextCursor: null,
    });
  });

  it('keeps the public catalog ready when account restore fails', async () => {
    const restoreFailure = vi.fn().mockRejectedValue(new Error('private account unavailable'));
    const getFavoriteSongs = vi.fn().mockRejectedValue(new Error('private account unavailable'));
    const provider = accountProvider({
      getHome: vi.fn().mockResolvedValue(homeFeed),
      getLibrary: vi.fn().mockResolvedValue(librarySnapshot),
      getAccountSnapshot: restoreFailure,
      getFavoriteSongs,
      getAccountPlaylists: vi.fn().mockRejectedValue(new Error('private account unavailable')),
      getAccountPlaylistTracks: vi.fn().mockRejectedValue(new Error('private account unavailable')),
      getAccountRecentlyPlayed: vi.fn().mockRejectedValue(new Error('private account unavailable')),
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(MusicProviderRoot, { provider, children });
    const { result, unmount } = renderHook(
      () => ({ catalog: useCatalog(), account: useAccountStore((state) => state.favorites) }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.catalog.status).toBe('ready'));
    await waitFor(() => expect(useAccountStore.getState().error).toBe('unknown'));
    await useAccountStore.getState().loadFavorites(provider);

    expect(result.current.catalog.status).toBe('ready');
    expect(useAccountStore.getState().favorites).toEqual({ status: 'account-required' });
    expect(provider.getHome).toHaveBeenCalledOnce();
    expect(provider.getLibrary).toHaveBeenCalledOnce();
    expect(getFavoriteSongs).not.toHaveBeenCalled();
    unmount();
  });
});
