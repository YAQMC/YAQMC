import { create } from 'zustand';
import type { EntityId, LyricDocument } from '../domain/music';

interface LyricsState {
  songId: EntityId | null;
  generation: number;
  status: 'idle' | 'loading' | 'ready' | 'missing' | 'error';
  document: LyricDocument | null;
  error: string | null;
  startLoading: (songId: EntityId, generation?: number) => void;
  setDocument: (songId: EntityId, document: LyricDocument | null, generation?: number) => void;
  setError: (songId: EntityId, message: string, generation?: number) => void;
}

function isCurrent(state: LyricsState, songId: EntityId, generation?: number): boolean {
  if (generation !== undefined && generation !== state.generation) return false;
  return state.songId === null || state.songId === songId;
}

export const useLyricsStore = create<LyricsState>((set) => ({
  songId: null,
  generation: 0,
  status: 'idle',
  document: null,
  error: null,
  startLoading: (songId, generation = 0) =>
    set({
      songId,
      generation,
      status: 'loading',
      document: null,
      error: null,
    }),
  setDocument: (songId, document, generation) =>
    set((state) => {
      if (!isCurrent(state, songId, generation)) return state;
      return {
        songId,
        document,
        status: document ? 'ready' : 'missing',
        error: null,
      };
    }),
  setError: (songId, message, generation) =>
    set((state) => {
      if (!isCurrent(state, songId, generation)) return state;
      return { songId, document: null, status: 'error', error: message };
    }),
}));
