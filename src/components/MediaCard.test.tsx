import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { albums } from '../providers/fake/fixtures';
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
});
