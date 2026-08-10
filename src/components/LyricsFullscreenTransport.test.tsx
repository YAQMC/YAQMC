import { StrictMode, createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlayerCommandAdapter, type PlayerCommand } from '../application/player-command-adapter';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { allSongs } from '../providers/fake/fixtures';
import {
  LyricsFullscreenTransport,
  type LyricsFullscreenTransportHandle,
} from './LyricsFullscreenTransport';

function requiredSong() {
  const song = allSongs.find((candidate) => candidate.id === 'quiet-light');
  if (!song) throw new Error('quiet-light fixture is missing');
  return song;
}

const song = requiredSong();

function setPlaybackState(overrides: Partial<typeof initialPlayerState> = {}) {
  usePlayerStore.setState({
    ...initialPlayerState,
    queue: [song],
    currentIndex: 0,
    isPlaying: true,
    playbackState: 'playing',
    playbackDurationMs: null,
    positionMs: 63_000,
    ...overrides,
  });
}

function transport(): HTMLElement {
  return screen.getByRole('group', { name: 'Music player' });
}

describe('LyricsFullscreenTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setPlayerCommandAdapter(null);
    setPlaybackState();
  });

  afterEach(() => {
    cleanup();
    setPlayerCommandAdapter(null);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('dispatches localized previous, play-pause, and next controls through the player adapter', () => {
    const adapter = vi.fn<(command: PlayerCommand) => Promise<void>>().mockResolvedValue(undefined);
    setPlayerCommandAdapter(adapter);
    const { rerender } = render(<LyricsFullscreenTransport />);

    fireEvent.click(screen.getByRole('button', { name: 'Previous track' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next track' }));

    expect(adapter.mock.calls.map(([command]) => command)).toEqual([
      { type: 'previous' },
      { type: 'togglePlayback' },
      { type: 'next' },
    ]);

    act(() => usePlayerStore.setState({ isPlaying: false, playbackState: 'paused' }));
    rerender(<LyricsFullscreenTransport />);
    expect(screen.getByRole('button', { name: 'Play' })).toBeVisible();
  });

  it('hides after one full delay and reveal replaces it with exactly one full delay', () => {
    const ref = createRef<LyricsFullscreenTransportHandle>();
    render(<LyricsFullscreenTransport ref={ref} />);

    expect(transport()).toHaveAttribute('data-visible', 'true');
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(2_400));
    expect(transport()).not.toHaveAttribute('data-visible');
    expect(transport()).not.toHaveAttribute('aria-hidden');
    expect(vi.getTimerCount()).toBe(0);

    act(() => ref.current?.reveal());
    expect(transport()).toHaveAttribute('data-visible', 'true');
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(2_399));
    expect(transport()).toHaveAttribute('data-visible', 'true');
    act(() => vi.advanceTimersByTime(1));
    expect(transport()).not.toHaveAttribute('data-visible');
  });

  it('pins visibility across internal focus moves and starts a fresh delay after focus leaves', () => {
    render(<LyricsFullscreenTransport />);
    const previous = screen.getByRole('button', { name: 'Previous track' });
    const next = screen.getByRole('button', { name: 'Next track' });
    const outside = document.createElement('button');
    document.body.append(outside);

    fireEvent.focus(previous);
    expect(transport()).toHaveAttribute('data-visible', 'true');
    expect(vi.getTimerCount()).toBe(0);

    fireEvent.blur(previous, { relatedTarget: next });
    fireEvent.focus(next, { relatedTarget: previous });
    act(() => vi.advanceTimersByTime(4_800));
    expect(transport()).toHaveAttribute('data-visible', 'true');
    expect(vi.getTimerCount()).toBe(0);

    fireEvent.blur(next, { relatedTarget: outside });
    expect(transport()).toHaveAttribute('data-visible', 'true');
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(2_399));
    expect(transport()).toHaveAttribute('data-visible', 'true');
    act(() => vi.advanceTimersByTime(1));
    expect(transport()).not.toHaveAttribute('data-visible');
  });

  it('keeps paused playback visible and gives paused-to-playing a full grace period', () => {
    setPlaybackState({ isPlaying: false, playbackState: 'paused' });
    render(<LyricsFullscreenTransport />);

    expect(transport()).toHaveAttribute('data-visible', 'true');
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(4_800));
    expect(transport()).toHaveAttribute('data-visible', 'true');

    act(() => usePlayerStore.setState({ isPlaying: true, playbackState: 'playing' }));
    expect(transport()).toHaveAttribute('data-visible', 'true');
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(2_399));
    expect(transport()).toHaveAttribute('data-visible', 'true');
    act(() => vi.advanceTimersByTime(1));
    expect(transport()).not.toHaveAttribute('data-visible');
  });

  it('renders nothing and leaves no timer when there is no current song', () => {
    setPlaybackState({ queue: [], currentIndex: -1 });
    const { container } = render(<LyricsFullscreenTransport />);

    expect(container).toBeEmptyDOMElement();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses duration fallback, native position snapshots, and clamps progress to zero through one hundred', () => {
    const { container } = render(<LyricsFullscreenTransport />);
    const progress = () =>
      container.querySelector<HTMLElement>('.lyrics-fullscreen-transport__progress-fill');

    expect(progress()).toHaveStyle({ width: '25%' });

    act(() => usePlayerStore.setState({ playbackDurationMs: 100_000 }));
    expect(progress()).toHaveStyle({ width: '63%' });

    act(() => usePlayerStore.setState({ positionMs: 125_000 }));
    expect(progress()).toHaveStyle({ width: '100%' });

    act(() => usePlayerStore.setState({ positionMs: -1 }));
    expect(progress()).toHaveStyle({ width: '0%' });

    act(() => usePlayerStore.setState({ playbackDurationMs: 0, positionMs: 50_000 }));
    expect(progress()).toHaveStyle({ width: '0%' });

    act(() => usePlayerStore.setState({ playbackDurationMs: null, positionMs: 126_000 }));
    expect(progress()).toHaveStyle({ width: '50%' });
  });

  it('keeps one timer across repeated reveal calls and clears it on unmount', () => {
    const ref = createRef<LyricsFullscreenTransportHandle>();
    const { unmount } = render(<LyricsFullscreenTransport ref={ref} />);

    act(() => {
      ref.current?.reveal();
      ref.current?.reveal();
      ref.current?.reveal();
    });
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains exactly one timer in StrictMode and clears it on teardown', () => {
    const { unmount } = render(
      <StrictMode>
        <LyricsFullscreenTransport />
      </StrictMode>,
    );

    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
