import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAccountRuntimeForTest, useAccountStore } from '../application/account-runtime';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import i18n from '../i18n';
import { albums } from '../providers/fake/fixtures';
import { AlbumPage } from './AlbumPage';
import { NavigationProvider } from '../application/navigation-context';

describe('AlbumPage favorite projection', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
    resetAccountRuntimeForTest();
    usePlayerStore.setState(initialPlayerState);
  });

  it('renders track favorite state from the canonical account projection', () => {
    const album = albums[0]!;
    const track = album.tracks[0]!;
    useAccountStore.setState({ favoriteByTrackId: { [track.id]: true } });

    render(<AlbumPage album={album} />);

    expect(
      screen.getByRole('button', { name: `Remove ${track.title} from Favorites` }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Add album to favorites' }),
    ).not.toBeInTheDocument();
  });

  it('uses the authoritative shuffle mode and can return to ordered playback', () => {
    const album = albums[0]!;
    render(<AlbumPage album={album} />);

    fireEvent.click(screen.getByRole('button', { name: 'Shuffle' }));
    expect(usePlayerStore.getState().shuffle).toBe(true);
    expect(usePlayerStore.getState().queue).toEqual(album.tracks);
    expect(screen.getByRole('button', { name: 'Play in order' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Play in order' }));
    expect(usePlayerStore.getState().shuffle).toBe(false);
    expect(screen.getByRole('button', { name: 'Shuffle' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('opens the overflow menu and appends the complete album to the queue', () => {
    const album = albums[0]!;
    usePlayerStore.setState({ queue: [albums[1]!.tracks[0]!], currentIndex: 0 });
    render(<AlbumPage album={album} />);

    fireEvent.click(screen.getByRole('button', { name: 'More album actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add album to queue' }));

    expect(usePlayerStore.getState().queue.slice(1)).toEqual(album.tracks);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('navigates the album artist through the shared entity route', () => {
    const album = albums[0]!;
    const onNavigate = vi.fn();
    const view = render(
      <NavigationProvider onNavigate={onNavigate}>
        <AlbumPage album={album} />
      </NavigationProvider>,
    );

    const hero = view.container.querySelector<HTMLElement>('.detail-hero');
    expect(hero).not.toBeNull();
    fireEvent.click(within(hero!).getByRole('button', { name: album.artist.name }));

    expect(onNavigate).toHaveBeenCalledWith({ page: 'artist', id: album.artist.id });
  });
});
