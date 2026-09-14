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

const coreStatusMocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    kind: 'fake' as 'electron' | 'fake' | 'android',
    listeners,
    emit(status: string) {
      for (const listener of listeners.get('host://core-status') ?? []) {
        listener({ status });
      }
    },
    emitAccount(signedIn: boolean) {
      for (const listener of listeners.get('account://changed') ?? []) {
        listener({ signedIn });
      }
    },
    reset() {
      listeners.clear();
      this.kind = 'fake';
    },
  };
});

vi.mock('./yaqmc-runtime', () => ({
  getHostBridge: () => ({ kind: coreStatusMocks.kind }),
  getYaqmcClient: () => ({
    on: (channel: string, handler: (payload: unknown) => void) => {
      const listeners = coreStatusMocks.listeners.get(channel) ?? new Set();
      listeners.add(handler);
      coreStatusMocks.listeners.set(channel, listeners);
      return () => {
        listeners.delete(handler);
      };
    },
  }),
}));

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
    profileId: 'default',
    profile: null,
    entitlement: null,
    revision,
    capabilities,
  };
}

function restoringSnapshot(revision = 1): AccountSnapshot {
  return {
    state: 'restoring-session',
    profileId: 'default',
    profile: null,
    entitlement: null,
    revision,
    capabilities,
  };
}

function secureStoreUnavailableSnapshot(revision = 1): AccountSnapshot {
  return {
    state: 'secure-store-unavailable',
    profileId: 'default',
    profile: null,
    entitlement: null,
    revision,
    capabilities,
  };
}

function networkErrorSnapshot(revision = 1, attemptId: string | null = null): AccountSnapshot {
  return {
    state: 'network-error',
    profileId: 'default',
    attemptId,
    profile: null,
    entitlement: null,
    revision,
    capabilities,
  };
}

