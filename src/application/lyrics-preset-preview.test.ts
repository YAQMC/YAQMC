import { afterEach, describe, expect, it } from 'vitest';
import {
  PREVIEW_SAMPLE_SONG_ID,
  previewSampleLyrics,
  previewSampleSong,
} from './lyrics-preset-preview-sample';
import { useLyricsPresetPreviewStore } from './lyrics-preset-preview';
import { initialPlayerState, usePlayerStore } from './player-store';

describe('lyrics preset preview sample', () => {
  afterEach(() => {
    useLyricsPresetPreviewStore.getState().reset();
    usePlayerStore.setState(initialPlayerState);
  });

  it('is product-owned local preview content with word timing and no network source', () => {
    expect(previewSampleSong.id).toBe(PREVIEW_SAMPLE_SONG_ID);
    expect(previewSampleSong.title).toBe('一起听见');
    expect(previewSampleSong.artists[0]?.name).toBe('YAQMC Studio');
    expect(previewSampleSong.artwork.src.startsWith('/artwork/')).toBe(true);
    expect(previewSampleLyrics.syncMode).toBe('word');
    expect(previewSampleLyrics.lines.length).toBeGreaterThan(3);
    expect(previewSampleLyrics.lines.every((line) => line.words.length > 0)).toBe(true);
  });

  it('plays an isolated timeline without mutating the real queue', () => {
    usePlayerStore.setState({
      ...initialPlayerState,
      queue: [previewSampleSong],
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
      PREVIEW_SAMPLE_SONG_ID,
    ]);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });
});
