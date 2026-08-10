import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { PlayerBar } from './PlayerBar';

describe('PlayerBar lyrics presentation entry', () => {
  beforeEach(() => usePlayerStore.setState(initialPlayerState));

  it('enables the Lyrics-specific fullscreen action only when a callback is available', () => {
    const onEnterLyricsFullscreen = vi.fn();
    const { rerender } = render(<PlayerBar onEnterLyricsFullscreen={onEnterLyricsFullscreen} />);

    const enabledEntry = screen.getByRole('button', { name: 'Enter fullscreen lyrics' });
    expect(enabledEntry).toBeEnabled();
    fireEvent.click(enabledEntry);
    expect(onEnterLyricsFullscreen).toHaveBeenCalledOnce();

    rerender(
      <PlayerBar onEnterLyricsFullscreen={onEnterLyricsFullscreen} lyricsFullscreenPending />,
    );
    expect(screen.getByRole('button', { name: 'Enter fullscreen lyrics' })).toBeDisabled();

    rerender(<PlayerBar />);
    expect(screen.getByRole('button', { name: 'Enter fullscreen lyrics' })).toBeDisabled();
  });

  it('delegates an open Lyrics panel to safe close without changing visibility directly', () => {
    usePlayerStore.setState({ lyricsOpen: true });
    const onCloseLyrics = vi.fn();
    render(<PlayerBar onCloseLyrics={onCloseLyrics} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show lyrics' }));

    expect(onCloseLyrics).toHaveBeenCalledOnce();
    expect(usePlayerStore.getState().lyricsOpen).toBe(true);
  });

  it('delegates Queue entry without changing panel state directly', () => {
    const onToggleQueue = vi.fn();
    render(<PlayerBar onToggleQueue={onToggleQueue} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show queue' }));

    expect(onToggleQueue).toHaveBeenCalledOnce();
    expect(usePlayerStore.getState()).toMatchObject({ queueOpen: false, lyricsOpen: false });
  });
});
