import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import type {
  AccountPlaylistSummary,
  AccountSnapshot,
  RemotePlayHistoryItem,
} from '../domain/music';
import i18n from '../i18n';
import { allSongs, playlists } from '../providers/fake/fixtures';
import { LibraryPage } from './LibraryPage';

const capabilities = {
  qrLogin: true,
  favoriteRead: true,
  favoriteWrite: true,
  playlistRead: true,
  playlistWrite: true,
  recentHistoryRead: true,
};

function guestSnapshot(): AccountSnapshot {
  return {
    state: 'guest',
    profile: null,
    entitlement: null,
    revision: 1,
    capabilities,
  };
}

function authenticatedSnapshot(avatarUrl: string | null = null): AccountSnapshot {
  return {
    state: 'authenticated',
    profile: {
      avatarUrl,
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
    revision: 3,
    capabilities,
  };
}

function playlistSummary(): AccountPlaylistSummary {
  const fixture = playlists[0]!;
  return {
    id: 'account-playlist-a',
    title: 'Synthetic Mix',
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
    trackCount: 2,
    updatedAtMs: null,
  };
}

function renderLibrary(overrides: Partial<ComponentProps<typeof LibraryPage>> = {}) {
  const props: ComponentProps<typeof LibraryPage> = {
    view: 'favorites',
    snapshot: authenticatedSnapshot(),
    favorites: { status: 'idle' },
    playlists: { status: 'idle' },
    recent: { status: 'idle' },
    onNavigate: vi.fn(),
    onSignIn: vi.fn(),
    onRetry: vi.fn(),
    onLoadMore: vi.fn(),
    ...overrides,
  };
  return { ...render(<LibraryPage {...props} />), props };
}

describe('LibraryPage account resources', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
    usePlayerStore.setState(initialPlayerState);
  });

  it('shows a restrained sign-in state for a guest rather than a catalog error', () => {
    renderLibrary({ snapshot: guestSnapshot() });

    expect(screen.getByRole('heading', { name: 'Sign in to view Favorite Songs' })).toBeVisible();
    expect(screen.queryByText('Music is unavailable')).not.toBeInTheDocument();
  });

  it('labels remote QQ Music history without claiming local playback history', () => {
    const item: RemotePlayHistoryItem = {
      song: allSongs[0]!,
      playedAtMs: 1_800_000_000_000,
      source: 'qqmusic-account',
    };
    renderLibrary({
      view: 'recent',
      recent: {
        status: 'ready',
        data: [item],
        nextCursor: null,
        total: 1,
        fetchedAtMs: 1_800_000_000_000,
        authRevision: 3,
      },
    });

    expect(screen.getByText('QQ Music and local playback history')).toBeVisible();
    expect(screen.queryByText('Local playback history')).not.toBeInTheDocument();
  });

  it('keeps stale favorites visible with an explicit retry', () => {
    const onRetry = vi.fn();
    renderLibrary({
      favorites: {
        status: 'stale',
        data: [allSongs[0]!],
        total: 1,
        fetchedAtMs: 1_800_000_000_000,
        authRevision: 3,
      },
      onRetry,
    });

    expect(screen.getByText('Showing saved account data')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledWith('favorites');
    expect(screen.getByText(allSongs[0]!.title)).toBeVisible();
  });

  it('renders empty, error, and reauthentication states with actionable controls', () => {
    const onRetry = vi.fn();
    const onSignIn = vi.fn();
    const view = renderLibrary({ favorites: { status: 'empty' }, onRetry, onSignIn });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledWith('favorites');

    view.rerender(
      <LibraryPage
        {...view.props}
        favorites={{ status: 'error', error: 'network', data: null, nextCursor: null }}
      />,
    );
    expect(screen.getByText('QQ Music could not be reached.')).toBeVisible();

    view.rerender(
      <LibraryPage
        {...view.props}
        snapshot={{
          state: 'reauthentication-required',
          profile: authenticatedSnapshot().profile,
          entitlement: authenticatedSnapshot().entitlement,
          revision: 4,
          capabilities,
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Authorize again' }));
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it('navigates playlist summaries through the distinct account route and paginates', () => {
    const summary = playlistSummary();
    const onNavigate = vi.fn();
    const onLoadMore = vi.fn();
    renderLibrary({
      view: 'playlists',
      playlists: {
        status: 'ready',
        data: [summary],
        nextCursor: 'next-page',
        total: 2,
        fetchedAtMs: 1_800_000_000_000,
        authRevision: 3,
      },
      onNavigate,
      onLoadMore,
    });

    fireEvent.click(screen.getByRole('button', { name: /Synthetic Mix/ }));
    expect(onNavigate).toHaveBeenCalledWith({ page: 'account-playlist', id: summary.id });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalledWith('playlists');
  });

  it('does not render an untrusted profile avatar URL', () => {
    const { container } = renderLibrary({
      view: 'summary',
      snapshot: authenticatedSnapshot('https://untrusted.example/private.png'),
      playlists: { status: 'empty' },
    });

    expect(container.innerHTML).not.toContain('untrusted.example');
  });

  it('renders an exact Tencent profile avatar origin', () => {
    const { container } = renderLibrary({
      view: 'summary',
      snapshot: authenticatedSnapshot('https://thirdwx.qlogo.cn/synthetic-avatar.png'),
      playlists: { status: 'empty' },
    });

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'https://thirdwx.qlogo.cn/synthetic-avatar.png',
    );
  });
});
