import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { NavigationProvider } from '../application/navigation-context';
import { FakeMusicProvider } from '../providers/fake/fake-music-provider';
import { areaFeeds } from '../providers/fake/fixtures';
import { AreaPage } from './AreaPage';

describe('AreaPage', () => {
  beforeEach(() => usePlayerStore.setState(initialPlayerState));

  it('renders songlists, playlists, and artists from the area feed', () => {
    const feed = areaFeeds['area-classic']!;
    const onNavigate = vi.fn();

    render(<AreaPage feed={feed} onNavigate={onNavigate} />);

    expect(screen.getByRole('heading', { name: feed.title })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Songlists' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Playlists' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Artists' })).toBeInTheDocument();

    for (const songlist of feed.songlists) {
      expect(screen.getAllByText(songlist.title).length).toBeGreaterThan(0);
    }
    for (const playlist of feed.playlists) {
      expect(screen.getAllByText(playlist.title).length).toBeGreaterThan(0);
    }
    for (const artist of feed.artists) {
      expect(screen.getAllByText(artist.name).length).toBeGreaterThan(0);
    }
  });

  it('navigates to a playlist when its card is opened', () => {
    const feed = areaFeeds['area-classic']!;
    const onNavigate = vi.fn();

    render(<AreaPage feed={feed} onNavigate={onNavigate} />);

    const playlist = feed.playlists[0]!;
    const openButtons = screen.getAllByRole('button', {
      name: `Open ${playlist.title}`,
    });
    openButtons[0]!.click();

    expect(onNavigate).toHaveBeenCalledWith({ page: 'playlist', id: playlist.id });
  });

  it('routes artist artwork and title to the exact artist entity', () => {
    const feed = areaFeeds['area-classic']!;
    const onNavigate = vi.fn();
    const artist = feed.artists[0]!;

    render(
      <NavigationProvider onNavigate={onNavigate}>
        <AreaPage feed={feed} onNavigate={onNavigate} />
      </NavigationProvider>,
    );

    const artistCard = screen.getByAltText(artist.name).closest('article');
    expect(artistCard).not.toBeNull();
    const artworkControl = artistCard!.querySelector<HTMLButtonElement>('.media-card__open')!;
    const titleControl = artistCard!.querySelector<HTMLButtonElement>('.media-card__title')!;
    expect(artworkControl).not.toBeNull();
    expect(titleControl).not.toBeNull();
    artworkControl.click();
    titleControl.click();

    expect(onNavigate).toHaveBeenNthCalledWith(1, { page: 'artist', id: artist.id });
    expect(onNavigate).toHaveBeenNthCalledWith(2, { page: 'artist', id: artist.id });
    expect(screen.getAllByText('Artist').length).toBeGreaterThan(0);
  });

  it('uses canonical fake artist IDs that resolve through the provider', async () => {
    const provider = new FakeMusicProvider();

    for (const artist of areaFeeds['area-classic']!.artists) {
      await expect(provider.getArtist(artist.id)).resolves.toMatchObject({ id: artist.id });
    }
  });
});
