import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppRoute } from '../application/navigation';
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
    await i18n.changeLanguage('en-US');
  });

  it('routes every primary and account-library destination explicitly', () => {
    const { onNavigate } = renderSidebar();
    const routes: Array<[string, AppRoute]> = [
      ['Home', { page: 'home' }],
      ['Search', { page: 'search' }],
      ['Explore', { page: 'explore' }],
      ['Library', { page: 'library' }],
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
    renderSidebar({ page: 'account-playlist', id: 'account-playlist-a' });

    expect(screen.getByRole('button', { name: 'Playlists' })).toHaveAttribute(
      'data-active',
      'true',
    );
  });
});
