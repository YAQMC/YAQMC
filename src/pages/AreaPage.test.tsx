import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
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
});
