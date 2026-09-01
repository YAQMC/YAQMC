import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { resetAccountRuntimeForTest, useAccountStore } from '../application/account-runtime';
import { allSongs } from '../providers/fake/fixtures';
import { SongPage } from './SongPage';
import { NavigationProvider } from '../application/navigation-context';
import { ProviderContext } from '../application/provider-context';
import { fakeMusicProvider } from '../providers/fake/fake-music-provider';
import type { AccountMusicProvider, MusicProvider } from '../providers/music-provider';

describe('SongPage', () => {
  beforeEach(() => {
    resetAccountRuntimeForTest();
    usePlayerStore.setState(initialPlayerState);
  });

  it('renders linked metadata and keeps play/add-to-queue actions available', () => {
    const song = {
      ...allSongs[0]!,
      artists: [...allSongs[0]!.artists, { id: 'artist-second', name: 'Second Artist' }],
    };
    const onNavigate = vi.fn();
    render(
      <NavigationProvider onNavigate={onNavigate}>
        <SongPage song={song} />
      </NavigationProvider>,
    );

    expect(screen.getByRole('heading', { name: song.title })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: song.artists[0]!.name })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Second Artist' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: song.album.title })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: song.artists[0]!.name }));
    fireEvent.click(screen.getByRole('button', { name: 'Second Artist' }));
    fireEvent.click(screen.getByRole('button', { name: song.album.title }));
    expect(onNavigate).toHaveBeenNthCalledWith(1, { page: 'artist', id: song.artists[0]!.id });
    expect(onNavigate).toHaveBeenNthCalledWith(2, { page: 'artist', id: 'artist-second' });
    expect(onNavigate).toHaveBeenNthCalledWith(3, { page: 'album', id: song.album.id });

    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(usePlayerStore.getState().queue).toEqual([song]);
    fireEvent.click(screen.getByRole('button', { name: 'More song actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to queue' }));
    expect(usePlayerStore.getState().queue).toEqual([song, song]);
  });

  it('copies the provider-neutral YAQMC song link from the song menu', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const song = allSongs[0]!;

    render(
      <ProviderContext.Provider value={fakeMusicProvider}>
        <SongPage song={song} />
      </ProviderContext.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'More song actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy YAQMC link' }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`yaqmc://catalog/fake/song?id=${song.id}`),
    );
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('enables favorite action only for an account-capable provider and routes through the store', async () => {
    const setFavorite = vi.fn().mockResolvedValue({
      clientOperationId: 'favorite-op',
      status: 'applied',
      trackId: 'quiet-light',
      favorite: true,
      errorCode: null,
      authRevision: 1,
    });
    const unused = vi.fn().mockResolvedValue(undefined);
    const provider = Object.assign(Object.create(fakeMusicProvider), {
      id: 'qqmusic',
      getAccountSnapshot: unused,
      refreshAccount: unused,
      startWebLogin: unused,
      startQrLogin: unused,
      heartbeatQrLogin: unused,
      cancelQrLogin: unused,
      refreshQrLogin: unused,
      signOut: unused,
      getFavoriteSongs: unused,
      getAccountPlaylists: unused,
      getAccountPlaylistTracks: unused,
      getAccountRecentlyPlayed: unused,
      setFavorite,
      createPlaylist: unused,
      renamePlaylist: unused,
      addPlaylistTrack: unused,
      removePlaylistTrack: unused,
      deletePlaylist: unused,
      setPlaylistCollected: unused,
    }) as MusicProvider & AccountMusicProvider;
    const favoriteSong = {
      ...allSongs[0]!,
      isFavorite: false,
      provider: { providerId: 'qqmusic', trackId: 'remote-quiet-light' },
    };
    useAccountStore.setState({
      snapshot: {
        state: 'authenticated',
        profile: { avatarUrl: null, nickname: 'Test', maskedIdentity: 'test' },
        entitlement: {
          tier: 'free',
          membership: 'active',
          expiresAtMs: null,
          permittedQualities: ['standard'],
          observedMaximumQuality: 'standard',
          restrictions: [],
        },
        revision: 1,
        capabilities: {
          qrLogin: false,
          favoriteRead: true,
          favoriteWrite: true,
          playlistRead: false,
          playlistWrite: false,
          recentHistoryRead: false,
        },
      },
    });
    render(
      <ProviderContext.Provider value={provider}>
        <NavigationProvider onNavigate={() => undefined}>
          <SongPage song={favoriteSong} />
        </NavigationProvider>
      </ProviderContext.Provider>,
    );

    const favorite = screen.getByRole('button', {
      name: `Add ${favoriteSong.title} to Favorites`,
    });
    expect(favorite).toBeEnabled();
    fireEvent.click(favorite);
    await waitFor(() =>
      expect(setFavorite).toHaveBeenCalledWith(
        expect.objectContaining({ trackId: favoriteSong.id, favorite: true }),
        undefined,
      ),
    );
  });

  it('keeps blank artist IDs as unique plain text instead of links', () => {
    const song = {
      ...allSongs[0]!,
      artists: [
        { id: '', name: 'Blank Artist One' },
        { id: '   ', name: 'Blank Artist Two' },
      ],
    };
    const onNavigate = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <NavigationProvider onNavigate={onNavigate}>
        <SongPage song={song} />
      </NavigationProvider>,
    );

    for (const name of ['Blank Artist One', 'Blank Artist Two']) {
      expect(screen.getByText(name)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name })).toBeNull();
      fireEvent.click(screen.getByText(name));
    }
    expect(onNavigate).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.some(([message]) => String(message).includes('same key'))).toBe(
      false,
    );
  });
});
