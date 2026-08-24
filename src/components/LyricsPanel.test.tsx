import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    cleanup();
    vi.restoreAllMocks();
    resetLyricsStageForTests();
  });

  it('mounts the official AMLL lyric renderer for synchronized lyrics', () => {
    const { container } = render(<LyricsPanel {...props()} />);

    expect(container.querySelector('.lyrics-stage__amll')).toBeInTheDocument();
    expect(container.querySelector('.amll-lyric-player.dom')).toBeInTheDocument();
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
