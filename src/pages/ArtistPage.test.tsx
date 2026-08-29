import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { ProviderContext } from '../application/provider-context';
import { FakeMusicProvider } from '../providers/fake/fake-music-provider';
import { ArtistPage } from './ArtistPage';
import { NavigationProvider } from '../application/navigation-context';
import type { Artist, ArtistCatalogPage } from '../domain/music';

function renderArtist(provider: FakeMusicProvider, artist: Artist, onNavigate = vi.fn()) {
  return {
    onNavigate,
    ...render(
      <ProviderContext.Provider value={provider}>
        <NavigationProvider onNavigate={onNavigate}>
          <ArtistPage artist={artist} />
        </NavigationProvider>
      </ProviderContext.Provider>,
    ),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('ArtistPage', () => {
  beforeEach(() => usePlayerStore.setState(initialPlayerState));

  it('shows only top songs by default and exposes accessible lazy catalog tabs', async () => {
    const provider = new FakeMusicProvider();
    const artist = await provider.getArtist('artist-mira-vale');
    const getArtistCatalog = vi.spyOn(provider, 'getArtistCatalog');
    renderArtist(provider, artist);

    expect(screen.getByRole('heading', { name: artist.name })).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Artist catalog' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Top songs' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'All songs' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tab', { name: 'All albums' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel', { name: 'Top songs' })).toBeVisible();
    expect(screen.queryByRole('tabpanel', { name: 'All albums' })).not.toBeInTheDocument();
    expect(getArtistCatalog).not.toHaveBeenCalled();
  });

  it('omits an empty optional description', async () => {
    const provider = new FakeMusicProvider();
    const artist = await provider.getArtist('artist-mira-vale');
    renderArtist(provider, { ...artist, description: '   ' });

    expect(screen.queryByText(/About Mira Vale/)).not.toBeInTheDocument();
  });

  it('renders a round artist portrait and a separately labelled biography', async () => {
    const provider = new FakeMusicProvider();
    const artist = await provider.getArtist('artist-mira-vale');
    renderArtist(provider, artist);

    const portrait = screen.getByRole('img', { name: artist.artwork.alt });
    expect(portrait.parentElement).toHaveClass('artist-page__avatar');
    expect(screen.getByRole('region', { name: `About ${artist.name}` })).toHaveTextContent(
      artist.description,
    );
  });

  it('loads only the selected full catalog and reuses ready tabs', async () => {
    const provider = new FakeMusicProvider();
    const artist = await provider.getArtist('artist-mira-vale');
    const song = { ...artist.topSongs[0]!, id: 'all-song', title: 'All catalog song' };
    const album = { ...artist.albums[0]!, id: 'all-album', title: 'All catalog album' };
    const getArtistCatalog = vi
      .spyOn(provider, 'getArtistCatalog')
      .mockImplementation(async (artistId, kind, _signal, page = 1) =>
        kind === 'song'
          ? { kind: 'song', artistId, page, hasMore: false, items: [song] }
          : { kind: 'album', artistId, page, hasMore: false, items: [album] },
      );
    renderArtist(provider, artist);

    fireEvent.click(screen.getByRole('tab', { name: 'All songs' }));
    expect(await screen.findByText('All catalog song')).toBeVisible();
    expect(getArtistCatalog).toHaveBeenCalledWith(
      artist.id,
      'song',
      expect.any(AbortSignal),
      1,
      20,
    );
    expect(getArtistCatalog).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('tab', { name: 'All albums' }));
    expect(await screen.findByText('All catalog album')).toBeVisible();
    expect(getArtistCatalog).toHaveBeenLastCalledWith(
      artist.id,
      'album',
      expect.any(AbortSignal),
      1,
      20,
    );
    expect(getArtistCatalog).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('tab', { name: 'All songs' }));
    expect(screen.getByText('All catalog song')).toBeVisible();
    expect(getArtistCatalog).toHaveBeenCalledTimes(2);
  });

  it('can continue past an empty normalized page when the provider reports more results', async () => {
    const provider = new FakeMusicProvider();
    const artist = await provider.getArtist('artist-mira-vale');
    const laterSong = {
      ...artist.topSongs[0]!,
      id: 'later-catalog-song',
      title: 'Later catalog song',
    };
    vi.spyOn(provider, 'getArtistCatalog').mockImplementation(
      async (artistId, kind, _signal, page = 1) => {
        if (kind === 'album') {
          return { kind: 'album', artistId, page, hasMore: false, items: [] };
        }
        return {
          kind: 'song',
          artistId,
          page,
          hasMore: page === 1,
          items: page === 1 ? [] : [laterSong],
        };
      },
    );
    renderArtist(provider, artist);

    fireEvent.click(screen.getByRole('tab', { name: 'All songs' }));
    const loadMore = await screen.findByRole('button', { name: 'Load more all songs' });
    expect(screen.getByText('No songs available')).toBeVisible();
    fireEvent.click(loadMore);

    expect(await screen.findByText('Later catalog song')).toBeVisible();
  });

  it('preserves a page across a pagination error, retries, and deduplicates IDs', async () => {
    const provider = new FakeMusicProvider();
    const artist = await provider.getArtist('artist-mira-vale');
    const first = { ...artist.topSongs[0]!, id: 'catalog-song-1', title: 'Catalog song one' };
    const second = { ...artist.topSongs[0]!, id: 'catalog-song-2', title: 'Catalog song two' };
    let pageTwoAttempts = 0;
    vi.spyOn(provider, 'getArtistCatalog').mockImplementation(
      async (artistId, kind, _signal, page = 1) => {
        if (page === 2 && pageTwoAttempts++ === 0) throw new Error('temporary page error');
        if (kind === 'album') {
          return { kind: 'album', artistId, page, hasMore: false, items: [] };
        }
        return {
          kind: 'song',
          artistId,
          page,
          hasMore: page === 1,
          items: page === 1 ? [first] : [first, second],
        };
      },
    );
    renderArtist(provider, artist);

    fireEvent.click(screen.getByRole('tab', { name: 'All songs' }));
    await screen.findByText('Catalog song one');
    fireEvent.click(screen.getByRole('button', { name: 'Load more all songs' }));

    const pageError = await screen.findByRole('alert');
    const songsPanel = screen.getByRole('tabpanel', { name: 'All songs' });
    expect(pageError).toHaveTextContent('Could not load more all songs.');
    expect(screen.getByText('Catalog song one')).toBeVisible();
    expect(songsPanel.querySelectorAll('.track-row')).toHaveLength(1);
    fireEvent.click(within(pageError).getByRole('button', { name: 'Retry' }));

    await screen.findByText('Catalog song two');
    expect(songsPanel.querySelectorAll('.track-row')).toHaveLength(2);
  });

  it('rejects a mismatched typed response instead of rendering the wrong category', async () => {
    const provider = new FakeMusicProvider();
    const artist = await provider.getArtist('artist-mira-vale');
    const wrongAlbum = { ...artist.albums[0]!, id: 'wrong-album', title: 'Wrong category album' };
    vi.spyOn(provider, 'getArtistCatalog').mockResolvedValue({
      kind: 'album',
      artistId: artist.id,
      page: 1,
      hasMore: false,
      items: [wrongAlbum],
    });
    renderArtist(provider, artist);

    fireEvent.click(screen.getByRole('tab', { name: 'All songs' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('All songs unavailable');
    expect(screen.queryByText('Wrong category album')).not.toBeInTheDocument();
  });

  it('keeps initial errors local to a tab and retries that category', async () => {
    const provider = new FakeMusicProvider();
    const artist = await provider.getArtist('artist-mira-vale');
    const song = { ...artist.topSongs[0]!, id: 'retry-song', title: 'Recovered song' };
    const getArtistCatalog = vi
      .spyOn(provider, 'getArtistCatalog')
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({
        kind: 'song',
        artistId: artist.id,
        page: 1,
        hasMore: false,
        items: [song],
      });
    renderArtist(provider, artist);

    fireEvent.click(screen.getByRole('tab', { name: 'All songs' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The music catalog could not be loaded.',
    );
    expect(screen.getByRole('tab', { name: 'All albums' })).toHaveAttribute(
      'aria-selected',
      'false',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Recovered song')).toBeVisible();
    expect(getArtistCatalog).toHaveBeenCalledTimes(2);
  });

  it('ignores a song response after switching to the album tab', async () => {
    const provider = new FakeMusicProvider();
    const artist = await provider.getArtist('artist-mira-vale');
    const songs = deferred<ArtistCatalogPage>();
    const album = { ...artist.albums[0]!, id: 'latest-album', title: 'Latest album' };
    const staleSong = { ...artist.topSongs[0]!, id: 'stale-song', title: 'Stale song' };
    vi.spyOn(provider, 'getArtistCatalog').mockImplementation(
      (artistId, kind, _signal, page = 1) =>
        kind === 'song'
          ? songs.promise
          : Promise.resolve({ kind, artistId, page, hasMore: false, items: [album] }),
    );
    renderArtist(provider, artist);

    fireEvent.click(screen.getByRole('tab', { name: 'All songs' }));
    await waitFor(() => expect(provider.getArtistCatalog).toHaveBeenCalledTimes(1));
    const songSignal = vi.mocked(provider.getArtistCatalog).mock.calls[0]![2];
    fireEvent.click(screen.getByRole('tab', { name: 'All albums' }));
    expect(await screen.findByText('Latest album')).toBeVisible();
    expect(songSignal?.aborted).toBe(true);

    songs.resolve({
      kind: 'song',
      artistId: artist.id,
      page: 1,
      hasMore: false,
      items: [staleSong],
    });
    await Promise.resolve();
    expect(screen.queryByText('Stale song')).not.toBeInTheDocument();
  });

  it('re-enables pagination after an in-flight page is cancelled by a tab switch', async () => {
    const provider = new FakeMusicProvider();
    const artist = await provider.getArtist('artist-mira-vale');
    const nextPage = deferred<ArtistCatalogPage>();
    const first = { ...artist.topSongs[0]!, id: 'first-page-song', title: 'First page song' };
    vi.spyOn(provider, 'getArtistCatalog').mockImplementation(
      (artistId, kind, _signal, page = 1) => {
        if (kind === 'song' && page === 2) return nextPage.promise;
        return Promise.resolve(
          kind === 'song'
            ? { kind, artistId, page, hasMore: true, items: [first] }
            : { kind, artistId, page, hasMore: false, items: artist.albums },
        );
      },
    );
    renderArtist(provider, artist);

    fireEvent.click(screen.getByRole('tab', { name: 'All songs' }));
    await screen.findByText('First page song');
    fireEvent.click(screen.getByRole('button', { name: 'Load more all songs' }));
    await waitFor(() => expect(provider.getArtistCatalog).toHaveBeenCalledTimes(2));
    const pageSignal = vi.mocked(provider.getArtistCatalog).mock.calls[1]![2];

    fireEvent.click(screen.getByRole('tab', { name: 'All albums' }));
    await waitFor(() => expect(pageSignal?.aborted).toBe(true));
    fireEvent.click(screen.getByRole('tab', { name: 'All songs' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Load more all songs' })).toBeEnabled(),
    );
    expect(screen.getByText('First page song')).toBeVisible();
  });

  it('uses arrow, Home, and End keys as roving automatic tab activation', async () => {
    const provider = new FakeMusicProvider();
    const artist = await provider.getArtist('artist-mira-vale');
    renderArtist(provider, artist);

    const top = screen.getByRole('tab', { name: 'Top songs' });
    top.focus();
    fireEvent.keyDown(top, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'All songs' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'All songs' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'All songs' }), { key: 'End' });
    expect(screen.getByRole('tab', { name: 'All albums' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'All albums' }), { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Top songs' })).toHaveFocus();
  });

  it('uses album-first title navigation with a song fallback and no invalid link', async () => {
    const provider = new FakeMusicProvider();
    const artist = await provider.getArtist('artist-mira-vale');
    const onNavigate = vi.fn();
    const valid = { ...artist.topSongs[0]!, title: 'Album target' };
    const fallback = {
      ...artist.topSongs[0]!,
      id: 'fallback-song',
      title: 'Song fallback',
      album: { ...artist.topSongs[0]!.album, id: '' },
    };
    const invalid = {
      ...artist.topSongs[0]!,
      id: ' ',
      title: 'No target',
      album: { ...artist.topSongs[0]!.album, id: ' ' },
    };
    renderArtist(provider, { ...artist, topSongs: [valid, fallback, invalid] }, onNavigate);

    fireEvent.click(screen.getByRole('button', { name: 'Album target' }));
    expect(onNavigate).toHaveBeenLastCalledWith({ page: 'album', id: valid.album.id });
    fireEvent.click(screen.getByRole('button', { name: 'Song fallback' }));
    expect(onNavigate).toHaveBeenLastCalledWith({ page: 'song', id: 'fallback-song' });
    expect(screen.getByText('No target')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'No target' })).not.toBeInTheDocument();
  });

  it('keeps blank catalog album IDs as unique plain text instead of links', async () => {
    const provider = new FakeMusicProvider();
    const artist = await provider.getArtist('artist-mira-vale');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const albums = artist.albums.map((album, index) => ({
      ...album,
      id: index === 0 ? '' : '   ',
      title: `Blank Album ${index + 1}`,
    }));

    vi.spyOn(provider, 'getArtistCatalog').mockResolvedValue({
      kind: 'album',
      artistId: artist.id,
      page: 1,
      hasMore: false,
      items: albums,
    });
    renderArtist(provider, artist);
    fireEvent.click(screen.getByRole('tab', { name: 'All albums' }));

    const albumSection = await screen.findByRole('tabpanel', { name: 'All albums' });
    expect(within(albumSection).getAllByText(/Blank Album/)).toHaveLength(albums.length);
    expect(within(albumSection).queryAllByRole('button', { name: /Open / })).toHaveLength(0);
    expect(consoleError.mock.calls.some(([message]) => String(message).includes('same key'))).toBe(
      false,
    );
  });
});
