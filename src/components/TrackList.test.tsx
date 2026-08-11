import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAccountRuntimeForTest, useAccountStore } from '../application/account-runtime';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { ProviderContext } from '../application/provider-context';
import type { AccountSnapshot, FavoriteMutationResult } from '../domain/music';
import i18n from '../i18n';
import { allSongs } from '../providers/fake/fixtures';
import { qqMusicProvider } from '../providers/qqmusic/qq-music-provider';
import { TrackList } from './TrackList';

function qqTrack() {
  return {
    ...allSongs[0]!,
    id: 'qqmusic:track:SANITIZED_TRACK_A',
    provider: {
      providerId: 'qqmusic',
      trackId: 'SANITIZED_TRACK_A',
      numericId: 1001,
    },
  };
}

function authenticatedSnapshot(): AccountSnapshot {
  return {
    state: 'authenticated',
    profile: { avatarUrl: null, nickname: 'Listener', maskedIdentity: '10******01' },
    entitlement: {
      tier: 'free',
      membership: 'active',
      expiresAtMs: null,
      permittedQualities: ['standard'],
      observedMaximumQuality: 'standard',
      restrictions: [],
    },
    revision: 3,
    capabilities: {
      qrLogin: true,
      favoriteRead: true,
      favoriteWrite: true,
      playlistRead: true,
      playlistWrite: false,
      recentHistoryRead: true,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('TrackList favorite controls', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await i18n.changeLanguage('en-US');
    resetAccountRuntimeForTest();
    usePlayerStore.setState(initialPlayerState);
  });

  it('uses sibling play and favorite buttons without nested interactive elements', async () => {
    const track = qqTrack();
    const originalFavorite = track.isFavorite;
    const pending = deferred<FavoriteMutationResult>();
    const setFavorite = vi
      .spyOn(qqMusicProvider, 'setFavorite')
      .mockImplementation(() => pending.promise);
    useAccountStore.setState({
      snapshot: authenticatedSnapshot(),
      favoriteByTrackId: { [track.id]: false },
    });
    const { container } = render(
      <ProviderContext.Provider value={qqMusicProvider}>
        <TrackList tracks={[track]} />
      </ProviderContext.Provider>,
    );

    expect(container.querySelector('button button')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Play ${track.title}`) }));
    expect(usePlayerStore.getState().queue).toEqual([track]);

    fireEvent.click(screen.getByRole('button', { name: `Add ${track.title} to Favorites` }));
    const request = setFavorite.mock.calls[0]![0];
    expect(request).toMatchObject({ trackId: track.id, favorite: true });
    expect(
      screen.getByRole('button', { name: `Updating favorite for ${track.title}` }),
    ).toBeDisabled();

    await act(async () => {
      pending.resolve({
        clientOperationId: request.clientOperationId,
        status: 'applied',
        trackId: track.id,
        favorite: true,
        errorCode: null,
        authRevision: 3,
      });
      await pending.promise;
    });

    expect(
      screen.getByRole('button', { name: `Remove ${track.title} from Favorites` }),
    ).toBeEnabled();
    expect(usePlayerStore.getState().queue[0]).toBe(track);
    expect(track.isFavorite).toBe(originalFavorite);
  });

  it('opens sign-in for a guest without sending a favorite write', () => {
    const track = allSongs[0]!;
    const setFavorite = vi.spyOn(qqMusicProvider, 'setFavorite');
    useAccountStore.setState({ favoriteByTrackId: { [track.id]: false }, dialogOpen: false });
    render(
      <ProviderContext.Provider value={qqMusicProvider}>
        <TrackList tracks={[track]} />
      </ProviderContext.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: `Add ${track.title} to Favorites` }));

    expect(setFavorite).not.toHaveBeenCalled();
    expect(useAccountStore.getState().dialogOpen).toBe(true);
  });

  it('does not send an authenticated write without a numeric QQ Music track reference', () => {
    const track = allSongs[0]!;
    const setFavorite = vi.spyOn(qqMusicProvider, 'setFavorite');
    useAccountStore.setState({
      snapshot: authenticatedSnapshot(),
      favoriteByTrackId: { [track.id]: false },
    });
    render(
      <ProviderContext.Provider value={qqMusicProvider}>
        <TrackList tracks={[track]} />
      </ProviderContext.Provider>,
    );

    const favorite = screen.getByRole('button', { name: `Add ${track.title} to Favorites` });
    expect(favorite).toBeDisabled();
    fireEvent.click(favorite);
    expect(setFavorite).not.toHaveBeenCalled();
  });
});
