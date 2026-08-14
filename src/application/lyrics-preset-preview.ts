import { create } from 'zustand';
import type { LyricDocument, Song } from '../domain/music';
import {
  previewFixtureLyrics,
  previewFixtureSong,
  PREVIEW_FIXTURE_SONG_ID,
} from './lyrics-preset-preview-fixture';
import { logger } from './logger';

interface LyricsPresetPreviewState {
  songId: string;
  song: Song;
  lyrics: LyricDocument;
  artworkSrc: string;
  positionMs: number;
  isPlaying: boolean;
  durationMs: number;
  timelineRevision: number;
  offline: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (positionMs: number) => void;
  tick: (elapsedMs: number) => void;
  hydrate: (input: { song: Song; lyrics: LyricDocument; artworkSrc: string }) => void;
  fallback: () => void;
  reset: () => void;
}

const fixtureArtwork = previewFixtureSong.artwork.src;

export const useLyricsPresetPreviewStore = create<LyricsPresetPreviewState>((set, get) => ({
  songId: PREVIEW_FIXTURE_SONG_ID,
  song: previewFixtureSong,
  lyrics: previewFixtureLyrics,
  artworkSrc: fixtureArtwork,
  positionMs: 0,
  isPlaying: false,
  durationMs: previewFixtureSong.durationMs,
  timelineRevision: 0,
  offline: false,
  play: () => {
    if (get().isPlaying) return;
    logger.info('lyrics.preview.play', 'preset preview started', {
      songId: get().songId,
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
    set((state) => ({
      positionMs: Math.max(0, Math.min(positionMs, duration)),
      timelineRevision: state.timelineRevision + 1,
    }));
  },
  tick: (elapsedMs) =>
    set((state) => {
      if (!state.isPlaying) return state;
      const next = state.positionMs + elapsedMs;
      if (next >= state.durationMs) return { positionMs: 0, isPlaying: true };
      return { positionMs: next };
    }),
  hydrate: ({ song, lyrics, artworkSrc }) => {
    set({
      songId: song.id,
      song,
      lyrics,
      artworkSrc,
      durationMs: song.durationMs || previewFixtureSong.durationMs,
      offline: false,
    });
    logger.info('lyrics.preview.hydrate', 'hydrated preset preview', { songId: song.id });
  },
  fallback: () => {
    set({
      songId: PREVIEW_FIXTURE_SONG_ID,
      song: previewFixtureSong,
      lyrics: previewFixtureLyrics,
      artworkSrc: fixtureArtwork,
      durationMs: previewFixtureSong.durationMs,
      offline: true,
    });
    logger.warn('lyrics.preview.fallback', 'using local preview data', {
      songId: PREVIEW_FIXTURE_SONG_ID,
    });
  },
  reset: () =>
    set({
      songId: PREVIEW_FIXTURE_SONG_ID,
      song: previewFixtureSong,
      lyrics: previewFixtureLyrics,
      artworkSrc: fixtureArtwork,
      positionMs: 0,
      isPlaying: false,
      durationMs: previewFixtureSong.durationMs,
      timelineRevision: 0,
      offline: false,
    }),
}));

export { previewFixtureLyrics, previewFixtureSong, PREVIEW_FIXTURE_SONG_ID };
