import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FakeMusicProvider } from '../providers/fake/fake-music-provider';
import { ArtistPage } from './ArtistPage';
import { NavigationProvider } from '../application/navigation-context';

describe('ArtistPage', () => {
  it('renders top songs and album previews without inventing album playback', async () => {
    const artist = await new FakeMusicProvider().getArtist('artist-mira-vale');
    const onNavigate = vi.fn();
    render(
      <NavigationProvider onNavigate={onNavigate}>
        <ArtistPage artist={artist} />
      </NavigationProvider>,
    );

    expect(screen.getByRole('heading', { name: artist.name })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Top songs' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Albums' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Open / })).toHaveLength(artist.albums.length);
    const albumSection = screen.getByRole('region', { name: 'Albums' });
    expect(within(albumSection).queryByRole('button', { name: /Play / })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /Open / })[0]!);
    expect(onNavigate).toHaveBeenCalledWith({ page: 'album', id: artist.albums[0]!.id });
  });

  it('omits an empty optional description', async () => {
    const artist = await new FakeMusicProvider().getArtist('artist-mira-vale');
    render(
      <NavigationProvider onNavigate={() => undefined}>
        <ArtistPage artist={{ ...artist, description: '   ' }} />
      </NavigationProvider>,
    );

    expect(screen.queryByText(/About Mira Vale/)).not.toBeInTheDocument();
  });

  it('keeps blank album IDs as unique plain text instead of links', async () => {
    const artist = await new FakeMusicProvider().getArtist('artist-mira-vale');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const albums = artist.albums.map((album, index) => ({
      ...album,
      id: index === 0 ? '' : '   ',
      title: `Blank Album ${index + 1}`,
    }));

    render(
      <NavigationProvider onNavigate={vi.fn()}>
        <ArtistPage artist={{ ...artist, albums }} />
      </NavigationProvider>,
    );

    const albumSection = screen.getByRole('region', { name: 'Albums' });
    expect(within(albumSection).getAllByText(/Blank Album/)).toHaveLength(albums.length);
    expect(within(albumSection).queryAllByRole('button', { name: /Open / })).toHaveLength(0);
    expect(consoleError.mock.calls.some(([message]) => String(message).includes('same key'))).toBe(
      false,
    );
  });
});
