import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAccountRuntimeForTest, useAccountStore } from '../application/account-runtime';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { ProviderContext } from '../application/provider-context';
import type {
  AccountPlaylistSummary,
  DeletePlaylistRequest,
  PlaylistMutationResult,
  PlaylistTrackMutationRequest,
  RenamePlaylistRequest,
} from '../domain/music';
import i18n from '../i18n';
import { playlists } from '../providers/fake/fixtures';
import { QQMusicProvider, qqMusicProvider } from '../providers/qqmusic/qq-music-provider';
import { PlaylistPage } from './PlaylistPage';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function authenticatePlaylistWrites() {
  useAccountStore.setState({
    snapshot: {
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
        playlistWrite: true,
        recentHistoryRead: true,
      },
    },
  });
}

function accountSummary(): AccountPlaylistSummary {
  const playlist = playlists[0]!;
  return {
    id: playlist.id,
    title: playlist.title,
    description: playlist.description,
    owner: playlist.owner,
    artwork: playlist.artwork,
    ownership: 'owned',
    capabilities: {
      canAddTracks: true,
      canRemoveTracks: true,
      canRename: true,
      canDelete: false,
      canReorder: false,
    },
    trackCount: playlist.tracks.length + 1,
    updatedAtMs: null,
  };
}

