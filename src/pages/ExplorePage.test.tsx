import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { ProviderContext } from '../application/provider-context';
import type { DiscoverFeed } from '../domain/music';
import { FakeMusicProvider } from '../providers/fake/fake-music-provider';
import { discoverFeed } from '../providers/fake/fixtures';
import type { MusicProvider } from '../providers/music-provider';
import { ExplorePage } from './ExplorePage';

function providerWithId(id: string): MusicProvider {
  return Object.create(new FakeMusicProvider(), {
    id: { value: id, enumerable: true },
  }) as MusicProvider;
}

function renderExplore(provider: MusicProvider, onNavigate = vi.fn()) {
  return {
    onNavigate,
    ...render(
      <ProviderContext.Provider value={provider}>
        <ExplorePage onNavigate={onNavigate} />
      </ProviderContext.Provider>,
    ),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe('ExplorePage', () => {
  beforeEach(() => usePlayerStore.setState(initialPlayerState));

  it('renders content-backed tabs with one labelled, focusable panel', async () => {
    renderExplore(providerWithId('fake.tabs'));

    const featured = await screen.findByRole('tab', { name: 'Featured' });
    expect(screen.getByRole('tablist', { name: 'Discover categories' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Featured',
      'Charts',
      'New songs',
      'New albums',
      'Categories',
      'New MVs',
      'Podcasts',
    ]);
    expect(featured).toHaveAttribute('aria-selected', 'true');
    expect(featured).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tabpanel', { name: 'Featured' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('heading', { name: 'Featured' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Popular playlists' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Charts' })).not.toBeInTheDocument();
  });

  it('opens a chart playlist from the mouse-selected tab', async () => {
    const { onNavigate } = renderExplore(providerWithId('fake.charts'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Charts' }));

    const chart = discoverFeed.charts[0]!;
    fireEvent.click(screen.getAllByRole('button', { name: `Open ${chart.title}` })[0]!);

    expect(onNavigate).toHaveBeenCalledWith({ page: 'playlist', id: chart.id });
  });

  it('opens the area page from the categories tab', async () => {
    const { onNavigate } = renderExplore(providerWithId('fake.categories'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Categories' }));

    const category = discoverFeed.categories[0]!;
    fireEvent.click(screen.getAllByRole('button', { name: category.title })[0]!);

    expect(onNavigate).toHaveBeenCalledWith({
      page: 'area',
      encArea: category.encArea,
      title: category.title,
    });
  });

  it('opens a new song without playing it, while explicit Play starts only that song', async () => {
    const { onNavigate } = renderExplore(providerWithId('fake.songs'));
    usePlayerStore.setState({ playTracks: vi.fn() });
    fireEvent.click(await screen.findByRole('tab', { name: 'New songs' }));

    const song = discoverFeed.newSongs!.tracks[0]!;
    fireEvent.click(screen.getByRole('button', { name: `Open ${song.title}` }));
    expect(onNavigate).toHaveBeenCalledWith({ page: 'song', id: song.id });
    expect(usePlayerStore.getState().playTracks).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: `Play ${song.title}` }));
    expect(usePlayerStore.getState().playTracks).toHaveBeenCalledOnce();
    expect(usePlayerStore.getState().playTracks).toHaveBeenCalledWith([song]);
  });

  it('uses roving focus and immediate keyboard activation', async () => {
    renderExplore(providerWithId('fake.keyboard'));
    const featured = await screen.findByRole('tab', { name: 'Featured' });
    featured.focus();

    fireEvent.keyDown(featured, { key: 'ArrowLeft' });
    const podcasts = screen.getByRole('tab', { name: 'Podcasts' });
    expect(podcasts).toHaveFocus();
    expect(podcasts).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Podcasts' })).toHaveAttribute('tabindex', '0');
    expect(screen.queryByRole('heading', { name: 'Featured' })).not.toBeInTheDocument();

    fireEvent.keyDown(podcasts, { key: 'Home' });
    expect(featured).toHaveFocus();
    expect(featured).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(featured, { key: 'End' });
    expect(podcasts).toHaveFocus();
    expect(podcasts).toHaveAttribute('aria-selected', 'true');
  });

  it('remembers the selected category per provider for the application session', async () => {
    const first = renderExplore(providerWithId('fake.remembered'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Charts' }));
    first.unmount();

    const second = renderExplore(providerWithId('fake.remembered'));
    expect(await screen.findByRole('tab', { name: 'Charts' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    second.unmount();

    renderExplore(providerWithId('fake.other'));
    expect(await screen.findByRole('tab', { name: 'Featured' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('drops empty categories and falls back when refresh removes the active category', async () => {
    const provider = providerWithId('fake.refresh');
    const refreshed = deferred<DiscoverFeed>();
    vi.spyOn(provider, 'getDiscover').mockImplementation((_signal, refresh) =>
      refresh ? refreshed.promise : Promise.resolve(structuredClone(discoverFeed)),
    );
    renderExplore(provider);
    fireEvent.click(await screen.findByRole('tab', { name: 'Podcasts' }));
    expect(screen.getByRole('tab', { name: 'Podcasts' })).toHaveAttribute('aria-selected', 'true');

    refreshed.resolve({ ...structuredClone(discoverFeed), podcasts: [] });

    await waitFor(() =>
      expect(screen.queryByRole('tab', { name: 'Podcasts' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('tab', { name: 'Featured' })).toHaveAttribute('aria-selected', 'true');
  });

  it('renders a stable empty state when every discover category is empty', async () => {
    const provider = providerWithId('fake.empty');
    const emptyFeed: DiscoverFeed = {
      charts: [],
      newSongs: null,
      newAlbums: [],
      popularSonglists: [],
      categories: [],
      podcasts: [],
      newMvs: [],
      featured: [],
    };
    vi.spyOn(provider, 'getDiscover').mockResolvedValue(emptyFeed);
    renderExplore(provider);

    expect(
      await screen.findByText('No discover categories are available right now.'),
    ).toBeVisible();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });
});
