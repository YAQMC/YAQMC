import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MediaLibraryPage } from './MediaLibraryPage';

describe('MediaLibraryPage', () => {
  it('exposes all four library destinations', () => {
    const onNavigate = vi.fn();
    render(<MediaLibraryPage onNavigate={onNavigate} />);

    const routes = [
      ['Favorite Songs', { page: 'favorites' }],
      ['My playlists', { page: 'account-playlists' }],
      ['Recently played', { page: 'account-recent' }],
      ['Statistics', { page: 'statistics' }],
    ] as const;
    for (const [name, route] of routes) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
      expect(onNavigate).toHaveBeenLastCalledWith(route);
    }
  });
});
