import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAccountRuntimeForTest, useAccountStore } from '../application/account-runtime';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import type { AccountPlaylistSummary } from '../domain/music';
import i18n from '../i18n';
import { playlists } from '../providers/fake/fixtures';
import { PlaylistPage } from './PlaylistPage';

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
});
