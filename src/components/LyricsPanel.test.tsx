import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultPreferences, usePreferencesStore } from '../application/preferences';
import { initialPlayerState, usePlayerStore } from '../application/player-store';
import { resetLyricsStageForTests } from '../application/lyrics-stage-machine';
import { useLyricsStore } from '../application/lyrics-store';
import type { LyricDocument } from '../domain/music';
import { allSongs, lyricsBySong } from '../providers/fake/fixtures';
import '../styles/components.css';
import '../styles/lyrics-scene.css';
import '../styles/platform.css';
import { LyricsPanel } from './LyricsPanel';

const layout = vi.hoisted(() => ({ compact: false }));
vi.mock('../application/use-compact-player-layout', () => ({
  useCompactPlayerLayout: () => layout.compact,
}));

vi.mock('../application/yaqmc-runtime', () => ({
  getHostBridge: () => ({ kind: 'electron' }),
  getYaqmcClient: () => ({
    invoke: vi.fn().mockResolvedValue('data:image/png;base64,AA=='),
    on: () => () => undefined,
    bridge: { kind: 'electron' },
    host: {
      window: {
        minimize: async () => undefined,
        toggleMaximize: async () => undefined,
        close: async () => undefined,
      },
      shell: { openExternal: async () => undefined },
    },
  }),
}));

function props(overrides: Partial<React.ComponentProps<typeof LyricsPanel>> = {}) {
  return { focus: false, fullscreen: false, fullscreenError: null, onClose: vi.fn(), ...overrides };
}

function unsynchronizedDocument(): LyricDocument {
  return {
    songId: 'quiet-light',
    syncMode: 'unsynchronized',
    metadata: { sourceLabel: 'test', offsetMs: 0 },
    vocalists: [],
    lines: [{ id: 'one', text: 'Plain lyric', startMs: 1_000, endMs: null, words: [] }],
  };
}

describe('LyricsPanel', () => {
  beforeEach(() => {
    layout.compact = false;
    resetLyricsStageForTests();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const song = allSongs.find((candidate) => candidate.id === 'quiet-light');
    if (!song) throw new Error('quiet-light fixture is missing');
    usePlayerStore.setState({
      ...initialPlayerState,
      queue: [song],
      currentIndex: 0,
      lyricsOpen: true,
      isPlaying: false,
      positionMs: 4_500,
    });
    useLyricsStore.setState({
      songId: song.id,
      status: 'ready',
      document: lyricsBySong[song.id] ?? null,
      error: null,
    });
    usePreferencesStore.setState({
      ...defaultPreferences,
      appearance: { ...defaultPreferences.appearance },
      lyrics: { ...defaultPreferences.lyrics },
      lyricsPresets: defaultPreferences.lyricsPresets,
      backgroundImageData: null,
      backgroundImageMissing: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
    resetLyricsStageForTests();
  });

  it('mounts the official AMLL lyric renderer for synchronized lyrics', () => {
    const { container } = render(<LyricsPanel {...props()} />);

    expect(container.querySelector('.lyrics-stage__amll')).toBeInTheDocument();
    expect(container.querySelector('.amll-lyric-player.dom')).toBeInTheDocument();
  });

  it('reveals auto-hidden lyrics controls when a touch pointer presses the stage', () => {
    vi.useFakeTimers();
    useLyricsStore.setState({ document: unsynchronizedDocument(), status: 'ready' });
    const { container } = render(<LyricsPanel {...props()} />);
    const stage = screen.getByRole('region', { name: 'Synchronized lyrics' });
    const chrome = container.querySelector('.lyrics-stage__chrome');

    act(() => vi.advanceTimersByTime(2_400));
    expect(chrome).toHaveAttribute('data-hidden');

    fireEvent.pointerDown(stage, { pointerType: 'touch', clientY: 200 });
    expect(chrome).not.toHaveAttribute('data-hidden');

    act(() => vi.advanceTimersByTime(2_400));
    expect(chrome).toHaveAttribute('data-hidden');
    vi.useRealTimers();
  });

  it('keeps compact controls usable without a pointer move and reuses flow widgets', () => {
    layout.compact = true;
    vi.useFakeTimers();
    useLyricsStore.setState({ document: unsynchronizedDocument(), status: 'ready' });
    const { container, rerender } = render(<LyricsPanel {...props()} />);
    act(() => vi.advanceTimersByTime(10_000));
    expect(container.querySelector('.lyrics-scene__transport')).not.toHaveAttribute('data-hidden');
    expect(container.querySelector('.lyrics-stage__chrome')).not.toHaveAttribute('data-hidden');
    const songId = container.querySelector('.lyrics-stage')?.getAttribute('data-song-id');
    for (const widget of container.querySelectorAll<HTMLElement>('.lyrics-scene__widget')) {
      expect(widget.style.position).not.toBe('absolute');
    }
    rerender(<LyricsPanel {...props({ fullscreen: true })} />);
    expect(container.querySelector('.lyrics-scene__transport')).not.toHaveAttribute('data-hidden');
    expect(container.querySelector('.lyrics-stage__chrome')).not.toHaveAttribute('data-hidden');
    expect(container.querySelector('.lyrics-stage')).toHaveAttribute('data-song-id', songId);
  });

  it('passes the selected lyrics font weight into the scene CSS variables', () => {
    usePreferencesStore.setState({
      lyrics: { ...defaultPreferences.lyrics, fontWeight: '600' },
    });
    const { container } = render(<LyricsPanel {...props()} />);
    const scene = container.querySelector<HTMLElement>('.lyrics-scene');

    expect(scene).not.toBeNull();
    expect(scene?.style.getPropertyValue('--lyrics-font-weight')).toBe('600');
  });

  it('marks the AMLL renderer when word jump is disabled', () => {
    usePreferencesStore.setState({
      lyrics: { ...defaultPreferences.lyrics, wordEffect: 'fill' },
    });
    const { container } = render(<LyricsPanel {...props()} />);

    expect(container.querySelector('.lyrics-stage__amll')).toHaveAttribute(
      'data-word-jump',
      'false',
    );
  });

  it('keeps an accessible static fallback for unsynchronized lyrics', () => {
    useLyricsStore.setState({ document: unsynchronizedDocument(), status: 'ready' });
    render(<LyricsPanel {...props()} />);

    const line = screen.getByRole('button', { name: 'Plain lyric' });
    fireEvent.click(line);
    expect(usePlayerStore.getState().positionMs).toBe(1_000);
  });

  it('preserves a localized missing-lyrics state without creating the renderer', () => {
    useLyricsStore.setState({ document: null, status: 'missing' });
    const { container } = render(<LyricsPanel {...props()} />);

    expect(screen.getByText(/no lyrics found|暂无歌词|歌词不可用/i)).toBeInTheDocument();
    expect(container.querySelector('.amll-lyric-player')).toBeNull();
  });
});
