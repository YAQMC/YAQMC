import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAccountRuntimeForTest, useAccountStore } from '../application/account-runtime';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { ProviderContext } from '../application/provider-context';
import type {
  AccountPlaylistSummary,
  AccountSnapshot,
  FavoriteMutationResult,
  PlaylistTrackMutationRequest,
  ProviderTrackReference,
  Song,
} from '../domain/music';
import i18n from '../i18n';
import { allSongs } from '../providers/fake/fixtures';
import { QQMusicProvider, qqMusicProvider } from '../providers/qqmusic/qq-music-provider';
import { NavigationProvider } from '../application/navigation-context';
import { TrackList } from './TrackList';

function qqTrack(): Song {
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

  it('uses a stable QQ Music song mid when the current payload has no numeric song id', async () => {
    const track = qqTrack();
    const providerReference: ProviderTrackReference = { ...track.provider! };
    delete providerReference.numericId;
    track.provider = providerReference;
    const setFavorite = vi
      .spyOn(qqMusicProvider, 'setFavorite')
      .mockImplementation(async (request) => ({
        clientOperationId: request.clientOperationId,
        status: 'applied',
        trackId: request.trackId,
        favorite: request.favorite,
        errorCode: null,
        authRevision: 3,
      }));
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
    expect(favorite).toBeEnabled();
    fireEvent.click(favorite);
    await waitFor(() => expect(setFavorite).toHaveBeenCalledOnce());
    expect(setFavorite.mock.calls[0]![0]).toMatchObject({
      trackId: track.id,
      favorite: true,
    });
  });

  it('turns the row overflow affordance into a working queue action', () => {
    const track = allSongs[0]!;
    render(<TrackList tracks={[track]} />);

    fireEvent.click(screen.getByRole('button', { name: `More actions for ${track.title}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to queue' }));

    expect(usePlayerStore.getState().queue).toEqual([track]);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('adds the row track to an owned playlist from the overflow menu', async () => {
    const track = qqTrack();
    const playlist: AccountPlaylistSummary = {
      id: 'qqmusic:playlist:owned-a',
      reference: { kind: 'owned', tid: 'owned-a', dirId: 2 },
      title: 'Synthetic Mix',
      description: '',
      owner: { id: 'account-owner', displayName: 'Listener' },
      artwork: track.artwork,
      ownership: 'owned',
      capabilities: {
        canAddTracks: true,
        canRemoveTracks: true,
        canRename: true,
        canDelete: true,
        canReorder: false,
      },
      trackCount: 1,
      updatedAtMs: null,
    };
    const addPlaylistTrack = vi.fn(async (request: PlaylistTrackMutationRequest) => ({
      clientOperationId: request.clientOperationId,
      status: 'applied' as const,
      playlist,
      errorCode: null,
      authRevision: 3,
    }));
    const provider = Object.assign(new QQMusicProvider(), { addPlaylistTrack });
    useAccountStore.setState({
      snapshot: {
        ...authenticatedSnapshot(),
        capabilities: { ...authenticatedSnapshot().capabilities, playlistWrite: true },
      },
      playlists: {
        status: 'ready',
        data: [
          playlist,
          {
            ...playlist,
            id: 'qqmusic:playlist:collected-a',
            title: 'Saved Mix',
            ownership: 'collected',
            capabilities: {
              canAddTracks: false,
              canRemoveTracks: false,
              canRename: false,
              canDelete: false,
              canReorder: false,
            },
          },
        ],
        nextCursor: null,
        total: 2,
        fetchedAtMs: 1,
        authRevision: 3,
      },
    });

    render(
      <ProviderContext.Provider value={provider}>
        <TrackList tracks={[track]} />
      </ProviderContext.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: `More actions for ${track.title}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to playlist' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Synthetic Mix' }));

    await waitFor(() => expect(addPlaylistTrack).toHaveBeenCalledOnce());
    expect(addPlaylistTrack.mock.calls[0]![0]).toMatchObject({
      playlistId: playlist.id,
      trackId: track.id,
    });
    expect(
      screen.queryByRole('menu', { name: `Add ${track.title} to a playlist` }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Saved Mix' })).not.toBeInTheDocument();
  });

  it('opens sign-in from Add to playlist when the account is a guest', () => {
    const track = qqTrack();
    const addPlaylistTrack = vi.spyOn(qqMusicProvider, 'addPlaylistTrack');
    useAccountStore.setState({ dialogOpen: false });
    render(
      <ProviderContext.Provider value={qqMusicProvider}>
        <TrackList tracks={[track]} />
      </ProviderContext.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: `More actions for ${track.title}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to playlist' }));

    expect(addPlaylistTrack).not.toHaveBeenCalled();
    expect(useAccountStore.getState().dialogOpen).toBe(true);
    expect(
      screen.queryByRole('menu', { name: `Add ${track.title} to a playlist` }),
    ).not.toBeInTheDocument();
  });

  it('opens the same song actions from right click and keyboard context menu', () => {
    const track = allSongs[0]!;
    const { container } = render(<TrackList tracks={[track]} />);
    const row = container.querySelector<HTMLElement>('.track-row')!;

    fireEvent.contextMenu(row, { clientX: 120, clientY: 80 });
    expect(screen.getByRole('menu', { name: `More actions for ${track.title}` })).toBeVisible();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to queue' }));
    expect(usePlayerStore.getState().queue).toEqual([track]);

    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menu', { name: `More actions for ${track.title}` })).toBeVisible();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('routes the song, each artist, and album without changing playback', () => {
    const track: Song = {
      ...allSongs[0]!,
      id: 'song-link',
      title: 'Linked Song',
      artists: [
        { id: 'artist-one', name: 'Artist One' },
        { id: 'artist-two', name: 'Artist Two' },
      ],
      album: { id: 'album-link', title: 'Linked Album' },
    };
    const onNavigate = vi.fn();
    const { container, rerender } = render(
      <NavigationProvider onNavigate={onNavigate}>
        <TrackList tracks={[track]} showAlbum />
      </NavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Linked Song' }));
    fireEvent.click(screen.getByRole('button', { name: 'Artist One' }));
    fireEvent.click(screen.getByRole('button', { name: 'Artist Two' }));
    fireEvent.click(screen.getByRole('button', { name: 'Linked Album' }));

    expect(onNavigate.mock.calls).toEqual([
      [{ page: 'song', id: 'song-link' }],
      [{ page: 'artist', id: 'artist-one' }],
      [{ page: 'artist', id: 'artist-two' }],
      [{ page: 'album', id: 'album-link' }],
    ]);
    expect(usePlayerStore.getState().queue).toEqual([]);
    expect(container.querySelector('button button')).toBeNull();
    expect(container.querySelector('button a')).toBeNull();

    const blankTrack: Song = {
      ...track,
      id: ' ',
      title: 'Plain Song',
      artists: [
        { id: ' ', name: 'Plain Artist' },
        { id: '', name: 'Plain Guest' },
      ],
      album: { id: '', title: 'Plain Album' },
    };
    const before = usePlayerStore.getState();
    rerender(
      <NavigationProvider onNavigate={onNavigate}>
        <TrackList tracks={[blankTrack]} showAlbum />
      </NavigationProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Plain Song' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Plain Artist' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Plain Guest' })).toBeNull();
    expect(screen.getByText('Plain Album')).toBeInTheDocument();
    expect(usePlayerStore.getState()).toMatchObject({
      queue: before.queue,
      currentIndex: before.currentIndex,
      isPlaying: before.isPlaying,
    });
  });

  it('does not offer actions or duplicate keys for blank track IDs', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tracks = [
      { ...allSongs[0]!, id: '', title: 'Blank Track' },
      { ...allSongs[0]!, id: '   ', title: 'Whitespace Track' },
    ];

    const { container } = render(<TrackList tracks={tracks} />);

    expect(container.querySelectorAll('.track-row')).toHaveLength(2);
    expect(consoleError.mock.calls.some(([message]) => String(message).includes('same key'))).toBe(
      false,
    );
    for (const title of ['Blank Track', 'Whitespace Track']) {
      const row = screen.getByText(title).closest('.track-row');
      expect(row).not.toBeNull();
      expect(row).not.toHaveAttribute('tabindex');
      expect(row?.querySelector('.track-row__actions')).toBeEmptyDOMElement();
      expect(row?.querySelectorAll('button')).toHaveLength(0);
      expect(screen.queryByRole('button', { name: new RegExp(`Play ${title}`) })).toBeNull();
      expect(screen.queryByRole('button', { name: `More actions for ${title}` })).toBeNull();
      expect(screen.queryByRole('button', { name: `Add ${title} to Favorites` })).toBeNull();
    }
  });

  it('keeps repeated artist button names equal to the visible artist name', () => {
    const first: Song = {
      ...allSongs[0]!,
      id: 'song-one',
      title: 'Song One',
      artists: [{ id: 'artist-shared', name: 'Artist' }],
    };
    const second: Song = {
      ...first,
      id: 'song-two',
      title: 'Song Two',
    };
    render(
      <NavigationProvider onNavigate={vi.fn()}>
        <TrackList tracks={[first, second]} />
      </NavigationProvider>,
    );

    expect(screen.getAllByRole('button', { name: 'Artist' })).toHaveLength(2);
  });
});
