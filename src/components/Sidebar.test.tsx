import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppRoute } from '../application/navigation';
import { resetAccountRuntimeForTest, useAccountStore } from '../application/account-runtime';
import { ProviderContext } from '../application/provider-context';
import i18n from '../i18n';
import { fakeMusicProvider } from '../providers/fake/fake-music-provider';
import { Sidebar } from './Sidebar';

function renderSidebar(route: AppRoute = { page: 'home' }) {
  const onNavigate = vi.fn();
  const view = render(
    <ProviderContext.Provider value={fakeMusicProvider}>
      <Sidebar route={route} onNavigate={onNavigate} />
    </ProviderContext.Provider>,
  );
  return { ...view, onNavigate };
}

describe('Sidebar navigation', () => {
  beforeEach(async () => {
    resetAccountRuntimeForTest();
    await i18n.changeLanguage('en-US');
  });

  it('routes every primary and account-library destination explicitly', () => {
    const { onNavigate } = renderSidebar();
    const routes: Array<[string, AppRoute]> = [
      ['Home', { page: 'home' }],
      ['Search', { page: 'search' }],
      ['Explore', { page: 'explore' }],
      ['Favorites', { page: 'favorites' }],
      ['Playlists', { page: 'account-playlists' }],
      ['Recently played', { page: 'account-recent' }],
      ['Settings', { page: 'settings' }],
    ];

    for (const [name, route] of routes) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(onNavigate).toHaveBeenLastCalledWith(route);
    }
  });

  it('keeps the playlists destination active on an account detail route', () => {
    renderSidebar({
      page: 'account-playlist',
      playlist: {
        id: 'account-playlist-a',
        reference: { kind: 'owned', tid: 'account-playlist-a', dirId: 3001 },
        title: 'Playlist',
        description: '',
        owner: { id: 'owner', displayName: 'Owner' },
        artwork: { src: '', alt: '', dominantColor: '#000000' },
        ownership: 'owned',
        capabilities: {
          canAddTracks: true,
          canRemoveTracks: true,
          canRename: true,
          canDelete: true,
          canReorder: false,
        },
        trackCount: 0,
        updatedAtMs: null,
      },
    });

    expect(screen.getByRole('button', { name: 'Playlists' })).toHaveAttribute(
      'data-active',
      'true',
    );
  });

  it('renders the authenticated account identity, avatar, and entitlement summary', () => {
    useAccountStore.setState({
      snapshot: {
        state: 'authenticated',
        profile: {
          avatarUrl: 'https://q.qlogo.cn/synthetic-avatar.png',
          nickname: 'Synthetic Listener',
          maskedIdentity: '10******01',
        },
        entitlement: {
          tier: 'green-diamond',
          membership: 'active',
          expiresAtMs: 1_800_000_000_000,
          permittedQualities: ['standard', 'high', 'lossless'],
          observedMaximumQuality: 'lossless',
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

    renderSidebar();

    expect(screen.getByText('Synthetic Listener')).toBeInTheDocument();
    expect(screen.getByText('Green Diamond · Active')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Synthetic Listener account avatar' })).toHaveAttribute(
      'src',
      'https://q.qlogo.cn/synthetic-avatar.png',
    );
  });
});