function waitingSnapshot(revision = 2): AccountSnapshot {
  return {
    state: 'waiting-for-scan',
    profileId: 'default',
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
    profileId: 'default',
    profile: {
      avatarUrl: 'https://qpic.y.qq.com/synthetic-avatar.png',
      nickname: 'Synthetic Listener',
      maskedIdentity: '10******01',
    },
    entitlement: {
      tier: 'green-diamond',
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
    providerId: 'account-test',
    id,
    profileId: 'default',
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
    profileId: 'default',
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
    profileId: 'default',
    displayName: 'Account Test',
    getHome: unsupported,
    getDiscover: unsupported,
    getArea: unsupported,
    getSong: unsupported,
    getAlbum: unsupported,
    getArtist: unsupported,
    getPlaylist: unsupported,
    getLibrary: unsupported,
    getLyrics: unsupported,
    search: unsupported,
    getAccountSnapshot: vi.fn().mockResolvedValue(guestSnapshot()),
    refreshAccount: vi.fn().mockResolvedValue(guestSnapshot()),
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
    coreStatusMocks.reset();
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

  it('materializes an alternate profile for legacy account snapshots, playlists, and songs', async () => {
    const provider = accountProvider({ profileId: 'alternate' });
    const legacySnapshot = {
      ...authenticatedSnapshot(4),
      profileId: undefined,
    } as unknown as AccountSnapshot;
    const legacyPlaylist = {
      ...accountPlaylistSummary(),
      profileId: undefined,
    } as unknown as AccountPlaylistSummary;
    const legacySong = {
      ...allSongs[0]!,
      provider: { providerId: 'account-test', profileId: undefined, trackId: allSongs[0]!.id },
    } as unknown as Song;
    provider.getAccountSnapshot = vi.fn().mockResolvedValue(legacySnapshot);
    provider.getAccountPlaylists = vi.fn().mockResolvedValue(page([legacyPlaylist], 4));
    provider.getFavoriteSongs = vi.fn().mockResolvedValue(page([legacySong], 4));

    await useAccountStore.getState().refreshSnapshot(provider);
    expect(useAccountStore.getState().snapshot).toMatchObject({
      providerId: 'account-test',
      profileId: 'alternate',
    });

    await useAccountStore.getState().loadPlaylists(provider);
    expect(useAccountStore.getState().playlists).toMatchObject({
      data: [{ providerId: 'account-test', profileId: 'alternate' }],
    });
    await useAccountStore.getState().loadFavorites(provider);
    expect(useAccountStore.getState().favorites).toMatchObject({
      data: [
        {
          provider: { providerId: 'account-test', profileId: 'alternate', trackId: legacySong.id },
        },
      ],
    });
  });

  it('rejects explicit foreign profile and provider scopes for an alternate profile', async () => {
    const provider = accountProvider({ profileId: 'alternate' });
    const foreignPlaylist = { ...accountPlaylistSummary(), profileId: 'default' };
    const foreignSong = {
      ...allSongs[0]!,
      provider: {
        providerId: 'foreign-provider',
        profileId: 'alternate',
        trackId: allSongs[0]!.id,
      },
    };
    provider.getAccountPlaylists = vi.fn().mockResolvedValue(page([foreignPlaylist], 3));
    provider.getFavoriteSongs = vi.fn().mockResolvedValue(page([foreignSong], 3));
    useAccountStore.setState({ snapshot: { ...authenticatedSnapshot(3), profileId: 'alternate' } });

    await useAccountStore.getState().loadPlaylists(provider);
    expect(useAccountStore.getState().playlists).toMatchObject({ status: 'error', data: null });
    await useAccountStore.getState().loadFavorites(provider);
    expect(useAccountStore.getState().favorites).toMatchObject({ status: 'error', data: null });
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

  it('refreshes the account snapshot when Electron core-status becomes ready again', async () => {
    coreStatusMocks.kind = 'electron';
    const getAccountSnapshot = vi
      .fn()
      .mockResolvedValueOnce(guestSnapshot())
      .mockResolvedValue(authenticatedSnapshot());
    const provider = accountProvider({ getAccountSnapshot });
    const { unmount } = renderHook(() => useAccountRuntime(provider));

    await waitFor(() => expect(useAccountStore.getState().snapshot.state).toBe('guest'));
    expect(getAccountSnapshot).toHaveBeenCalledOnce();

    await act(async () => {
      coreStatusMocks.emit('ready');
    });
    await waitFor(() => expect(useAccountStore.getState().snapshot.state).toBe('authenticated'));
    expect(getAccountSnapshot).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('refreshes after account events and revalidates an authenticated account on focus', async () => {
    vi.useFakeTimers();
    const getAccountSnapshot = vi
      .fn()
      .mockResolvedValueOnce(guestSnapshot())
      .mockResolvedValue(authenticatedSnapshot());
    const refreshAccount = vi.fn().mockResolvedValue(authenticatedSnapshot(4));
    const provider = accountProvider({ getAccountSnapshot, refreshAccount });
    const { unmount } = renderHook(() => useAccountRuntime(provider));

    await act(async () => Promise.resolve());
    await act(async () => {
      coreStatusMocks.emitAccount(true);
      await Promise.resolve();
    });
    expect(useAccountStore.getState().snapshot.state).toBe('authenticated');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(refreshAccount).toHaveBeenCalledOnce();
    expect(useAccountStore.getState().snapshot.revision).toBe(4);
    unmount();
  });

  it('retries an Android secure-store restore immediately without waiting for the normal gap', async () => {
    coreStatusMocks.kind = 'android';
    const getAccountSnapshot = vi.fn().mockResolvedValue(secureStoreUnavailableSnapshot());
    const refreshAccount = vi.fn().mockResolvedValue(authenticatedSnapshot(2));
    const provider = accountProvider({ getAccountSnapshot, refreshAccount });
    const { unmount } = renderHook(() => useAccountRuntime(provider));

    await waitFor(() => expect(useAccountStore.getState().snapshot.state).toBe('authenticated'));
    expect(refreshAccount).toHaveBeenCalledOnce();
    unmount();
  });

  it('retries an Android network-interrupted restore when connectivity returns', async () => {
    vi.useFakeTimers();
    coreStatusMocks.kind = 'android';
    const getAccountSnapshot = vi.fn().mockResolvedValue(networkErrorSnapshot());
    const refreshAccount = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError('offline', 'offline', true))
      .mockResolvedValueOnce(authenticatedSnapshot(2));
    const provider = accountProvider({ getAccountSnapshot, refreshAccount });
    const { unmount } = renderHook(() => useAccountRuntime(provider));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refreshAccount).toHaveBeenCalledOnce();
    expect(useAccountStore.getState().snapshot.state).toBe('network-error');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      window.dispatchEvent(new Event('online'));
      await Promise.resolve();
    });
    expect(refreshAccount).toHaveBeenCalledTimes(2);
    expect(useAccountStore.getState().snapshot.state).toBe('authenticated');
    unmount();
  });

  it('retries an Android network-interrupted restore after five seconds without an online event', async () => {
    vi.useFakeTimers();
    coreStatusMocks.kind = 'android';
    const getAccountSnapshot = vi.fn().mockResolvedValue(networkErrorSnapshot());
    const refreshAccount = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError('offline', 'offline', true))
      .mockResolvedValueOnce(authenticatedSnapshot(2));
    const provider = accountProvider({ getAccountSnapshot, refreshAccount });
    const { unmount } = renderHook(() => useAccountRuntime(provider));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refreshAccount).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(refreshAccount).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(refreshAccount).toHaveBeenCalledTimes(2);
    expect(useAccountStore.getState().snapshot.state).toBe('authenticated');
    unmount();
  });

  it('does not mistake an Android login-attempt network error for a restore failure', async () => {
    coreStatusMocks.kind = 'android';
    const getAccountSnapshot = vi.fn().mockResolvedValue(networkErrorSnapshot(1, 'login-attempt'));
    const refreshAccount = vi.fn();
    const provider = accountProvider({ getAccountSnapshot, refreshAccount });
    const { unmount } = renderHook(() => useAccountRuntime(provider));

    await waitFor(() => expect(useAccountStore.getState().snapshot.state).toBe('network-error'));
    expect(refreshAccount).not.toHaveBeenCalled();
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

  it('does not commit a foreign snapshot returned by cancellation', async () => {
    const foreign = { ...cancelledSnapshot(), providerId: 'foreign-provider' };
    const cancelQrLogin = vi.fn().mockResolvedValue(foreign);
    const provider = accountProvider({ cancelQrLogin });
    const waiting = waitingSnapshot();
    useAccountStore.setState({ snapshot: waiting, dialogOpen: true });

    await useAccountStore.getState().closeDialog(provider);

    expect(cancelQrLogin).toHaveBeenCalledOnce();
    expect(useAccountStore.getState().snapshot).toEqual(waiting);
    expect(useAccountStore.getState().snapshot).not.toMatchObject({
      providerId: 'foreign-provider',
    });
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

  it('keeps ownership across pagehide and accepts the current snapshot result', async () => {
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

    expect(useAccountStore.getState().displayedQrImageDataUri).toBe(waiting.qrImageDataUri);
    expect(cancelQrLogin).not.toHaveBeenCalled();
    initial.resolve(authenticatedSnapshot());
    await act(async () => initial.promise);
    expect(useAccountStore.getState().snapshot.state).toBe('authenticated');

    unmount();
    expect(cancelQrLogin).not.toHaveBeenCalled();
  });

  it('pauses renderer polling while hidden and snapshots before resuming on foreground', async () => {
    vi.useFakeTimers();
    const getAccountSnapshot = vi.fn().mockResolvedValue(waitingSnapshot());
    const heartbeatQrLogin = vi.fn().mockResolvedValue(waitingSnapshot());
    const provider = accountProvider({ getAccountSnapshot, heartbeatQrLogin });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const { unmount } = renderHook(() => useAccountRuntime(provider));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(heartbeatQrLogin).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(getAccountSnapshot).toHaveBeenCalledTimes(2);
    unmount();
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

  it('keeps native Android ownership across runtime remount and rotation', async () => {
    coreStatusMocks.kind = 'android';
    const snapshot = waitingSnapshot();
    const getAccountSnapshot = vi.fn().mockResolvedValue(snapshot);
    const cancelQrLogin = vi.fn().mockResolvedValue(cancelledSnapshot());
    const provider = accountProvider({ getAccountSnapshot, cancelQrLogin });
    const first = renderHook(() => useAccountRuntime(provider));
    await act(async () => Promise.resolve());
    act(() => useAccountStore.getState().openDialog());
    act(() => window.dispatchEvent(new Event('orientationchange')));
    first.unmount();
    expect(cancelQrLogin).not.toHaveBeenCalled();
    const second = renderHook(() => useAccountRuntime(provider));
    await act(async () => Promise.resolve());
    expect(useAccountStore.getState().snapshot).toMatchObject({ attemptId: 'attempt-a' });
    expect(provider.startWebLogin).not.toHaveBeenCalled();
    second.unmount();
    expect(cancelQrLogin).not.toHaveBeenCalled();
  });

  it('keeps the authenticated projection when Android replaces the same logical provider', async () => {
    coreStatusMocks.kind = 'android';
    const replacementSnapshot = deferred<AccountSnapshot>();
    const original = accountProvider({
      getAccountSnapshot: vi.fn().mockResolvedValue(authenticatedSnapshot()),
    });
    const replacement = accountProvider({
      getAccountSnapshot: vi.fn(() => replacementSnapshot.promise),
    });
    const view = renderHook(
      ({ provider }: { provider: MusicProvider & AccountMusicProvider }) =>
        useAccountRuntime(provider),
      { initialProps: { provider: original } },
    );

    await waitFor(() => expect(useAccountStore.getState().snapshot.state).toBe('authenticated'));
    view.rerender({ provider: replacement });
    expect(useAccountStore.getState().snapshot.state).toBe('authenticated');

    replacementSnapshot.resolve(authenticatedSnapshot(4));
    await act(async () => replacementSnapshot.promise);
    expect(useAccountStore.getState().snapshot).toMatchObject({
      state: 'authenticated',
      revision: 4,
    });
    view.unmount();
  });

  it('does not let a background snapshot supersede an in-flight login command', async () => {
    const startup = deferred<AccountSnapshot>();
    const provider = accountProvider({ startWebLogin: vi.fn(() => startup.promise) });
    useAccountStore.setState({ snapshot: guestSnapshot(), dialogOpen: true });
    const start = useAccountStore.getState().startLogin(provider, 'qq');
    await useAccountStore.getState().refreshSnapshot(provider);
    expect(provider.getAccountSnapshot).not.toHaveBeenCalled();
    startup.resolve(waitingSnapshot());
    await start;
    expect(useAccountStore.getState().snapshot).toMatchObject({ attemptId: 'attempt-a' });
    expect(provider.cancelQrLogin).not.toHaveBeenCalled();
  });

  it('delegates Android heartbeat ownership to native while refreshing the same visible attempt', async () => {
    vi.useFakeTimers();
    coreStatusMocks.kind = 'android';
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    const provider = accountProvider({
      getAccountSnapshot: vi.fn().mockResolvedValue(waitingSnapshot()),
    });
    const view = renderHook(() => useAccountRuntime(provider));
    await act(async () => Promise.resolve());
    act(() => useAccountStore.getState().openDialog());
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(provider.heartbeatQrLogin).not.toHaveBeenCalled();
    expect(provider.getAccountSnapshot).toHaveBeenCalledTimes(4);
    expect(provider.startWebLogin).not.toHaveBeenCalled();
    view.unmount();
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

  it('does not commit a foreign account playlist page', async () => {
    const summary = { ...accountPlaylistSummary(), providerId: 'foreign-provider' };
    const getAccountPlaylists = vi.fn().mockResolvedValue(page([summary], 3));
    const provider = accountProvider({ getAccountPlaylists });
    useAccountStore.setState({ snapshot: authenticatedSnapshot(3) });

    await useAccountStore.getState().loadPlaylists(provider);

    expect(getAccountPlaylists).toHaveBeenCalledOnce();
    expect(useAccountStore.getState().playlists).toMatchObject({
      status: 'error',
      data: null,
    });
    expect(useAccountStore.getState().playlists).not.toMatchObject({
      data: [{ providerId: 'foreign-provider' }],
    });
  });

  it('does not commit a foreign account playlist detail summary', async () => {
    const summary = accountPlaylistSummary();
    const foreignSummary = { ...summary, profileId: 'foreign-profile' };
    const provider = accountProvider({
      getAccountPlaylistTracks: vi.fn().mockResolvedValue({
        summary: foreignSummary,
        tracks: page([], 3),
      }),
    });
    useAccountStore.setState({ snapshot: authenticatedSnapshot(3) });

    await useAccountStore.getState().loadAccountPlaylist(provider, summary);

    expect(useAccountStore.getState().accountPlaylistDetails[summary.id]).toMatchObject({
      status: 'error',
      data: null,
    });
    expect(useAccountStore.getState().accountPlaylistDetails[summary.id]).not.toMatchObject({
      data: { summary: { profileId: 'foreign-profile' } },
    });
  });

  it('does not commit an account playlist detail with a foreign track', async () => {
    const summary = accountPlaylistSummary();
    const foreignTrack = {
      ...allSongs[0]!,
      provider: { providerId: 'foreign-provider', profileId: 'default', trackId: allSongs[0]!.id },
    };
    const provider = accountProvider({
      getAccountPlaylistTracks: vi.fn().mockResolvedValue({
        summary,
        tracks: page([foreignTrack], 3),
      }),
    });
    useAccountStore.setState({ snapshot: authenticatedSnapshot(3) });

    await useAccountStore.getState().loadAccountPlaylist(provider, summary);

    expect(useAccountStore.getState().accountPlaylistDetails[summary.id]).toMatchObject({
      status: 'error',
      data: null,
    });
    expect(useAccountStore.getState().accountPlaylistDetails[summary.id]).not.toMatchObject({
      data: { tracks: { items: [{ provider: { providerId: 'foreign-provider' } }] } },
    });
  });

  it('rolls back when a playlist mutation returns a foreign playlist', async () => {
    const summary = accountPlaylistSummary();
    const foreign = { ...summary, providerId: 'foreign-provider' };
    const renamePlaylist = vi.fn(async (request: { clientOperationId: string }) =>
      playlistMutationResult(request.clientOperationId, 'applied', foreign),
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

    const result = await useAccountStore.getState().renamePlaylist(provider, summary, 'Renamed');

    expect(result).toBeNull();
    expect(renamePlaylist).toHaveBeenCalledOnce();
    expect(useAccountStore.getState().playlists).toMatchObject({
      data: [{ id: summary.id, title: summary.title, providerId: 'account-test' }],
    });
    expect(useAccountStore.getState().accountPlaylistDetails[summary.id]).toMatchObject({
      data: { summary: { title: summary.title, providerId: 'account-test' } },
    });
    expect(useAccountStore.getState().playlists).not.toMatchObject({
      data: [{ providerId: 'foreign-provider' }],
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
    expect(provider.getHome).toHaveBeenCalledTimes(2);
    expect(provider.getLibrary).toHaveBeenCalledOnce();
    expect(getFavoriteSongs).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps late snapshot and sign-out work in its provider/profile scope', async () => {
    const lateSnapshot = deferred<AccountSnapshot>();
    const lateSignOut = deferred<AccountSnapshot>();
    const profileSnapshot = (profileId: string, revision: number) => ({
      ...authenticatedSnapshot(revision),
      providerId: 'account-test',
      profileId,
    });
    const providerA = accountProvider({
      profileId: 'profile-a',
      getAccountSnapshot: vi
        .fn()
        .mockResolvedValueOnce(profileSnapshot('profile-a', 3))
        .mockImplementationOnce(() => lateSnapshot.promise)
        .mockResolvedValue(profileSnapshot('profile-a', 4)),
      signOut: vi.fn(() => lateSignOut.promise),
    });
    const providerB = accountProvider({
      profileId: 'profile-b',
      getAccountSnapshot: vi.fn().mockResolvedValue(profileSnapshot('profile-b', 7)),
    });

    await useAccountStore.getState().refreshSnapshot(providerA);
    const refreshA = useAccountStore.getState().refreshSnapshot(providerA);
    await useAccountStore.getState().refreshSnapshot(providerB);
    lateSnapshot.resolve(profileSnapshot('profile-a', 4));
    await refreshA;

    expect(useAccountStore.getState().snapshot).toMatchObject({
      providerId: 'account-test',
      profileId: 'profile-b',
      revision: 7,
    });
    const activeA = renderHook(() => useAccountRuntime(providerA));
    expect(useAccountStore.getState().snapshot).toMatchObject({
      profileId: 'profile-a',
      revision: 4,
    });
    activeA.unmount();

    await useAccountStore.getState().refreshSnapshot(providerB);

    const signOutA = useAccountStore.getState().signOut(providerA);
    await useAccountStore.getState().refreshSnapshot(providerB);
    lateSignOut.resolve({
      ...guestSnapshot(8),
      providerId: 'account-test',
      profileId: 'profile-a',
    });
    await signOutA;

    expect(useAccountStore.getState().snapshot).toMatchObject({
      profileId: 'profile-b',
      state: 'authenticated',
      revision: 7,
    });
  });

  it('keeps the selected facade when another mounted scope receives an account event', async () => {
    const scoped = (profileId: string, revision: number) => ({
      ...authenticatedSnapshot(revision),
      providerId: 'account-test',
      profileId,
    });
    const providerA = accountProvider({
      profileId: 'profile-a',
      getAccountSnapshot: vi
        .fn()
        .mockResolvedValueOnce(scoped('profile-a', 3))
        .mockResolvedValue(scoped('profile-a', 4)),
    });
    const providerB = accountProvider({
      profileId: 'profile-b',
      getAccountSnapshot: vi.fn().mockResolvedValue(scoped('profile-b', 7)),
    });
    const a = renderHook(() => useAccountRuntime(providerA));
    const b = renderHook(() => useAccountRuntime(providerB));
    await waitFor(() => expect(useAccountStore.getState().snapshot.profileId).toBe('profile-b'));

    await act(async () => {
      coreStatusMocks.emitAccount(true);
      await Promise.resolve();
    });
    await waitFor(() => expect(providerA.getAccountSnapshot).toHaveBeenCalledTimes(2));
    expect(useAccountStore.getState().snapshot).toMatchObject({
      profileId: 'profile-b',
      revision: 7,
    });

    b.unmount();
    a.unmount();
  });

  it('does not cancel a waiting QR owner until the last same-scope runtime unmounts', async () => {
    const cancelQrLogin = vi.fn().mockResolvedValue(cancelledSnapshot());
    const provider = accountProvider({
      getAccountSnapshot: vi.fn().mockResolvedValue(waitingSnapshot()),
      cancelQrLogin,
    });
    const first = renderHook(() => useAccountRuntime(provider));
    const second = renderHook(() => useAccountRuntime(provider));
    await waitFor(() => expect(useAccountStore.getState().snapshot.state).toBe('waiting-for-scan'));

    first.unmount();
    expect(cancelQrLogin).not.toHaveBeenCalled();
    second.unmount();
    await waitFor(() => expect(cancelQrLogin).toHaveBeenCalledOnce());
  });

  it('cancels a waiting QR owner exactly once when reset precedes every heartbeat', async () => {
    const cancelQrLogin = vi.fn().mockResolvedValue(cancelledSnapshot());
    const provider = accountProvider({
      getAccountSnapshot: vi.fn().mockResolvedValue(waitingSnapshot()),
      cancelQrLogin,
    });
    const view = renderHook(() => useAccountRuntime(provider));
    await waitFor(() => expect(useAccountStore.getState().snapshot.state).toBe('waiting-for-scan'));

    resetAccountRuntimeForTest();
    await waitFor(() => expect(cancelQrLogin).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => Promise.resolve());
    expect(cancelQrLogin).toHaveBeenCalledOnce();
  });

  it('keeps a heartbeat failure in A when B becomes the active facade', async () => {
    const heartbeat = deferred<AccountSnapshot>();
    const refreshA = deferred<AccountSnapshot>();
    const cancelA = deferred<AccountSnapshot>();
    const waitingA = {
      ...waitingSnapshot(),
      providerId: 'account-test',
      profileId: 'profile-a',
    };
    const providerA = accountProvider({
      profileId: 'profile-a',
      getAccountSnapshot: vi.fn().mockResolvedValue(waitingA),
      refreshAccount: vi.fn(() => refreshA.promise),
      heartbeatQrLogin: vi.fn(() => heartbeat.promise),
      cancelQrLogin: vi.fn(() => cancelA.promise),
    });
    const providerB = accountProvider({
      profileId: 'profile-b',
      getAccountSnapshot: vi.fn().mockResolvedValue({
        ...authenticatedSnapshot(7),
        providerId: 'account-test',
        profileId: 'profile-b',
      }),
    });

    await useAccountStore.getState().refreshSnapshot(providerA);
    const pendingHeartbeat = useAccountStore.getState().heartbeatLogin(providerA);
    await useAccountStore.getState().refreshSnapshot(providerB);
    const before = useAccountStore.getState();
    heartbeat.reject(new ProviderError('offline', 'transient', true));
    await waitFor(() => expect(providerA.cancelQrLogin).toHaveBeenCalledOnce());

    expect(useAccountStore.getState()).toMatchObject({
      snapshot: before.snapshot,
      displayedQrImageDataUri: before.displayedQrImageDataUri,
      busy: before.busy,
    });

    const pendingA = useAccountStore.getState().refreshAccount(providerA);
    expect(useAccountStore.getState()).toMatchObject({
      snapshot: waitingA,
      displayedQrImageDataUri: null,
      busy: false,
      error: 'network',
    });
    refreshA.resolve(waitingA);
    await pendingA;
    cancelA.resolve({
      ...cancelledSnapshot(),
      providerId: 'account-test',
      profileId: 'profile-a',
    });
    await pendingHeartbeat;
  });

  it('keeps a desktop waiting QR owner through same-scope provider replacement', async () => {
    const cancelQrLogin = vi.fn().mockResolvedValue(cancelledSnapshot());
    const original = accountProvider({
      getAccountSnapshot: vi.fn().mockResolvedValue(waitingSnapshot()),
      cancelQrLogin,
    });
    const replacement = accountProvider({
      getAccountSnapshot: vi.fn().mockResolvedValue(waitingSnapshot()),
      cancelQrLogin,
    });
    const view = renderHook(
      ({ provider }: { provider: MusicProvider & AccountMusicProvider }) =>
        useAccountRuntime(provider),
      { initialProps: { provider: original } },
    );
    await waitFor(() => expect(useAccountStore.getState().snapshot.state).toBe('waiting-for-scan'));
    view.rerender({ provider: replacement });
    await act(async () => Promise.resolve());
    expect(cancelQrLogin).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(cancelQrLogin).toHaveBeenCalledOnce());
  });

  it('cancels the last inactive scope owner without changing the active facade', async () => {
    const cancelA = vi.fn().mockResolvedValue(cancelledSnapshot());
    const providerA = accountProvider({
      profileId: 'profile-a',
      getAccountSnapshot: vi.fn().mockResolvedValue({
        ...waitingSnapshot(),
        providerId: 'account-test',
        profileId: 'profile-a',
      }),
      cancelQrLogin: cancelA,
    });
    const providerB = accountProvider({
      profileId: 'profile-b',
      getAccountSnapshot: vi.fn().mockResolvedValue({
        ...authenticatedSnapshot(7),
        providerId: 'account-test',
        profileId: 'profile-b',
      }),
    });
    const a = renderHook(() => useAccountRuntime(providerA));
    await waitFor(() => expect(useAccountStore.getState().snapshot.state).toBe('waiting-for-scan'));
    const b = renderHook(() => useAccountRuntime(providerB));
    await waitFor(() => expect(useAccountStore.getState().snapshot.profileId).toBe('profile-b'));

    a.unmount();
    await waitFor(() => expect(cancelA).toHaveBeenCalledOnce());
    expect(useAccountStore.getState().snapshot).toMatchObject({
      profileId: 'profile-b',
      state: 'authenticated',
      revision: 7,
    });
    b.unmount();
  });

  it('isolates same-track favorite mutation guards across profiles while retaining the legacy facade', async () => {
    const track = allSongs[0]!;
    const pendingA = deferred<FavoriteMutationResult>();
    const profileSnapshot = (profileId: string) => ({
      ...authenticatedSnapshot(3),
      providerId: 'account-test',
      profileId,
    });
    const setFavoriteA = vi.fn((request: FavoriteMutationRequest) => {
      void request;
      return pendingA.promise;
    });
    const providerA = accountProvider({
      profileId: 'profile-a',
      getAccountSnapshot: vi.fn().mockResolvedValue(profileSnapshot('profile-a')),
      setFavorite: setFavoriteA,
    });
    const providerB = accountProvider({
      profileId: 'profile-b',
      getAccountSnapshot: vi.fn().mockResolvedValue(profileSnapshot('profile-b')),
      setFavorite: vi.fn(async (request: FavoriteMutationRequest) =>
        favoriteResult(request.clientOperationId, track, 'applied', true),
      ),
    });

    await useAccountStore.getState().refreshSnapshot(providerA);
    const mutationA = useAccountStore.getState().setFavorite(providerA, track, true);
    expect(useAccountStore.getState().favoritePendingByTrackId[track.id]).toBeDefined();

    await useAccountStore.getState().refreshSnapshot(providerB);
    await useAccountStore.getState().setFavorite(providerB, track, true);

    expect(providerB.setFavorite).toHaveBeenCalledOnce();
    expect(useAccountStore.getState().favoriteByTrackId[track.id]).toBe(true);
    expect(useAccountStore.getState().favoritePendingByTrackId[track.id]).toBeUndefined();

    const operationA = setFavoriteA.mock.calls[0]![0].clientOperationId;
    pendingA.resolve(favoriteResult(operationA, track, 'applied', true));
    await mutationA;

    // The exported store remains a compatibility facade for the active B scope.
    expect(useAccountStore.getState().snapshot.profileId).toBe('profile-b');
    expect(useAccountStore.getState().favoriteByTrackId[track.id]).toBe(true);
  });

  it('does not share delayed pages or same playlist-ID mutation guards between profiles', async () => {
    const track = allSongs[0]!;
    const delayedPage = deferred<Page<Song>>();
    const delayedRename = deferred<PlaylistMutationResult>();
    const profileSnapshot = (profileId: string) => ({
      ...playlistAuthenticatedSnapshot(3),
      providerId: 'account-test',
      profileId,
    });
    const summaryA = { ...accountPlaylistSummary('shared-playlist-id'), profileId: 'profile-a' };
    const summaryB = { ...accountPlaylistSummary('shared-playlist-id'), profileId: 'profile-b' };
    const providerA = accountProvider({
      profileId: 'profile-a',
      getAccountSnapshot: vi.fn().mockResolvedValue(profileSnapshot('profile-a')),
      getFavoriteSongs: vi.fn(() => delayedPage.promise),
      renamePlaylist: vi.fn(() => delayedRename.promise),
    });
    const providerB = accountProvider({
      profileId: 'profile-b',
      getAccountSnapshot: vi.fn().mockResolvedValue(profileSnapshot('profile-b')),
      getFavoriteSongs: vi.fn().mockResolvedValue(page([track], 3)),
      renamePlaylist: vi.fn(async (request: { clientOperationId: string }) =>
        playlistMutationResult(request.clientOperationId, 'applied', {
          ...summaryB,
          title: 'B title',
        }),
      ),
    });

    await useAccountStore.getState().refreshSnapshot(providerA);
    const pageA = useAccountStore.getState().loadFavorites(providerA);
    useAccountStore.setState({
      playlists: {
        status: 'ready',
        data: [summaryA],
        nextCursor: null,
        total: 1,
        fetchedAtMs: 1,
        authRevision: 3,
      },
    });
    const renameA = useAccountStore.getState().renamePlaylist(providerA, summaryA, 'A title');

    await useAccountStore.getState().refreshSnapshot(providerB);
    useAccountStore.setState({
      playlists: {
        status: 'ready',
        data: [summaryB],
        nextCursor: null,
        total: 1,
        fetchedAtMs: 2,
        authRevision: 3,
      },
    });
    await useAccountStore.getState().loadFavorites(providerB);
    await useAccountStore.getState().renamePlaylist(providerB, summaryB, 'B title');

    delayedPage.resolve(page([], 3));
    delayedRename.resolve(playlistMutationResult('foreign-operation', 'rejected', summaryA));
    await Promise.all([pageA, renameA]);

    expect(providerB.renamePlaylist).toHaveBeenCalledOnce();
    expect(useAccountStore.getState().favorites).toMatchObject({ data: [track] });
    expect(useAccountStore.getState().playlists).toMatchObject({ data: [{ title: 'B title' }] });
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
