import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { ProviderContext } from '../application/provider-context';
import type { Song } from '../domain/music';
import { FakeMusicProvider } from '../providers/fake/fake-music-provider';
import { allSongs, homeFeed } from '../providers/fake/fixtures';
import { SearchPage } from './SearchPage';

function pagedSong(index: number): Song {
  const fixture = allSongs[0]!;
  return { ...fixture, id: `page-track-${index}`, title: `Page track ${index}` };
}

describe('SearchPage', () => {
  beforeEach(() => usePlayerStore.setState(initialPlayerState));

  it('renders every song appended by pagination', async () => {
    const provider = new FakeMusicProvider();
    vi.spyOn(provider, 'search').mockImplementation(async (query, _signal, page = 1) => ({
      query,
      songs: Array.from({ length: 8 }, (_, offset) => pagedSong((page - 1) * 8 + offset)),
      albums: [],
      playlists: [],
      page,
      hasMore: page === 1,
    }));

    const { container } = render(
      <ProviderContext.Provider value={provider}>
        <SearchPage feed={homeFeed} onNavigate={() => undefined} />
      </ProviderContext.Provider>,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Search music' }), {
      target: { value: 'page' },
    });
    await waitFor(() => expect(container.querySelectorAll('button.track-row')).toHaveLength(8));

    fireEvent.click(screen.getByRole('button', { name: 'Load more songs' }));
    await waitFor(() => expect(container.querySelectorAll('button.track-row')).toHaveLength(16));
    expect(screen.getByText('Page track 15')).toBeInTheDocument();
  });
});
