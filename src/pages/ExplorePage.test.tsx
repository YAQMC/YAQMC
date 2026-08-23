import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { ProviderContext } from '../application/provider-context';
import { FakeMusicProvider } from '../providers/fake/fake-music-provider';
import { discoverFeed } from '../providers/fake/fixtures';
import { ExplorePage } from './ExplorePage';

describe('ExplorePage', () => {
  beforeEach(() => usePlayerStore.setState(initialPlayerState));

  it('renders all discover sections from the discover feed', async () => {
    const provider = new FakeMusicProvider();
    const onNavigate = vi.fn();

    render(
      <ProviderContext.Provider value={provider}>
        <ExplorePage onNavigate={onNavigate} />
      </ProviderContext.Provider>,
    );

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Charts' })).toBeInTheDocument(),
    );

    expect(screen.getByRole('heading', { name: 'Charts' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'New songs' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'New albums' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Categories' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'New MVs' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Podcasts' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Featured' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Popular playlists' })).toBeInTheDocument();

    for (const chart of discoverFeed.charts) {
      expect(screen.getAllByText(chart.title).length).toBeGreaterThan(0);
    }
    for (const album of discoverFeed.newAlbums) {
      expect(screen.getAllByText(album.title).length).toBeGreaterThan(0);
    }
    for (const playlist of discoverFeed.popularSonglists) {
      expect(screen.getAllByText(playlist.title).length).toBeGreaterThan(0);
    }
    for (const song of discoverFeed.newSongs!.tracks) {
      expect(screen.getAllByText(song.title).length).toBeGreaterThan(0);
    }
    for (const category of discoverFeed.categories) {
      expect(screen.getAllByText(category.title).length).toBeGreaterThan(0);
    }
    for (const mv of discoverFeed.newMvs) {
      expect(screen.getAllByText(mv.title).length).toBeGreaterThan(0);
    }
    for (const podcast of discoverFeed.podcasts) {
      expect(screen.getAllByText(podcast.title).length).toBeGreaterThan(0);
    }
    for (const card of discoverFeed.featured) {
      expect(screen.getAllByText(card.title).length).toBeGreaterThan(0);
    }
  });

  it('opens a chart playlist when its card is clicked', async () => {
    const provider = new FakeMusicProvider();
    const onNavigate = vi.fn();

    render(
      <ProviderContext.Provider value={provider}>
        <ExplorePage onNavigate={onNavigate} />
      </ProviderContext.Provider>,
    );

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Charts' })).toBeInTheDocument(),
    );

    const chart = discoverFeed.charts[0]!;
    const openButtons = screen.getAllByRole('button', {
      name: `Open ${chart.title}`,
    });
    openButtons[0]!.click();

    expect(onNavigate).toHaveBeenCalledWith({ page: 'playlist', id: chart.id });
  });

  it('opens the area page when a category card is clicked', async () => {
    const provider = new FakeMusicProvider();
    const onNavigate = vi.fn();

    render(
      <ProviderContext.Provider value={provider}>
        <ExplorePage onNavigate={onNavigate} />
      </ProviderContext.Provider>,
    );

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Categories' })).toBeInTheDocument(),
    );

    const category = discoverFeed.categories[0]!;
    const openButtons = screen.getAllByRole('button', {
      name: category.title,
    });
    openButtons[0]!.click();

    expect(onNavigate).toHaveBeenCalledWith({
      page: 'area',
      encArea: category.encArea,
      title: category.title,
    });
  });

  it('opens a new song without playing it, while explicit Play starts only that song', async () => {
    const provider = new FakeMusicProvider();
    const onNavigate = vi.fn();
    usePlayerStore.setState({ playTracks: vi.fn() });

    render(
      <ProviderContext.Provider value={provider}>
        <ExplorePage onNavigate={onNavigate} />
      </ProviderContext.Provider>,
    );

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'New songs' })).toBeInTheDocument(),
    );

    const song = discoverFeed.newSongs!.tracks[0]!;
    fireEvent.click(screen.getByRole('button', { name: `Open ${song.title}` }));
    expect(onNavigate).toHaveBeenCalledWith({ page: 'song', id: song.id });
    expect(usePlayerStore.getState().playTracks).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: `Play ${song.title}` }));
    expect(usePlayerStore.getState().playTracks).toHaveBeenCalledOnce();
    expect(usePlayerStore.getState().playTracks).toHaveBeenCalledWith([song]);
  });
});
