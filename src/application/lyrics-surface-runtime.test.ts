import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostBridge } from '@yaqmc/client';
import type { LyricDocument, Song } from '../domain/music';
import { defaultPreferences, usePreferencesStore } from './preferences';
import {
  estimatedSurfacePosition,
  matchingSurfaceDocument,
  projectSurfaceLyrics,
  setLyricsSurfaceInteraction,
  shouldReplaceSurfaceProjection,
  unlockAllLyricsSurfaces,
  useLyricsSurfaceRuntime,
  useProjectedLyrics,
  type LyricSurfaceProjection,
  type TimedProjection,
} from './lyrics-surface-runtime';

const invokeMock = vi.hoisted(() => vi.fn());
const eventMocks = vi.hoisted(() => ({
  unlisten: vi.fn(),
  handlers: new Map<string, (payload: unknown) => void>(),
}));

vi.mock('./yaqmc-runtime', async () => {
  const { YaqmcClient } = await import('@yaqmc/client');
  const bridge = {
    kind: 'electron' as const,
    windowRole: 'lyrics-desktop' as const,
    window: {
      minimize: async () => undefined,
      toggleMaximize: async () => undefined,
      close: async () => undefined,
      setFullscreen: async () => undefined,
    },
    shell: {
      openExternal: async () => undefined,
    },
    invoke: invokeMock,
    listen: (channel: string, handler: (payload: unknown) => void) => {
      eventMocks.handlers.set(channel, handler);
      return eventMocks.unlisten;
    },
  };
  const client = new YaqmcClient(bridge as HostBridge);
  client.markReady();
  return {
    getHostBridge: () => bridge,
    getYaqmcClient: () => client,
  };
});

const document: LyricDocument = {
  songId: 'song-one',
  syncMode: 'word',
  metadata: { sourceLabel: 'test', offsetMs: 0 },
  vocalists: [],
  lines: [
    {
      id: 'line-one',
      text: 'Soft light',
      startMs: 1_000,
      endMs: 2_000,
      words: [
        { text: 'Soft ', startMs: 1_000, endMs: 1_500 },
        { text: 'light', startMs: 1_500, endMs: 2_000 },
      ],
    },
    { id: 'line-two', text: 'Next line', startMs: 2_000, endMs: 3_000, words: [] },
  ],
};

function projection(overrides: Partial<LyricSurfaceProjection> = {}): TimedProjection {
  return {
    receivedAt: 1_000,
    value: {
      timestampMs: 1_000,
      currentTrack: { id: 'song-one' } as Song,
      positionMs: 1_100,
      isPlaying: true,
      playbackState: 'playing',
      playbackDurationMs: 1_300,
      syncMode: 'word',
      lineIndex: 0,
      wordIndex: 0,
      currentLine: document.lines[0] ?? null,
      nextLine: document.lines[1] ?? null,
      ...overrides,
    },
  };
}

