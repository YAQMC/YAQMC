import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, type AccountSnapshot } from '../domain/music';
import type { AccountMusicProvider, MusicProvider } from '../providers/music-provider';
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
    capabilities: { ...capabilities, favoriteRead: true },
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
  overrides: Partial<AccountMusicProvider> = {},
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
});
