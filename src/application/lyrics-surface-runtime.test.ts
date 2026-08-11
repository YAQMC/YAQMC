import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TauriCore from '@tauri-apps/api/core';
import type { LyricDocument, Song } from '../domain/music';
import { defaultPreferences, usePreferencesStore } from './preferences';
import {
  estimatedSurfacePosition,
  matchingSurfaceDocument,
  projectSurfaceLyrics,
  setLyricsSurfaceInteraction,
  unlockAllLyricsSurfaces,
  type LyricSurfaceProjection,
  type TimedProjection,
} from './lyrics-surface-runtime';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof TauriCore>()),
  invoke: invokeMock,
}));

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
    usePreferencesStore.setState({
      ...defaultPreferences,
      surfaces: {
        desktop: { ...defaultPreferences.surfaces.desktop },
        island: { ...defaultPreferences.surfaces.island },
      },
      persistenceError: null,
    });
  });

  it('interpolates only while playing and clamps to duration', () => {
    expect(estimatedSurfacePosition(projection(), 1_150)).toBe(1_250);
    expect(estimatedSurfacePosition(projection(), 1_500)).toBe(1_300);
    expect(estimatedSurfacePosition(projection({ isPlaying: false }), 1_500)).toBe(1_100);
  });

  it('rejects a stale lyric document after a track change', () => {
    expect(matchingSurfaceDocument(projection(), document)).toBe(document);
    expect(
      matchingSurfaceDocument(projection({ currentTrack: { id: 'song-two' } as Song }), document),
    ).toBeNull();
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

  it('rolls the visible state back when native unlocking fails', async () => {
    usePreferencesStore.getState().setSurfaceInteractionLocal('island', 'passive-locked');
    invokeMock.mockRejectedValue(new Error('native transition failed'));

    await expect(setLyricsSurfaceInteraction('island', 'interactive')).rejects.toThrow(
      'native transition failed',
    );

    expect(usePreferencesStore.getState().surfaces.island.interaction).toBe('passive-locked');
    expect(usePreferencesStore.getState().persistenceError).toContain('native transition failed');
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