describe('lyrics surface projection', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    eventMocks.unlisten.mockReset();
    usePreferencesStore.setState({
      ...defaultPreferences,
      surfaces: {
        desktop: { ...defaultPreferences.surfaces.desktop },
        island: { ...defaultPreferences.surfaces.island },
      },
      persistenceError: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('interpolates only while playing and clamps to duration', () => {
    expect(estimatedSurfacePosition(projection(), 1_150)).toBe(1_250);
    expect(estimatedSurfacePosition(projection(), 1_500)).toBe(1_300);
    expect(estimatedSurfacePosition(projection({ isPlaying: false }), 1_500)).toBe(1_100);
  });

  it('uses a Core unix timestamp so transit delay is not baked into the lyric clock', () => {
    const nowUnix = Date.now();
    const timed = {
      receivedAt: 10_000,
      value: {
        ...projection().value,
        timestampMs: nowUnix - 400,
        positionMs: 1_000,
        playbackDurationMs: 10_000,
      },
    };
    expect(estimatedSurfacePosition(timed, 10_000, nowUnix)).toBe(1_400);
  });

  it('rejects a stale lyric document after a track change', () => {
    expect(matchingSurfaceDocument(projection(), document)).toBe(document);
    expect(
      matchingSurfaceDocument(projection({ currentTrack: { id: 'song-two' } as Song }), document),
    ).toBeNull();
  });

  it('ignores word-only projection ticks so the surface clock can interpolate locally', () => {
    const previous = projection({ lineIndex: 0, wordIndex: 0, positionMs: 1_100 });
    expect(
      shouldReplaceSurfaceProjection(previous, {
        ...previous.value,
        wordIndex: 1,
        positionMs: 1_140,
      }),
    ).toBe(false);
    expect(
      shouldReplaceSurfaceProjection(previous, {
        ...previous.value,
        lineIndex: 1,
        positionMs: 2_000,
      }),
    ).toBe(true);
  });

  it('still applies a later lyrics fetch after a null document event', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'lyrics_surface_projection') {
        return Promise.resolve(projection().value);
      }
      if (command === 'player_lyrics') {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });
    const { result } = renderHook(() => useLyricsSurfaceRuntime());
    await waitFor(() => expect(eventMocks.handlers.has('lyrics://document')).toBe(true));
    act(() => {
      eventMocks.handlers.get('lyrics://document')?.(null);
    });
    act(() => {
      eventMocks.handlers.get('lyrics://projection')?.(projection().value);
      eventMocks.handlers.get('lyrics://document')?.(document);
    });
    await waitFor(() => expect(result.current.document?.songId).toBe('song-one'));
  });

  it('keeps next-track events when older startup snapshots resolve afterward', async () => {
    let resolveProjection: ((value: LyricSurfaceProjection) => void) | null = null;
    let resolveDocument: ((value: LyricDocument | null) => void) | null = null;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'lyrics_surface_projection') {
        return new Promise<LyricSurfaceProjection>((resolve) => {
          resolveProjection = resolve;
        });
      }
      if (command === 'player_lyrics') {
        return new Promise<LyricDocument | null>((resolve) => {
          resolveDocument = resolve;
        });
      }
      return Promise.resolve(null);
    });

    const { result } = renderHook(() => useLyricsSurfaceRuntime());
    await waitFor(() => {
      expect(eventMocks.handlers.has('lyrics://projection')).toBe(true);
      expect(eventMocks.handlers.has('lyrics://document')).toBe(true);
    });

    const nextDocument: LyricDocument = { ...document, songId: 'song-two' };
    act(() => {
      eventMocks.handlers.get('lyrics://projection')?.(
        projection({ currentTrack: { id: 'song-two' } as Song }).value,
      );
      eventMocks.handlers.get('lyrics://document')?.(nextDocument);
    });
    await waitFor(() => expect(result.current.document?.songId).toBe('song-two'));

    await act(async () => {
      resolveProjection?.(projection().value);
      resolveDocument?.(document);
      await Promise.resolve();
    });

    expect(result.current.projection?.value.currentTrack?.id).toBe('song-two');
    expect(result.current.document?.songId).toBe('song-two');
  });

  it('keeps a next-track lyric document that arrives before its projection', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'lyrics_surface_projection') {
        return Promise.resolve(projection().value);
      }
      if (command === 'player_lyrics') {
        return Promise.resolve(document);
      }
      return Promise.resolve(null);
    });
    const { result } = renderHook(() => useLyricsSurfaceRuntime());
    await waitFor(() => expect(eventMocks.handlers.has('lyrics://document')).toBe(true));
    await waitFor(() => expect(result.current.document?.songId).toBe('song-one'));

    const nextDocument: LyricDocument = { ...document, songId: 'song-two' };
    act(() => {
      eventMocks.handlers.get('lyrics://document')?.(nextDocument);
    });
    expect(result.current.document?.songId).toBe('song-one');

    act(() => {
      eventMocks.handlers.get('lyrics://projection')?.(
        projection({ currentTrack: { id: 'song-two' } as Song }).value,
      );
    });
    await waitFor(() => expect(result.current.document?.songId).toBe('song-two'));
  });

  it('applies presentation timing offset without mutating the document', () => {
    expect(projectSurfaceLyrics(document, 900, 0).current).toBeNull();
    expect(projectSurfaceLyrics(document, 900, 200).current?.id).toBe('line-one');
    expect(projectSurfaceLyrics(document, 1_600, 0).wordIndex).toBe(1);
    expect(document.metadata.offsetMs).toBe(0);
  });

  it('keeps the most recently completed line visible through gaps and track end', () => {
    const gapped: LyricDocument = {
      ...document,
      lines: [
        { ...document.lines[0]!, endMs: 2_000 },
        { ...document.lines[1]!, startMs: 3_000, endMs: 3_500 },
      ],
    };

    expect(projectSurfaceLyrics(gapped, 2_500, 0)).toMatchObject({
      current: { id: 'line-one' },
      next: { id: 'line-two' },
      wordIndex: 2,
    });
    expect(projectSurfaceLyrics(gapped, 4_000, 0)).toMatchObject({
      current: { id: 'line-two' },
      next: null,
      wordIndex: 0,
    });
    expect(projectSurfaceLyrics(gapped, 500, 0).current).toBeNull();
    expect(
      projectSurfaceLyrics({ ...gapped, syncMode: 'unsynchronized' }, 4_000, 0).current,
    ).toBeNull();
  });

  it('unlocks through one authoritative native-and-persistence command', async () => {
    usePreferencesStore.getState().setSurfaceInteractionLocal('desktop', 'passive-locked');
    invokeMock.mockImplementation(async (command: string, args: { value: string }) => {
      expect(command).toBe('lyrics_surface_set_interaction');
      const preferences = JSON.parse(args.value);
      expect(preferences.surfaces.desktop.interaction).toBe('interactive');
      return args.value;
    });

    await setLyricsSurfaceInteraction('desktop', 'interactive');

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(usePreferencesStore.getState().surfaces.desktop.interaction).toBe('interactive');
  });

  it('keeps a local lock when the persist snapshot still says interactive', async () => {
    invokeMock.mockImplementation(async (command: string, args: { value: string }) => {
      expect(command).toBe('lyrics_surface_set_interaction');
      const preferences = JSON.parse(args.value);
      expect(preferences.surfaces.desktop.interaction).toBe('passive-locked');
      return JSON.stringify({
        version: 2,
        surfaces: {
          desktop: { ...preferences.surfaces.desktop, interaction: 'interactive' },
          island: preferences.surfaces.island,
        },
      });
    });

    await setLyricsSurfaceInteraction('desktop', 'passive-locked');

    expect(usePreferencesStore.getState().surfaces.desktop.interaction).toBe('passive-locked');
  });

  it('rolls the visible state back when native unlocking fails', async () => {
    usePreferencesStore.getState().setSurfaceInteractionLocal('island', 'passive-locked');
    invokeMock.mockRejectedValue(new Error('native transition failed'));

    await expect(setLyricsSurfaceInteraction('island', 'interactive')).rejects.toThrow(
      'native transition failed',
    );

    expect(usePreferencesStore.getState().surfaces.island.interaction).toBe('passive-locked');
    expect(usePreferencesStore.getState().persistenceError).toContain('native transition failed');
  });

  it('advances overlay lyrics on lyric boundaries instead of a display-rate rAF loop', () => {
    vi.useFakeTimers();
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const timed = {
      receivedAt: 0,
      value: {
        ...projection({ positionMs: 1_100, timestampMs: 0, isPlaying: true, playbackDurationMs: 10_000 })
          .value,
      },
    };
    const { result } = renderHook(() => useProjectedLyrics(timed, document));

    expect(result.current.current?.id).toBe('line-one');
    expect(result.current.wordIndex).toBe(0);
    expect(raf).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(result.current.wordIndex).toBe(1);
    raf.mockRestore();
    vi.useRealTimers();
  });

  it('does not keep a cursor timer while paused or while the overlay is hidden', () => {
    vi.useFakeTimers();
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const paused = projection({ isPlaying: false, positionMs: 1_100 });
    const { unmount } = renderHook(() => useProjectedLyrics(paused, document));
    expect(raf).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    unmount();

    Object.defineProperty(globalThis.document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    renderHook(() => useProjectedLyrics(projection(), document));
    expect(raf).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    raf.mockRestore();
    vi.useRealTimers();
    Object.defineProperty(globalThis.document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
  });

  it('uses one native transaction for the all-surfaces recovery action', async () => {
    usePreferencesStore.getState().setSurfaceInteractionLocal('desktop', 'passive-locked');
    usePreferencesStore.getState().setSurfaceInteractionLocal('island', 'passive-locked');
    invokeMock.mockResolvedValue(2);

    await expect(unlockAllLyricsSurfaces()).resolves.toBe(2);

    expect(invokeMock).toHaveBeenCalledWith('lyrics_surfaces_unlock_all');
    expect(usePreferencesStore.getState().surfaces.desktop.interaction).toBe('interactive');
    expect(usePreferencesStore.getState().surfaces.island.interaction).toBe('interactive');
  });
});