describe('PlaylistPage account projection', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
    resetAccountRuntimeForTest();
    usePlayerStore.setState(initialPlayerState);
  });

  it('renders ownership and capability state with a paged load-more control', () => {
    const onLoadMore = vi.fn();
    const { container } = render(
      <PlaylistPage
        playlist={playlists[0]!}
        accountSummary={accountSummary()}
        hasMore
        onLoadMore={onLoadMore}
      />,
    );

    expect(container.querySelector('.detail-page')).toHaveAttribute(
      'data-account-ownership',
      'owned',
    );
    expect(container.querySelector('.detail-page')).toHaveAttribute('data-can-rename', 'true');
    expect(container.querySelector('.detail-page')).not.toHaveAttribute('data-can-delete');
    expect(screen.getByText('Owned playlist · Editing available')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Load more tracks' }));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it('disables pagination while a next page is loading', () => {
    render(
      <PlaylistPage
        playlist={playlists[0]!}
        accountSummary={accountSummary()}
        loadingMore
        onLoadMore={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Loading more tracks…' })).toBeDisabled();
  });

  it('renders playlist rows from the canonical favorite projection', () => {
    const playlist = playlists[0]!;
    const track = playlist.tracks[0]!;
    useAccountStore.setState({ favoriteByTrackId: { [track.id]: true } });

    render(<PlaylistPage playlist={playlist} />);

    expect(
      screen.getByRole('button', { name: `Remove ${track.title} from Favorites` }),
    ).toBeVisible();
  });

  it('shows only capability-authorized owner controls', () => {
    const summary = accountSummary();
    authenticatePlaylistWrites();
    usePlayerStore.setState({ queue: [playlists[0]!.tracks[0]!], currentIndex: 0 });

    render(
      <ProviderContext.Provider value={qqMusicProvider}>
        <PlaylistPage playlist={playlists[0]!} accountSummary={summary} />
      </ProviderContext.Provider>,
    );

    expect(screen.getByRole('button', { name: 'Rename playlist' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Delete playlist' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add current track' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove current track' })).toBeEnabled();
  });

  it('hides every owner-only control for a collected playlist', () => {
    const summary: AccountPlaylistSummary = {
      ...accountSummary(),
      ownership: 'collected',
      capabilities: {
        canAddTracks: false,
        canRemoveTracks: false,
        canRename: false,
        canDelete: false,
        canReorder: false,
      },
    };
    render(<PlaylistPage playlist={playlists[0]!} accountSummary={summary} />);

    for (const label of [
      'Rename playlist',
      'Delete playlist',
      'Add current track',
      'Remove current track',
    ]) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });

  it('keeps delete available when safe rename capability is absent', () => {
    const summary: AccountPlaylistSummary = {
      ...accountSummary(),
      capabilities: {
        ...accountSummary().capabilities,
        canRename: false,
        canDelete: true,
      },
    };
    render(
      <ProviderContext.Provider value={qqMusicProvider}>
        <PlaylistPage playlist={playlists[0]!} accountSummary={summary} />
      </ProviderContext.Provider>,
    );

    expect(screen.queryByRole('button', { name: 'Rename playlist' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete playlist' })).toBeEnabled();
  });

  it('submits one rename and disables every same-playlist action until it settles', async () => {
    const summary = {
      ...accountSummary(),
      capabilities: { ...accountSummary().capabilities, canDelete: true },
    };
    const pending = deferred<PlaylistMutationResult>();
    const renamePlaylist = vi.fn((request: RenamePlaylistRequest) => {
      void request;
      return pending.promise;
    });
    const provider = Object.assign(new QQMusicProvider(), { renamePlaylist });
    authenticatePlaylistWrites();
    usePlayerStore.setState({ queue: [playlists[0]!.tracks[0]!], currentIndex: 0 });

    render(
      <ProviderContext.Provider value={provider}>
        <PlaylistPage playlist={playlists[0]!} accountSummary={summary} />
      </ProviderContext.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Rename playlist' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Playlist name' }), {
      target: { value: 'Verified rename' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save playlist name' }));

    await waitFor(() => expect(renamePlaylist).toHaveBeenCalledOnce());
    const request = renamePlaylist.mock.calls[0]![0];
    expect(request).toMatchObject({ playlistId: summary.id, title: 'Verified rename' });
    for (const label of [
      'Rename playlist',
      'Delete playlist',
      'Add current track',
      'Remove current track',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeDisabled();
    }

    pending.resolve({
      clientOperationId: request.clientOperationId,
      status: 'applied',
      playlist: { ...summary, title: 'Verified rename' },
      errorCode: null,
      authRevision: 3,
    });
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Playlist name' })).not.toBeInTheDocument(),
    );
  });

  it('requires explicit confirmation before one destructive delete', async () => {
    const summary = {
      ...accountSummary(),
      capabilities: { ...accountSummary().capabilities, canDelete: true },
    };
    const deletePlaylist = vi.fn(async (request: DeletePlaylistRequest) => ({
      clientOperationId: request.clientOperationId,
      status: 'applied' as const,
      playlist: null,
      errorCode: null,
      authRevision: 3,
    }));
    const provider = Object.assign(new QQMusicProvider(), { deletePlaylist });
    const onDeleted = vi.fn();
    authenticatePlaylistWrites();

    render(
      <ProviderContext.Provider value={provider}>
        <PlaylistPage playlist={playlists[0]!} accountSummary={summary} onDeleted={onDeleted} />
      </ProviderContext.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete playlist' }));
    expect(deletePlaylist).not.toHaveBeenCalled();
    expect(screen.getByText('Delete this playlist? This cannot be undone.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete playlist' }));

    await waitFor(() => expect(deletePlaylist).toHaveBeenCalledOnce());
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
  });

  it('sends each current-track mutation exactly once with stable IDs', async () => {
    const summary = accountSummary();
    const currentTrack = playlists[0]!.tracks[0]!;
    const applied = (request: { clientOperationId: string }) => ({
      clientOperationId: request.clientOperationId,
      status: 'applied' as const,
      playlist: summary,
      errorCode: null,
      authRevision: 3,
    });
    const addPlaylistTrack = vi.fn(async (request: PlaylistTrackMutationRequest) =>
      applied(request),
    );
    const removePlaylistTrack = vi.fn(async (request: PlaylistTrackMutationRequest) =>
      applied(request),
    );
    const provider = Object.assign(new QQMusicProvider(), {
      addPlaylistTrack,
      removePlaylistTrack,
    });
    authenticatePlaylistWrites();
    usePlayerStore.setState({ queue: [currentTrack], currentIndex: 0 });

    render(
      <ProviderContext.Provider value={provider}>
        <PlaylistPage playlist={playlists[0]!} accountSummary={summary} />
      </ProviderContext.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add current track' }));
    await waitFor(() => expect(addPlaylistTrack).toHaveBeenCalledOnce());
    expect(addPlaylistTrack.mock.calls[0]![0]).toMatchObject({
      playlistId: summary.id,
      trackId: currentTrack.id,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove current track' }));
    await waitFor(() => expect(removePlaylistTrack).toHaveBeenCalledOnce());
    expect(removePlaylistTrack.mock.calls[0]![0]).toMatchObject({
      playlistId: summary.id,
      trackId: currentTrack.id,
    });
  });

  it('shows an operation-specific uncertainty message without a playlist name', () => {
    const summary = accountSummary();
    useAccountStore.setState({
      playlistMutationNoticeById: {
        [summary.id]: { operation: 'remove', outcome: 'outcome-unknown' },
      },
    });

    render(<PlaylistPage playlist={playlists[0]!} accountSummary={summary} />);

    expect(
      screen.getByText('QQ Music could not confirm the removed track. Refreshing this playlist.'),
    ).toBeVisible();
  });
});
