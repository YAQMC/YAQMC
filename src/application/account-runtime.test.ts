import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderError,
  type AccountPlaylistDetail,
  type AccountPlaylistSummary,
  type AccountSnapshot,
  type FavoriteMutationRequest,
  type FavoriteMutationResult,
  type Page,
  type PlaylistMutationResult,
  type Song,
} from '../domain/music';
import type { AccountMusicProvider, MusicProvider } from '../providers/music-provider';
import { allSongs, homeFeed, librarySnapshot, playlists } from '../providers/fake/fixtures';
import { MusicProviderRoot } from './provider-root';
import { useCatalog } from './use-catalog';
import {
  resetAccountRuntimeForTest,
  runTemporaryPlaylistAcceptance,
  useAccountRuntime,
  useAccountStore,
} from './account-runtime';

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

function restoringSnapshot(revision = 1): AccountSnapshot {
  return {
    state: 'restoring-session',
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
      favoriteWrite: true,
      playlistRead: true,
      recentHistoryRead: true,
    },
  };
}

function playlistAuthenticatedSnapshot(revision = 3): AccountSnapshot {
  const snapshot = authenticatedSnapshot(revision);
  return {
    ...snapshot,
    capabilities: { ...snapshot.capabilities, playlistWrite: true },
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

function pageResource(items: Song[], revision: number) {
  return {
    status: 'ready' as const,
    data: items,
    nextCursor: null,
    total: items.length,
    fetchedAtMs: 1_800_000_000_000,
    authRevision: revision,
  };
}

function favoriteResult(
  clientOperationId: string,
  track: Song,
  status: FavoriteMutationResult['status'],
  favorite: boolean,
  authRevision = 3,
): FavoriteMutationResult {
  return {
    clientOperationId,
    status,
    trackId: track.id,
    favorite,
    errorCode: null,
    authRevision,
  };
}

function accountPlaylistSummary(id = 'account-playlist-a'): AccountPlaylistSummary {
  const fixture = playlists[0]!;
  return {
    id,
    reference: { kind: 'owned', tid: id, dirId: 3001 },
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

function playlistMutationResult(
  clientOperationId: string,
  status: PlaylistMutationResult['status'],
  playlist: AccountPlaylistSummary | null,
  authRevision = 3,
): PlaylistMutationResult {
  return {
    clientOperationId,
    status,
    playlist,
    errorCode: status === 'applied' || status === 'reconciled' ? null : 'provider-failure',
    authRevision,
  };
}

function playlistResource(summary: AccountPlaylistSummary, tracks: Song[] = []) {
  return {
    status: 'ready' as const,
    data: {
      summary,
      tracks: page(tracks, 3),
    },
    nextCursor: null,
    total: tracks.length,
    fetchedAtMs: 1_800_000_000_000,
    authRevision: 3,
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
    startWebLogin: vi.fn().mockResolvedValue(waitingSnapshot()),
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
    setPlaylistCollected: unsupported,
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

  it('keeps polling a native restore until the authenticated snapshot is published', async () => {
    vi.useFakeTimers();
    const getAccountSnapshot = vi
      .fn()
      .mockResolvedValueOnce(restoringSnapshot())
      .mockResolvedValue(authenticatedSnapshot());
    const provider = accountProvider({ getAccountSnapshot });
    const { unmount } = renderHook(() => useAccountRuntime(provider));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useAccountStore.getState().snapshot.state).toBe('restoring-session');
    expect(getAccountSnapshot).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(useAccountStore.getState().snapshot.state).toBe('authenticated');
    expect(getAccountSnapshot).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getAccountSnapshot).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('hydrates favorite authority immediately after an authenticated session restore', async () => {
    const track = allSongs[0]!;
    const getFavoriteSongs = vi.fn().mockResolvedValue(page([track], 3));
    const provider = accountProvider({
      getAccountSnapshot: vi.fn().mockResolvedValue(authenticatedSnapshot()),
      getFavoriteSongs,
    });

    const { unmount } = renderHook(() => useAccountRuntime(provider));

    await waitFor(() => expect(useAccountStore.getState().favorites.status).toBe('ready'));
    expect(getFavoriteSongs).toHaveBeenCalledOnce();
    expect(useAccountStore.getState().favoriteByTrackId[track.id]).toBe(true);
    unmount();
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

  it('cancels ownership returned after the dialog closed during OAuth startup', async () => {
    const startup = deferred<AccountSnapshot>();
    const cancelQrLogin = vi.fn().mockResolvedValue(cancelledSnapshot());
    const startWebLogin = vi.fn(() => startup.promise);
    const provider = accountProvider({
      startWebLogin,
      cancelQrLogin,
    });
    useAccountStore.setState({ snapshot: guestSnapshot(), dialogOpen: true });

    const start = useAccountStore.getState().startLogin(provider, 'qq');
    expect(startWebLogin).toHaveBeenCalledWith('qq', undefined);
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
    const [first, second, third, stale] = allSongs;
    if (!first || !second || !third || !stale) throw new Error('missing song fixtures');
    const getFavoriteSongs = vi
      .fn()
      .mockResolvedValueOnce(page([first, second], 3, 'next-a'))
      .mockResolvedValueOnce(page([second, third], 3));
    const provider = accountProvider({ getFavoriteSongs });
    useAccountStore.setState({
      snapshot: authenticatedSnapshot(3),
      favoriteByTrackId: { [stale.id]: true },
    });

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
    expect(useAccountStore.getState().favoriteByTrackId).toMatchObject({
      [first.id]: true,
      [second.id]: true,
      [third.id]: true,
      [stale.id]: false,
    });
  });

  it('optimistically updates one canonical favorite and rolls back a definite rejection', async () => {
    const track = allSongs[0]!;
    const pending = deferred<FavoriteMutationResult>();
    const setFavorite = vi.fn((request: FavoriteMutationRequest) => {
      void request;
      return pending.promise;
    });
    const provider = accountProvider({ setFavorite });
    useAccountStore.setState({
      snapshot: authenticatedSnapshot(3),
      favorites: pageResource([track], 3),
      favoriteByTrackId: { [track.id]: false },
    });

    const mutation = useAccountStore.getState().setFavorite(provider, track, true);
    const request = setFavorite.mock.calls[0]?.[0];
    expect(request).toMatchObject({ trackId: track.id, favorite: true });
    expect(request?.clientOperationId).toMatch(/^favorite-|^[0-9a-f-]{36}$/i);
    expect(useAccountStore.getState()).toMatchObject({
      favoriteByTrackId: { [track.id]: true },
    });
    expect(useAccountStore.getState().favoritePendingByTrackId[track.id]).toBe(
      request?.clientOperationId,
    );

    pending.resolve(favoriteResult(request!.clientOperationId, track, 'rejected', false));
    await mutation;

    expect(useAccountStore.getState().favoriteByTrackId[track.id]).toBe(false);
    expect(useAccountStore.getState().favoritePendingByTrackId[track.id]).toBeUndefined();
    expect(useAccountStore.getState().mutationMessage).toBe(
      'QQ Music rejected the Favorites change.',
    );
  });

  it('commits a reconciled server bit and exposes a neutral reconciliation message', async () => {
    const track = allSongs[0]!;
    const setFavorite = vi.fn(async (request: FavoriteMutationRequest) =>
      favoriteResult(request.clientOperationId, track, 'reconciled', false),
    );
    const provider = accountProvider({ setFavorite });
    useAccountStore.setState({
      snapshot: authenticatedSnapshot(3),
      favoriteByTrackId: { [track.id]: false },
    });

    await useAccountStore.getState().setFavorite(provider, track, true);

    expect(useAccountStore.getState().favoriteByTrackId[track.id]).toBe(false);
    expect(useAccountStore.getState().favoritePendingByTrackId[track.id]).toBeUndefined();
    expect(useAccountStore.getState().mutationMessage).toBe(
      'The server result was checked before the library was updated.',
    );
  });

  it('keeps the optimistic bit, clears pending, and refreshes after an unknown outcome', async () => {
    const track = allSongs[0]!;
    const setFavorite = vi.fn(async (request: FavoriteMutationRequest) =>
      favoriteResult(request.clientOperationId, track, 'outcome-unknown', true),
    );
    const getFavoriteSongs = vi.fn().mockResolvedValue(page([track], 3));
    const provider = accountProvider({ setFavorite, getFavoriteSongs });
    useAccountStore.setState({
      snapshot: authenticatedSnapshot(3),
      favoriteByTrackId: { [track.id]: false },
    });

    await useAccountStore.getState().setFavorite(provider, track, true);

    expect(useAccountStore.getState().favoriteByTrackId[track.id]).toBe(true);
    expect(useAccountStore.getState().favoritePendingByTrackId[track.id]).toBeUndefined();
    expect(useAccountStore.getState().mutationMessage).toBe(
      'The server could not confirm the library change. Refreshing Favorites.',
    );
    await waitFor(() => expect(getFavoriteSongs).toHaveBeenCalledOnce());
  });

  it('does not roll an old rejected mutation into a replacement account revision', async () => {
    const track = { ...allSongs[0]!, isFavorite: true };
    const pending = deferred<FavoriteMutationResult>();
    const setFavorite = vi.fn((request: FavoriteMutationRequest) => {
      void request;
      return pending.promise;
    });
    const provider = accountProvider({ setFavorite });
    useAccountStore.setState({
      snapshot: authenticatedSnapshot(3),
      favoriteByTrackId: { [track.id]: true },
    });

    const mutation = useAccountStore.getState().setFavorite(provider, track, false);
    const operationId = setFavorite.mock.calls[0]![0].clientOperationId;
    useAccountStore.setState({
      snapshot: authenticatedSnapshot(4),
      favoriteByTrackId: { [track.id]: false },
    });
    pending.resolve(favoriteResult(operationId, track, 'rejected', true, 3));
    await mutation;

    expect(useAccountStore.getState().favoriteByTrackId[track.id]).toBe(false);
    expect(useAccountStore.getState().favoritePendingByTrackId[track.id]).toBeUndefined();
  });

  it('opens account sign-in for a guest favorite without invoking the provider', async () => {
    const setFavorite = vi.fn();
    const provider = accountProvider({ setFavorite });
    useAccountStore.setState({ snapshot: guestSnapshot(), dialogOpen: false });

    await useAccountStore.getState().setFavorite(provider, allSongs[0]!, true);

    expect(setFavorite).not.toHaveBeenCalled();
    expect(useAccountStore.getState().dialogOpen).toBe(true);
  });

  it('replaces stale canonical favorite bits after a terminal refresh', async () => {
    const [present, absent] = allSongs;
    if (!present || !absent) throw new Error('missing song fixtures');
    const provider = accountProvider({
      getFavoriteSongs: vi.fn().mockResolvedValue(page([present], 3)),
    });
    useAccountStore.setState({
      snapshot: authenticatedSnapshot(3),
      favoriteByTrackId: { [absent.id]: true },
    });

    await useAccountStore.getState().loadFavorites(provider);

    expect(useAccountStore.getState().favoriteByTrackId).toMatchObject({
      [present.id]: true,
      [absent.id]: false,
    });
  });

  it('does not let a delayed Favorites read overwrite a newer confirmed mutation', async () => {
    const track = { ...allSongs[0]!, isFavorite: false };
    const delayedRead = deferred<Page<Song>>();
    const provider = accountProvider({
      getFavoriteSongs: vi.fn(() => delayedRead.promise),
      setFavorite: vi.fn(async (request: FavoriteMutationRequest) =>
        favoriteResult(request.clientOperationId, track, 'applied', true),
      ),
    });
    useAccountStore.setState({
      snapshot: authenticatedSnapshot(3),
      favorites: { status: 'empty' },
      favoriteByTrackId: { [track.id]: false },
    });

    const read = useAccountStore.getState().loadFavorites(provider);
    await useAccountStore.getState().setFavorite(provider, track, true);
    delayedRead.resolve(page([], 3));
    await read;

    expect(useAccountStore.getState().favoriteByTrackId[track.id]).toBe(true);
    expect(useAccountStore.getState().favorites).toMatchObject({
      status: 'ready',
      data: [expect.objectContaining({ id: track.id })],
    });
  });

  it('protects confirmed favorite state from delayed provider propagation on later refreshes', async () => {
    const track = { ...allSongs[0]!, isFavorite: false };
    const provider = accountProvider({
      getFavoriteSongs: vi.fn().mockResolvedValue(page([], 3)),
      setFavorite: vi.fn(async (request: FavoriteMutationRequest) =>
        favoriteResult(request.clientOperationId, track, 'applied', true),
      ),
    });
    useAccountStore.setState({
      snapshot: authenticatedSnapshot(3),
      favorites: { status: 'empty' },
      favoriteByTrackId: { [track.id]: false },
    });

    await useAccountStore.getState().setFavorite(provider, track, true);
    await useAccountStore.getState().loadFavorites(provider, true);

    expect(useAccountStore.getState().favoriteByTrackId[track.id]).toBe(true);
    expect(useAccountStore.getState().favorites).toMatchObject({
      status: 'ready',
      data: [expect.objectContaining({ id: track.id })],
    });
  });

  it('keeps account favorite truth when rapid player projections carry stale song metadata', async () => {
    const track = { ...allSongs[0]!, isFavorite: false };
    const provider = accountProvider({
      setFavorite: vi.fn(async (request: FavoriteMutationRequest) =>
        favoriteResult(request.clientOperationId, track, 'applied', true),
      ),
    });
    useAccountStore.setState({
      snapshot: authenticatedSnapshot(3),
      favoriteByTrackId: { [track.id]: false },
    });
    await useAccountStore.getState().setFavorite(provider, track, true);

    // Player snapshots are deliberately not an account-library input. Repeated
    // stale Song.isFavorite values cannot write this central projection.
    for (let index = 0; index < 4; index += 1) {
      expect(useAccountStore.getState().favoriteByTrackId[track.id]).toBe(true);
      void { ...track, isFavorite: false };
    }
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

  it('serializes one playlist entity, applies an optimistic rename, and rolls back rejection', async () => {
    const summary = accountPlaylistSummary();
    const pending = deferred<PlaylistMutationResult>();
    const renamePlaylist = vi.fn((request) => {
      void request;
      return pending.promise;
    });
    const deletePlaylist = vi.fn();
    const provider = accountProvider({ renamePlaylist, deletePlaylist });
    useAccountStore.setState({
      snapshot: playlistAuthenticatedSnapshot(3),
      playlists: {
        status: 'ready',
        data: [summary],
        nextCursor: null,
        total: 1,
        fetchedAtMs: 1_800_000_000_000,
        authRevision: 3,
      },
      accountPlaylistDetails: { [summary.id]: playlistResource(summary) },
    });

    const mutation = useAccountStore
      .getState()
      .renamePlaylist(provider, summary, 'Optimistic rename');
    const request = renamePlaylist.mock.calls[0]![0];
    expect(useAccountStore.getState()).toMatchObject({
      playlists: { data: [{ id: summary.id, title: 'Optimistic rename' }] },
      accountPlaylistDetails: {
        [summary.id]: { data: { summary: { title: 'Optimistic rename' } } },
      },
      playlistPendingById: { [summary.id]: request.clientOperationId },
    });

    await expect(useAccountStore.getState().deletePlaylist(provider, summary)).resolves.toBeNull();
    expect(deletePlaylist).not.toHaveBeenCalled();

    pending.resolve(playlistMutationResult(request.clientOperationId, 'rejected', summary));
    await mutation;

    expect(useAccountStore.getState()).toMatchObject({
      playlists: { data: [{ id: summary.id, title: summary.title }] },
      accountPlaylistDetails: {
        [summary.id]: { data: { summary: { title: summary.title } } },
      },
      playlistMutationNoticeById: {
        [summary.id]: { operation: 'rename', outcome: 'rejected' },
      },
    });
    expect(useAccountStore.getState().playlistPendingById[summary.id]).toBeUndefined();
  });

  it('rejects a malformed confirmed playlist result instead of committing optimistic state', async () => {
    const summary = accountPlaylistSummary();
    const renamePlaylist = vi.fn(async (request) =>
      playlistMutationResult(request.clientOperationId, 'applied', null),
    );
    const provider = accountProvider({ renamePlaylist });
    useAccountStore.setState({
      snapshot: playlistAuthenticatedSnapshot(3),
      playlists: {
        status: 'ready',
        data: [summary],
        nextCursor: null,
        total: 1,
        fetchedAtMs: 1_800_000_000_000,
        authRevision: 3,
      },
      accountPlaylistDetails: { [summary.id]: playlistResource(summary) },
    });

    const result = await useAccountStore
      .getState()
      .renamePlaylist(provider, summary, 'Malformed confirmation');

    expect(result).toBeNull();
    expect(useAccountStore.getState().playlists).toMatchObject({
      data: [{ title: summary.title }],
    });
    expect(useAccountStore.getState().playlistMutationNoticeById[summary.id]).toEqual({
      operation: 'rename',
      outcome: 'failed',
    });
  });

  it('surfaces a rejected public-playlist collection instead of silently discarding it', async () => {
    const playlist = { ...playlists[0]!, id: 'qqmusic:playlist:7001' };
    const setPlaylistCollected = vi.fn(async (request) =>
      playlistMutationResult(request.clientOperationId, 'rejected', null),
    );
    const provider = accountProvider({ setPlaylistCollected });
    useAccountStore.setState({
      snapshot: playlistAuthenticatedSnapshot(3),
      playlists: {
        status: 'ready',
        data: [],
        nextCursor: null,
        total: 0,
        fetchedAtMs: 1_800_000_000_000,
        authRevision: 3,
      },
    });

    const result = await useAccountStore.getState().setPlaylistCollected(provider, playlist, true);

    expect(result?.status).toBe('rejected');
    expect(useAccountStore.getState().playlistMutationNoticeById[playlist.id]).toEqual({
      operation: 'collect',
      outcome: 'rejected',
    });
    expect(useAccountStore.getState().playlists).toMatchObject({ data: [] });
  });

  it('keeps an unknown collection visible while starting a read-only playlist refresh', async () => {
    const playlist = { ...playlists[0]!, id: 'qqmusic:playlist:7001' };
    const refresh = deferred<Page<AccountPlaylistSummary>>();
    const setPlaylistCollected = vi.fn(async (request) =>
      playlistMutationResult(request.clientOperationId, 'outcome-unknown', null),
    );
    const getAccountPlaylists = vi.fn(() => refresh.promise);
    const provider = accountProvider({ setPlaylistCollected, getAccountPlaylists });
    useAccountStore.setState({
      snapshot: playlistAuthenticatedSnapshot(3),
      playlists: {
        status: 'ready',
        data: [],
        nextCursor: null,
        total: 0,
        fetchedAtMs: 1_800_000_000_000,
        authRevision: 3,
      },
    });

    const result = await useAccountStore.getState().setPlaylistCollected(provider, playlist, true);

    expect(result?.status).toBe('outcome-unknown');
    expect(getAccountPlaylists).toHaveBeenCalledOnce();
    expect(useAccountStore.getState().playlists).toMatchObject({
      status: 'loading',
      data: [{ id: playlist.id, ownership: 'collected' }],
    });
    expect(useAccountStore.getState().playlistMutationNoticeById[playlist.id]).toEqual({
      operation: 'collect',
      outcome: 'outcome-unknown',
    });

    refresh.resolve(page([], 3));
    await waitFor(() =>
      expect(useAccountStore.getState().playlists).toEqual({
        status: 'empty',
      }),
    );
  });

  it('retains an optimistic track after an unknown outcome and starts a read-only refresh', async () => {
    const summary = accountPlaylistSummary();
    const track = allSongs[0]!;
    const refresh = deferred<AccountPlaylistDetail>();
    const addPlaylistTrack = vi.fn(async (request) =>
      playlistMutationResult(request.clientOperationId, 'outcome-unknown', summary),
    );
    const getAccountPlaylistTracks = vi.fn(() => refresh.promise);
    const provider = accountProvider({ addPlaylistTrack, getAccountPlaylistTracks });
    useAccountStore.setState({
      snapshot: playlistAuthenticatedSnapshot(3),
      playlists: {
        status: 'ready',
        data: [summary],
        nextCursor: null,
        total: 1,
        fetchedAtMs: 1_800_000_000_000,
        authRevision: 3,
      },
      accountPlaylistDetails: { [summary.id]: playlistResource(summary) },
    });

    await useAccountStore.getState().addPlaylistTrack(provider, summary, track);

    expect(addPlaylistTrack).toHaveBeenCalledOnce();
    expect(getAccountPlaylistTracks).toHaveBeenCalledOnce();
    expect(useAccountStore.getState().accountPlaylistDetails[summary.id]).toMatchObject({
      status: 'loading',
      data: { tracks: { items: [{ id: track.id }] } },
    });
    expect(useAccountStore.getState().playlistMutationNoticeById[summary.id]).toEqual({
      operation: 'add',
      outcome: 'outcome-unknown',
    });
    expect(useAccountStore.getState().playlistPendingById[summary.id]).toBeUndefined();

    refresh.resolve({
      summary: { ...summary, trackCount: 1 },
      tracks: page([track], 3),
    });
    await waitFor(() =>
      expect(useAccountStore.getState().accountPlaylistDetails[summary.id]).toMatchObject({
        status: 'ready',
        data: { tracks: { items: [{ id: track.id }] } },
      }),
    );
  });

  it('drops an old playlist rejection without restoring data from the prior account revision', async () => {
    const prior = accountPlaylistSummary();
    const replacement = { ...prior, title: 'Replacement account playlist' };
    const pending = deferred<PlaylistMutationResult>();
    const renamePlaylist = vi.fn(() => pending.promise);
    const provider = accountProvider({ renamePlaylist });
    useAccountStore.setState({
      snapshot: playlistAuthenticatedSnapshot(3),
      playlists: {
        status: 'ready',
        data: [prior],
        nextCursor: null,
        total: 1,
        fetchedAtMs: 1_800_000_000_000,
        authRevision: 3,
      },
      accountPlaylistDetails: { [prior.id]: playlistResource(prior) },
    });

    const mutation = useAccountStore
      .getState()
      .renamePlaylist(provider, prior, 'Prior account optimistic title');
    const operationId = useAccountStore.getState().playlistPendingById[prior.id]!;
    useAccountStore.setState({
      snapshot: playlistAuthenticatedSnapshot(4),
      playlists: {
        status: 'ready',
        data: [replacement],
        nextCursor: null,
        total: 1,
        fetchedAtMs: 1_800_000_000_100,
        authRevision: 4,
      },
      accountPlaylistDetails: {
        [prior.id]: {
          ...playlistResource(replacement),
          authRevision: 4,
          data: {
            summary: replacement,
            tracks: page([], 4),
          },
        },
      },
    });
    pending.resolve(playlistMutationResult(operationId, 'rejected', prior, 3));
    await mutation;

    expect(useAccountStore.getState().playlists).toMatchObject({
      data: [{ title: replacement.title }],
      authRevision: 4,
    });
    expect(useAccountStore.getState().accountPlaylistDetails[prior.id]).toMatchObject({
      data: { summary: { title: replacement.title } },
      authRevision: 4,
    });
    expect(useAccountStore.getState().playlistPendingById[prior.id]).toBeUndefined();
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

    await useAccountStore.getState().loadAccountPlaylist(provider, summary);
    await useAccountStore.getState().loadNextAccountPlaylist(provider, summary);

    expect(getAccountPlaylistTracks).toHaveBeenNthCalledWith(1, summary, undefined, 100, undefined);
    expect(getAccountPlaylistTracks).toHaveBeenNthCalledWith(
      2,
      summary,
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

  it('projects tracks loaded from the structural Favorite Songs collection into favorite truth', async () => {
    const track = { ...allSongs[0]!, isFavorite: false };
    const summary: AccountPlaylistSummary = {
      ...accountPlaylistSummary('qqmusic:account-collection:favorites'),
      reference: { kind: 'favorite-songs', dirId: 201 },
      ownership: 'favorite',
      capabilities: {
        canAddTracks: false,
        canRemoveTracks: false,
        canRename: false,
        canDelete: false,
        canReorder: false,
      },
    };
    const provider = accountProvider({
      getAccountPlaylistTracks: vi.fn().mockResolvedValue({
        summary,
        tracks: page([track], 3),
      }),
    });
    useAccountStore.setState({
      snapshot: authenticatedSnapshot(3),
      favoriteByTrackId: { [track.id]: false },
    });

    await useAccountStore.getState().loadAccountPlaylist(provider, summary);

    expect(useAccountStore.getState().favoriteByTrackId[track.id]).toBe(true);
    expect(useAccountStore.getState().accountPlaylistDetails[summary.id]).toMatchObject({
      status: 'ready',
      data: { summary: { ownership: 'favorite' } },
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

  it('creates, verifies, mutates, and deletes only the playlist ID created by this run', async () => {
    const knownTrack = allSongs[0]!;
    const operations: string[] = [];
    let createdSummary: AccountPlaylistSummary | null = null;
    const result = (
      clientOperationId: string,
      playlist: AccountPlaylistSummary | null,
    ): PlaylistMutationResult => ({
      clientOperationId,
      status: 'applied',
      playlist,
      errorCode: null,
      authRevision: 3,
    });
    const provider = accountProvider({
      createPlaylist: vi.fn(async (request) => {
        createdSummary = {
          ...accountPlaylistSummary('qqmusic:playlist:SANITIZED_CREATED_BY_RUN'),
          title: request.title,
        };
        operations.push(`create:${request.title}`);
        return result(request.clientOperationId, createdSummary);
      }),
      addPlaylistTrack: vi.fn(async (request) => {
        operations.push(`add:${request.playlistId}:${request.trackId}`);
        return result(request.clientOperationId, createdSummary);
      }),
      getAccountPlaylistTracks: vi.fn(async (playlist) => {
        operations.push(`read:${playlist.id}`);
        if (!createdSummary) throw new Error('playlist was not created');
        return {
          summary: createdSummary,
          tracks: page([knownTrack], 3),
        };
      }),
      removePlaylistTrack: vi.fn(async (request) => {
        operations.push(`remove:${request.playlistId}:${request.trackId}`);
        return result(request.clientOperationId, createdSummary);
      }),
      renamePlaylist: vi.fn(async (request) => {
        operations.push(`rename:${request.playlistId}:${request.title}`);
        if (!createdSummary) throw new Error('playlist was not created');
        createdSummary = { ...createdSummary, title: request.title };
        return result(request.clientOperationId, createdSummary);
      }),
      deletePlaylist: vi.fn(async (request) => {
        operations.push(`delete:${request.playlistId}`);
        return result(request.clientOperationId, null);
      }),
    });

    const created = await runTemporaryPlaylistAcceptance(provider, knownTrack);

    expect(created.title).toMatch(/^YAQMC Integration Test \([0-9TZ:-]+\)$/);
    expect(operations).toEqual([
      `create:${created.title}`,
      `add:${created.id}:${knownTrack.id}`,
      `read:${created.id}`,
      `remove:${created.id}:${knownTrack.id}`,
      `rename:${created.id}:${created.title} Verified`,
      `delete:${created.id}`,
    ]);
    expect(operations.join('\n')).not.toContain('EXISTING_PLAYLIST_ID');
  });

  it('refuses to mutate or clean up a create result that is not an owned run-scoped playlist', async () => {
    const existing = {
      ...accountPlaylistSummary('EXISTING_PLAYLIST_ID'),
      title: 'Existing personal playlist',
      ownership: 'owned' as const,
    };
    const addPlaylistTrack = vi.fn();
    const deletePlaylist = vi.fn();
    const provider = accountProvider({
      createPlaylist: vi.fn(async (request) =>
        playlistMutationResult(request.clientOperationId, 'applied', existing),
      ),
      addPlaylistTrack,
      deletePlaylist,
    });

    await expect(runTemporaryPlaylistAcceptance(provider, allSongs[0]!)).rejects.toThrow(
      'unsafe cleanup target',
    );
    expect(addPlaylistTrack).not.toHaveBeenCalled();
    expect(deletePlaylist).not.toHaveBeenCalled();
  });

  it('cleans only the created temporary ID once after a confirmed intermediate rejection', async () => {
    let created: AccountPlaylistSummary | null = null;
    const deletePlaylist = vi.fn(async (request) =>
      playlistMutationResult(request.clientOperationId, 'applied', null),
    );
    const provider = accountProvider({
      createPlaylist: vi.fn(async (request) => {
        created = {
          ...accountPlaylistSummary('qqmusic:playlist:SANITIZED_TEMPORARY_FAILURE'),
          title: request.title,
        };
        return playlistMutationResult(request.clientOperationId, 'applied', created);
      }),
      addPlaylistTrack: vi.fn(async (request) =>
        playlistMutationResult(request.clientOperationId, 'rejected', created),
      ),
      deletePlaylist,
    });

    await expect(runTemporaryPlaylistAcceptance(provider, allSongs[0]!)).rejects.toThrow(
      'Temporary playlist add was not confirmed',
    );
    expect(deletePlaylist).toHaveBeenCalledOnce();
    expect(deletePlaylist.mock.calls[0]![0].playlistId).toBe(
      'qqmusic:playlist:SANITIZED_TEMPORARY_FAILURE',
    );
  });
});
