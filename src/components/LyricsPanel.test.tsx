import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLyricsStore } from '../application/lyrics-store';
import { setPlayerCommandAdapter } from '../application/player-command-adapter';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { allSongs, lyricsBySong } from '../providers/fake/fixtures';
import { LyricsPanel } from './LyricsPanel';

function presentationProps(overrides: Partial<React.ComponentProps<typeof LyricsPanel>> = {}) {
  return {
    focus: false,
    fullscreen: false,
    fullscreenPending: false,
    fullscreenError: null,
    onToggleFocus: vi.fn(),
    onToggleFullscreen: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

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

  it.each([false, true])(
    'seeks through the shared player contract when a timed line is clicked with focus=%s',
    (focus) => {
      render(<LyricsPanel {...presentationProps({ focus })} />);

      fireEvent.click(screen.getByRole('button', { name: /A quiet light across the floor/i }));

      expect(usePlayerStore.getState().positionMs).toBe(18_000);
    },
  );

  it('renders word timing as text rather than preformatted provider HTML', () => {
    render(<LyricsPanel {...presentationProps()} />);

    const line = screen.getByRole('button', {
      name: 'The room keeps the shape of the evening',
    });
    expect(line.querySelectorAll('.lyrics-word')).toHaveLength(8);
    expect(screen.getByText('Word synced')).toBeVisible();
  });

  it('delegates focus and fullscreen controls and updates their accessible labels', () => {
    const props = presentationProps();
    const { rerender } = render(<LyricsPanel {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Hide navigation' }));
    expect(props.onToggleFocus).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Enter fullscreen lyrics' }));
    expect(props.onToggleFullscreen).toHaveBeenCalledOnce();

    rerender(<LyricsPanel {...props} focus fullscreen />);
    expect(screen.getByRole('button', { name: 'Show navigation' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Exit fullscreen lyrics' })).toBeVisible();
  });

  it('delegates the close button only and leaves visibility to the application callback', () => {
    const props = presentationProps();
    render(<LyricsPanel {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close lyrics' }));

    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onToggleFocus).not.toHaveBeenCalled();
    expect(props.onToggleFullscreen).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().lyricsOpen).toBe(true);
  });

  it('exposes semantic presentation state and disables fullscreen while pending', () => {
    render(
      <LyricsPanel
        {...presentationProps({ focus: true, fullscreen: true, fullscreenPending: true })}
      />,
    );

    const stage = screen.getByRole('region', { name: 'Synchronized lyrics' });
    expect(stage).toHaveAttribute('data-focus');
    expect(stage).toHaveAttribute('data-fullscreen');
    expect(screen.getByRole('button', { name: 'Exit fullscreen lyrics' })).toBeDisabled();
  });

  it('renders only a localized fullscreen failure status without exposing the native error', () => {
    const nativeError = 'native fullscreen denial: secret compositor detail';
    render(<LyricsPanel {...presentationProps({ fullscreenError: nativeError })} />);

    expect(screen.getByRole('status')).toHaveTextContent('Fullscreen could not be changed.');
    expect(screen.queryByText(nativeError)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(nativeError)).not.toBeInTheDocument();
    expect(screen.queryByTitle(nativeError)).not.toBeInTheDocument();
  });

  it('recenters on presentation changes only while lyric following remains active', async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });
    usePlayerStore.setState({ positionMs: 5_000 });
    const props = presentationProps();
    const { container, rerender } = render(<LyricsPanel {...props} />);

    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    scrollTo.mockClear();
    rerender(<LyricsPanel {...props} focus />);
    await waitFor(() => expect(scrollTo).toHaveBeenCalledOnce());

    const scrollArea = container.querySelector('.lyrics-stage__scroll');
    if (!scrollArea) throw new Error('lyrics scroll area is missing');
    fireEvent.wheel(scrollArea);
    scrollTo.mockClear();
    rerender(<LyricsPanel {...props} focus fullscreen />);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
