import { create } from 'zustand';
import {
  previewFixtureLyrics,
  previewFixtureSong,
  PREVIEW_FIXTURE_SONG_ID,
} from './lyrics-preset-preview-fixture';
import { logger } from './logger';

interface LyricsPresetPreviewState {
  songId: string;
  positionMs: number;
  isPlaying: boolean;
  durationMs: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (positionMs: number) => void;
  tick: (elapsedMs: number) => void;
  reset: () => void;
}

export const useLyricsPresetPreviewStore = create<LyricsPresetPreviewState>((set, get) => ({
  songId: PREVIEW_FIXTURE_SONG_ID,
  positionMs: 0,
  isPlaying: false,
  durationMs: previewFixtureSong.durationMs,
  play: () => {
    if (get().isPlaying) return;
    logger.info('lyrics.preview.play', 'preset preview started', {
      songId: PREVIEW_FIXTURE_SONG_ID,
    });
    set({ isPlaying: true });
  },
  pause: () => set({ isPlaying: false }),
  toggle: () => {
    if (get().isPlaying) get().pause();
    else get().play();
  },
  seek: (positionMs) => {
    const duration = get().durationMs;
    set({ positionMs: Math.max(0, Math.min(positionMs, duration)) });
  },
  tick: (elapsedMs) =>
    set((state) => {
      if (!state.isPlaying) return state;
      const next = state.positionMs + elapsedMs;
      if (next >= state.durationMs) return { positionMs: 0, isPlaying: true };
      return { positionMs: next };
    }),
  reset: () => set({ positionMs: 0, isPlaying: false }),
}));

export { previewFixtureLyrics, previewFixtureSong, PREVIEW_FIXTURE_SONG_ID };
