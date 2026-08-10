import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLyricsStore } from '../application/lyrics-store';
import { setPlayerCommandAdapter } from '../application/player-command-adapter';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { allSongs, lyricsBySong } from '../providers/fake/fixtures';
import { LyricsPanel } from './LyricsPanel';

describe('LyricsPanel', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    setPlayerCommandAdapter(null);
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );

    const song = allSongs.find((candidate) => candidate.id === 'quiet-light');
    if (!song) throw new Error('quiet-light fixture is missing');
    usePlayerStore.setState({
      ...initialPlayerState,
      queue: [song],
      currentIndex: 0,
      lyricsOpen: true,
    });
    useLyricsStore.setState({
      songId: song.id,
      status: 'ready',
      document: lyricsBySong[song.id] ?? null,
      error: null,
    });
  });

  it('seeks through the shared player contract when a timed line is clicked', () => {
    render(<LyricsPanel />);

    fireEvent.click(screen.getByRole('button', { name: /A quiet light across the floor/i }));

    expect(usePlayerStore.getState().positionMs).toBe(18_000);
  });

  it('renders word timing as text rather than preformatted provider HTML', () => {
    render(<LyricsPanel />);

    const line = screen.getByRole('button', {
      name: 'The room keeps the shape of the evening',
    });
    expect(line.querySelectorAll('.lyrics-word')).toHaveLength(8);
    expect(screen.getByText('Word synced')).toBeVisible();
  });
});
