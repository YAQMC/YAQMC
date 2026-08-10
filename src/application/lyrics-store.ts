import { create } from 'zustand';
import type { EntityId, LyricDocument } from '../domain/music';

interface LyricsState {
  songId: EntityId | null;
  status: 'idle' | 'loading' | 'ready' | 'missing' | 'error';
  document: LyricDocument | null;
  error: string | null;
  startLoading: (songId: EntityId) => void;
  setDocument: (songId: EntityId, document: LyricDocument | null) => void;
  setError: (songId: EntityId, message: string) => void;
}

export const useLyricsStore = create<LyricsState>((set) => ({
  songId: null,
  status: 'idle',
  document: null,
  error: null,
  startLoading: (songId) => set({ songId, status: 'loading', document: null, error: null }),
  setDocument: (songId, document) =>
    set({ songId, document, status: document ? 'ready' : 'missing', error: null }),
  setError: (songId, message) => set({ songId, document: null, status: 'error', error: message }),
}));
