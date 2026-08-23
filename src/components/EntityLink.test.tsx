import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EntityLink } from './EntityLink';
import { NavigationProvider } from '../application/navigation-context';

describe('EntityLink', () => {
  it('navigates valid IDs with a keyboard-accessible button and stops row propagation', () => {
    const onNavigate = vi.fn();
    const onRowClick = vi.fn();
    render(
      <NavigationProvider onNavigate={onNavigate}>
        <div onClick={onRowClick}>
          <EntityLink entity="song" id="song-1">
            Quiet Light
          </EntityLink>
        </div>
      </NavigationProvider>,
    );

    const link = screen.getByRole('button', { name: 'Quiet Light' });
    expect(link).toHaveAttribute('type', 'button');
    fireEvent.click(link);

    expect(onNavigate).toHaveBeenCalledWith({ page: 'song', id: 'song-1' });
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('keeps an empty or whitespace ID as plain text', () => {
    render(
      <NavigationProvider onNavigate={vi.fn()}>
        <EntityLink entity="artist" id="   ">
          Unknown artist
        </EntityLink>
      </NavigationProvider>,
    );

    expect(screen.queryByRole('button', { name: 'Unknown artist' })).not.toBeInTheDocument();
    expect(screen.getByText('Unknown artist').tagName).toBe('SPAN');
  });

  it.each([
    ['song', 'song-1'],
    ['artist', 'artist-1'],
    ['album', 'album-1'],
  ] as const)('routes a trimmed %s ID', (entity, id) => {
    const onNavigate = vi.fn();
    render(
      <NavigationProvider onNavigate={onNavigate}>
        <EntityLink entity={entity} id={`  ${id}  `}>
          Open
        </EntityLink>
      </NavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(onNavigate).toHaveBeenCalledWith({ page: entity, id });
  });

  it('does not render an inert interactive control without navigation context', () => {
    render(
      <EntityLink entity="album" id="album-1">
        Album
      </EntityLink>,
    );

    expect(screen.queryByRole('button', { name: 'Album' })).not.toBeInTheDocument();
    expect(screen.getByText('Album').tagName).toBe('SPAN');
  });
});
