import { StrictMode, createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlayerCommandAdapter, type PlayerCommand } from '../application/player-command-adapter';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import {
  builtinTransportDefinition,
  defaultLyricsTransportState,
  setPluginTransportCatalog,
} from '../application/lyrics-transport';
import { usePreferencesStore } from '../application/preferences';
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
const safeArtwork = 'data:image/png;base64,AA==';

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
  it('cancels a host scrub without seeking when control permission is revoked mid-drag', () => {
    const adapter = vi.fn<(command: PlayerCommand) => Promise<void>>().mockResolvedValue(undefined);
    setPlayerCommandAdapter(adapter);
    const definition = { ...builtinTransportDefinition('fullscreen'), id: 'plugin.test.transport' };
    const grant = (grantedPermissions: string[]) =>
      setPluginTransportCatalog([{ pluginId: 'test', definition, grantedPermissions }]);
    grant(['player.read', 'player.control']);
    usePreferencesStore.setState({
      transport: { ...defaultLyricsTransportState, fullscreen: definition.id },
    });
    render(<LyricsFullscreenTransport artworkSource={null} />);
    const slider = screen.getByRole('slider');
    fireEvent.pointerDown(slider);
    fireEvent.input(slider, { target: { value: '100000' } });
    expect(usePlayerStore.getState().isScrubbing).toBe(true);
    act(() => grant(['player.read']));
    expect(slider).toBeDisabled();
    fireEvent.pointerUp(slider);
    expect(usePlayerStore.getState().isScrubbing).toBe(false);
    expect(adapter).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    setPlayerCommandAdapter(null);
    setPlaybackState();
    setPluginTransportCatalog([]);
    usePreferencesStore.setState({ transport: { ...defaultLyricsTransportState } });
  });

  afterEach(() => {
    cleanup();
    setPluginTransportCatalog([]);
    usePreferencesStore.setState({ transport: { ...defaultLyricsTransportState } });
    setPlayerCommandAdapter(null);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('dispatches localized previous, play-pause, and next controls through the player adapter', () => {
    const adapter = vi.fn<(command: PlayerCommand) => Promise<void>>().mockResolvedValue(undefined);
    setPlayerCommandAdapter(adapter);
    const { rerender } = render(<LyricsFullscreenTransport artworkSource={safeArtwork} />);

    fireEvent.click(screen.getByRole('button', { name: 'Previous track' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next track' }));

    expect(adapter.mock.calls.map(([command]) => command)).toEqual([
      { type: 'previous' },
      { type: 'togglePlayback' },
      { type: 'next' },
    ]);

    act(() => usePlayerStore.setState({ isPlaying: false, playbackState: 'paused' }));
    rerender(<LyricsFullscreenTransport artworkSource={safeArtwork} />);
    expect(screen.getByRole('button', { name: 'Play' })).toBeVisible();
  });

  it('hides after one full delay and reveal replaces it with exactly one full delay', () => {
    const ref = createRef<LyricsFullscreenTransportHandle>();
    render(<LyricsFullscreenTransport ref={ref} artworkSource={safeArtwork} />);

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
    render(<LyricsFullscreenTransport artworkSource={safeArtwork} />);
    const previous = screen.getByRole('button', { name: 'Previous track' });
    const next = screen.getByRole('button', { name: 'Next track' });
    const outside = document.createElement('button');
    document.body.append(outside);

    fireEvent.focus(previous);
    expect(transport()).toHaveAttribute('data-visible', 'true');
    expect(vi.getTimerCount()).toBe(0);

    fireEvent.blur(previous, { relatedTarget: next });
    expect(vi.getTimerCount()).toBe(0);
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
    outside.remove();
  });

  it('keeps paused playback visible and gives paused-to-playing a full grace period', () => {
    setPlaybackState({ isPlaying: false, playbackState: 'paused' });
    render(<LyricsFullscreenTransport artworkSource={safeArtwork} />);

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
    const { container } = render(<LyricsFullscreenTransport artworkSource={safeArtwork} />);

    expect(container).toBeEmptyDOMElement();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clamps the range against duration fallbacks and non-finite snapshots', () => {
    setPlaybackState({ observedAtMs: Number.MAX_SAFE_INTEGER });
    const { container } = render(<LyricsFullscreenTransport artworkSource={safeArtwork} />);
    const range = () =>
      container.querySelector<HTMLInputElement>('.lyrics-transport__progress input[type="range"]');
    const percent = () => range()?.style.getPropertyValue('--range-progress');

    expect(range()?.value).toBe('63000');
    expect(percent()).toBe('25%');

    act(() => usePlayerStore.setState({ playbackDurationMs: 100_000 }));
    expect(range()?.value).toBe('63000');
    expect(percent()).toBe('63%');

    act(() => usePlayerStore.setState({ positionMs: 125_000 }));
    expect(range()?.value).toBe('100000');
    expect(percent()).toBe('100%');

    act(() => usePlayerStore.setState({ positionMs: -1 }));
    expect(range()?.value).toBe('0');
    expect(percent()).toBe('0%');

    act(() => usePlayerStore.setState({ playbackDurationMs: 0, positionMs: 50_000 }));
    expect(percent()).toBe('0%');

    act(() => usePlayerStore.setState({ playbackDurationMs: null, positionMs: 126_000 }));
    expect(percent()).toBe('50%');

    act(() => usePlayerStore.setState({ positionMs: Number.NaN }));
    expect(percent()).toBe('0%');

    // The live estimate is clamped by the store, so an infinite snapshot can
    // never overflow the bar; a paused NaN snapshot must not leak into CSS.
    act(() => usePlayerStore.setState({ positionMs: Number.POSITIVE_INFINITY }));
    expect(percent()).toBe('100%');

    act(() => usePlayerStore.setState({ positionMs: Number.NEGATIVE_INFINITY }));
    expect(percent()).toBe('0%');

    act(() => usePlayerStore.setState({ isPlaying: false, positionMs: Number.NaN }));
    expect(percent()).toBe('0%');
    expect(range()?.style.getPropertyValue('--range-progress')).not.toContain('NaN');
  });

  it('keeps the window preset rendered as a compact bar that never auto-hides', () => {
    const { container } = render(
      <LyricsFullscreenTransport artworkSource={safeArtwork} surface="window" />,
    );
    const bar = container.querySelector<HTMLElement>('.lyrics-transport');

    expect(bar).toHaveAttribute('data-transport-preset', 'builtin.transport.window');
    expect(bar).toHaveAttribute('data-layout', 'compact');
    expect(bar?.querySelector('.lyrics-transport__artwork')).toBeNull();
    expect(bar?.querySelector('.lyrics-transport__track')).toBeNull();
    expect(screen.getByRole('button', { name: 'Previous track' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Next track' })).toBeVisible();
    expect(screen.getByRole('slider', { name: 'Playback position' })).toBeVisible();

    act(() => vi.advanceTimersByTime(30_000));
    expect(transport()).toHaveAttribute('data-visible', 'true');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renders a granted plugin declaration with its own order, tokens, icons and metrics', () => {
    setPluginTransportCatalog([
      {
        pluginId: 'example.transport',
        definition: {
          schemaVersion: 1,
          id: 'plugin.example.transport',
          surface: 'fullscreen',
          layout: 'bar',
          actions: ['track', 'next', 'playPause', 'previous', 'artwork', 'progress'],
          icons: { previous: 'chevrons-back', next: 'chevrons-forward' },
          tokens: { surface: '#101110', text: '#f1f3ec', muted: '#a7aba2', accent: '#a8c95e' },
          metrics: { artworkSize: 40, controlSize: 48, gap: 6, radius: 12 },
        },
        grantedPermissions: ['player.read', 'player.control'],
      },
    ]);
    usePreferencesStore.setState({
      transport: {
        schemaVersion: 1,
        window: 'builtin.transport.window',
        fullscreen: 'plugin.example.transport',
      },
    });
    const { container } = render(<LyricsFullscreenTransport artworkSource={safeArtwork} />);
    const bar = container.querySelector<HTMLElement>('.lyrics-transport');

    expect(bar).toHaveAttribute('data-transport-preset', 'plugin.example.transport');
    expect(bar).toHaveAttribute('data-layout', 'bar');
    expect(bar?.style.getPropertyValue('--transport-accent')).toBe('#A8C95E');
    expect(bar?.style.getPropertyValue('--transport-control-size')).toBe('48px');
    expect(bar?.style.getPropertyValue('--transport-artwork-size')).toBe('40px');
    expect(bar?.querySelector('.lyrics-transport__track')).not.toBeNull();
    expect(bar?.querySelector('.lyrics-transport__artwork img')).toHaveAttribute(
      'src',
      safeArtwork,
    );
    expect(bar?.querySelector('.lyrics-transport__progress')).not.toBeNull();
    expect(container.innerHTML).not.toContain(song.artwork.src);

    const labels = [...(bar?.querySelectorAll('.lyrics-transport__controls button') ?? [])].map(
      (node) => node.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Next track', 'Pause', 'Previous track']);
    expect(bar?.querySelector('.lyrics-transport__controls .lucide-chevrons-right')).not.toBeNull();
    expect(bar?.querySelector('.lyrics-transport__controls .lucide-skip-forward')).toBeNull();
  });

  it('drops read actions from a control-only grant and keeps the controls usable', () => {
    setPluginTransportCatalog([
      {
        pluginId: 'example.transport',
        definition: {
          schemaVersion: 1,
          id: 'plugin.example.transport',
          surface: 'fullscreen',
          layout: 'bar',
          actions: ['artwork', 'track', 'previous', 'playPause', 'next', 'progress', 'time'],
          icons: {},
          tokens: { surface: '#101110', text: '#F1F3EC', muted: '#A7ABA2', accent: '#A8C95E' },
          metrics: { artworkSize: 40, controlSize: 44, gap: 8, radius: 12 },
        },
        grantedPermissions: ['player.control'],
      },
    ]);
    usePreferencesStore.setState({
      transport: {
        schemaVersion: 1,
        window: 'builtin.transport.window',
        fullscreen: 'plugin.example.transport',
      },
    });
    const { container } = render(<LyricsFullscreenTransport artworkSource={safeArtwork} />);
    const bar = container.querySelector<HTMLElement>('.lyrics-transport');

    expect(bar).toHaveAttribute('data-transport-preset', 'plugin.example.transport');
    expect(bar?.querySelector('.lyrics-transport__artwork')).toBeNull();
    expect(bar?.querySelector('.lyrics-transport__track')).toBeNull();
    expect(bar?.querySelector('.lyrics-transport__progress')).toBeNull();
    expect(container.innerHTML).not.toContain(song.artwork.src);
    expect(screen.getByRole('button', { name: 'Previous track' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Next track' })).toBeVisible();
  });

  it('falls back to the built-in preset when the selected declaration has no usable action left', () => {
    setPluginTransportCatalog([
      {
        pluginId: 'example.transport',
        definition: {
          schemaVersion: 1,
          id: 'plugin.example.transport',
          surface: 'fullscreen',
          layout: 'bar',
          actions: ['track', 'progress'],
          icons: {},
          tokens: { surface: '#101110', text: '#F1F3EC', muted: '#A7ABA2', accent: '#A8C95E' },
          metrics: { artworkSize: 0, controlSize: 44, gap: 8, radius: 12 },
        },
        grantedPermissions: [],
      },
    ]);
    usePreferencesStore.setState({
      transport: {
        schemaVersion: 1,
        window: 'builtin.transport.window',
        fullscreen: 'plugin.example.transport',
      },
    });
    const { container } = render(<LyricsFullscreenTransport artworkSource={safeArtwork} />);

    expect(container.querySelector('.lyrics-transport')).toHaveAttribute(
      'data-transport-preset',
      'builtin.transport.fullscreen',
    );
  });

  it('ignores invalid declarations and unknown preset ids instead of rendering them', () => {
    setPluginTransportCatalog([
      {
        pluginId: 'example.transport',
        // Unknown action id: the whole declaration must be rejected.
        definition: {
          schemaVersion: 1,
          id: 'plugin.example.transport',
          surface: 'fullscreen',
          layout: 'bar',
          actions: ['playPause', 'teleport'],
          tokens: { surface: '#101110', text: '#F1F3EC', muted: '#A7ABA2', accent: '#A8C95E' },
          metrics: { artworkSize: 0, controlSize: 44, gap: 8, radius: 12 },
        } as never,
        grantedPermissions: ['player.control'],
      },
    ]);
    usePreferencesStore.setState({
      transport: {
        schemaVersion: 1,
        window: 'builtin.transport.window',
        fullscreen: 'plugin.example.transport',
      },
    });
    const { container } = render(<LyricsFullscreenTransport artworkSource={safeArtwork} />);

    expect(container.querySelector('.lyrics-transport')).toHaveAttribute(
      'data-transport-preset',
      'builtin.transport.fullscreen',
    );
  });

  it('keeps one timer across repeated reveal calls and clears it on unmount', () => {
    const ref = createRef<LyricsFullscreenTransportHandle>();
    const { unmount } = render(<LyricsFullscreenTransport ref={ref} artworkSource={safeArtwork} />);

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
        <LyricsFullscreenTransport artworkSource={safeArtwork} />
      </StrictMode>,
    );

    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renders only the caller-provided safe artwork source and supports an empty placeholder', () => {
    const definition = {
      ...builtinTransportDefinition('fullscreen'),
      id: 'plugin.artwork.transport',
      actions: ['artwork', 'track', 'playPause'] as const,
    };
    setPluginTransportCatalog([
      {
        pluginId: 'artwork',
        definition: { ...definition, actions: [...definition.actions] },
        grantedPermissions: ['player.read', 'player.control'],
      },
    ]);
    usePreferencesStore.setState({
      transport: { ...defaultLyricsTransportState, fullscreen: definition.id },
    });
    const { container, rerender } = render(
      <LyricsFullscreenTransport artworkSource={safeArtwork} />,
    );
    expect(container.querySelector('img')).toHaveAttribute('src', safeArtwork);
    expect(container.innerHTML).not.toContain(song.artwork.src);

    rerender(<LyricsFullscreenTransport artworkSource={null} />);
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(song.artwork.src);
  });

  it.each(['window', 'fullscreen'] as const)(
    'never repeats the artwork or track identity in a built-in %s bar',
    (surface) => {
      const { container } = render(
        <LyricsFullscreenTransport artworkSource={safeArtwork} surface={surface} />,
      );
      expect(container.querySelector('.lyrics-transport__artwork')).toBeNull();
      expect(container.querySelector('.lyrics-transport__track')).toBeNull();
      expect(screen.getByRole('button', { name: 'Pause' })).toBeVisible();
    },
  );
});
