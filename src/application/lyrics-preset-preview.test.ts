import { afterEach, describe, expect, it } from 'vitest';
import {
  PREVIEW_FIXTURE_SONG_ID,
  previewFixtureLyrics,
  previewFixtureSong,
} from './lyrics-preset-preview-fixture';
import { useLyricsPresetPreviewStore } from './lyrics-preset-preview';
import { initialPlayerState, usePlayerStore } from './player-store';

describe('lyrics preset preview fixture', () => {
  afterEach(() => {
    useLyricsPresetPreviewStore.getState().reset();
    usePlayerStore.setState(initialPlayerState);
  });

  it('is a local G.E.M. design fixture with timed lyrics and no network source', () => {
    expect(previewFixtureSong.id).toBe(PREVIEW_FIXTURE_SONG_ID);
    expect(previewFixtureSong.title).toBe('多远都要在一起');
    expect(previewFixtureSong.artists[0]?.name).toContain('G.E.M.');
    expect(previewFixtureSong.artwork.src.startsWith('/artwork/')).toBe(true);
    expect(previewFixtureLyrics.syncMode).toBe('word');
    expect(previewFixtureLyrics.lines.length).toBeGreaterThan(3);
    expect(previewFixtureLyrics.lines.every((line) => line.words.length > 0)).toBe(true);
  });

  it('plays an isolated timeline without mutating the real queue', () => {
    usePlayerStore.setState({
      ...initialPlayerState,
      queue: [previewFixtureSong],
      currentIndex: 0,
      isPlaying: false,
    });
    useLyricsPresetPreviewStore.getState().play();
    useLyricsPresetPreviewStore.getState().tick(1_200);
    expect(useLyricsPresetPreviewStore.getState()).toMatchObject({
      isPlaying: true,
      positionMs: 1_200,
    });
    expect(usePlayerStore.getState().queue.map((track) => track.id)).toEqual([
      PREVIEW_FIXTURE_SONG_ID,
    ]);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });
});
