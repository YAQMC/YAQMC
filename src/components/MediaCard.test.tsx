import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NavigationProvider } from '../application/navigation-context';
import { allSongs, albums, playlists } from '../providers/fake/fixtures';
import '../styles/index.css';
import { MediaCard } from './MediaCard';

describe('MediaCard context actions', () => {
  it('provides open and play without exposing the browser menu', () => {
    const album = albums[0]!;
    const onOpen = vi.fn();
    const onPlay = vi.fn();
    const { container } = render(
      <MediaCard item={album} type="album" onOpen={onOpen} onPlay={onPlay} />,
    );

    fireEvent.contextMenu(container.querySelector('article')!, { clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByRole('menuitem', { name: `Play ${album.title}` }));
    expect(onPlay).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('routes a song title and each artist independently', () => {
    const song = {
      ...allSongs[0]!,
      id: 'song-card-links',
      artists: [
        { id: 'artist-first', name: 'First Artist' },
        { id: 'artist-second', name: 'Second Artist' },
      ],
    };
    const onNavigate = vi.fn();
    const onOpen = vi.fn();
    const onPlay = vi.fn();

    render(
      <NavigationProvider onNavigate={onNavigate}>
        <MediaCard item={song} type="song" onOpen={onOpen} onPlay={onPlay} />
      </NavigationProvider>,
    );

    screen.getByRole('button', { name: song.title }).click();
    screen.getByRole('button', { name: 'First Artist' }).click();
    screen.getByRole('button', { name: 'Second Artist' }).click();

    expect(onNavigate).toHaveBeenNthCalledWith(1, { page: 'song', id: song.id });
    expect(onNavigate).toHaveBeenNthCalledWith(2, { page: 'artist', id: 'artist-first' });
    expect(onNavigate).toHaveBeenNthCalledWith(3, { page: 'artist', id: 'artist-second' });
    expect(onOpen).not.toHaveBeenCalled();
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('routes an album title and artist while keeping the release year plain', () => {
    const album = albums[0]!;
    const onNavigate = vi.fn();
    const onOpen = vi.fn();
    const onPlay = vi.fn();

    render(
      <NavigationProvider onNavigate={onNavigate}>
        <MediaCard item={album} type="album" onOpen={onOpen} onPlay={onPlay} />
      </NavigationProvider>,
    );

    screen.getByRole('button', { name: album.title }).click();
    screen.getByRole('button', { name: album.artist.name }).click();

    expect(onNavigate).toHaveBeenNthCalledWith(1, { page: 'album', id: album.id });
    expect(onNavigate).toHaveBeenNthCalledWith(2, { page: 'artist', id: album.artist.id });
    expect(screen.getByText(String(album.releaseYear))).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('keeps blank song and artist IDs as plain text without nested controls', () => {
    const song = {
      ...allSongs[0]!,
      id: '',
      artists: [{ id: '', name: 'Unknown Artist' }],
    };

    const { container } = render(
      <NavigationProvider onNavigate={vi.fn()}>
        <MediaCard item={song} type="song" onOpen={vi.fn()} onPlay={vi.fn()} />
      </NavigationProvider>,
    );

    expect(screen.getByText(song.title)).toBeInTheDocument();
    expect(screen.getByText('Unknown Artist')).toBeInTheDocument();
    expect(container.querySelector('.entity-link')).toBeNull();
    expect(container.querySelector('button button, button a')).toBeNull();
  });

  it('keeps artwork, explicit play, and context open/play callbacks independent', () => {
    const song = allSongs[0]!;
    const onOpen = vi.fn();
    const onPlay = vi.fn();
    const { container } = render(
      <NavigationProvider onNavigate={vi.fn()}>
        <MediaCard item={song} type="song" onOpen={onOpen} onPlay={onPlay} />
      </NavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: `Open ${song.title}` }));
    fireEvent.click(screen.getByRole('button', { name: `Play ${song.title}` }));
    fireEvent.contextMenu(container.querySelector('article')!);
    fireEvent.click(screen.getByRole('menuitem', { name: `Open ${song.title}` }));
    fireEvent.contextMenu(container.querySelector('article')!);
    fireEvent.click(screen.getByRole('menuitem', { name: `Play ${song.title}` }));

    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onPlay).toHaveBeenCalledTimes(2);
  });

  it('preserves custom playlist title and subtitle metadata controls', () => {
    const playlist = playlists[0]!;
    const onOpen = vi.fn();

    render(
      <MediaCard
        item={playlist}
        type="playlist"
        title="Custom playlist"
        subtitle="Custom subtitle"
        onOpen={onOpen}
        onPlay={vi.fn()}
      />,
    );

    expect(screen.getByText('Custom playlist')).toBeInTheDocument();
    expect(screen.getByText('Custom subtitle')).toBeInTheDocument();
    screen.getByRole('button', { name: /Custom playlistCustom subtitle/ }).click();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('retains card title typography and artwork radius for entity controls', () => {
    const album = albums[0]!;

    render(
      <NavigationProvider onNavigate={vi.fn()}>
        <MediaCard item={album} type="album" onOpen={vi.fn()} onPlay={vi.fn()} />
      </NavigationProvider>,
    );

    const title = screen.getByRole('button', { name: album.title });
    const artwork = screen.getByRole('button', { name: `Open ${album.title}` });

    expect(getComputedStyle(title).fontWeight).toBe('630');
    expect(getComputedStyle(title).fontSize).toBe('var(--text-sm)');
    expect(getComputedStyle(title).color).toBe('var(--text)');
    expect(getComputedStyle(artwork).borderRadius).toBe('var(--radius-md)');
  });
});
