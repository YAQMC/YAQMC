import { create } from 'zustand';
import type { EntityId, Song } from '../domain/music';
import { dispatchPlayerCommand } from './player-command-adapter';

export type RepeatMode = 'off' | 'all' | 'one';
export type PlaybackState =
  | 'idle'
  | 'loading'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'stopped'
  | 'ended'
  | 'recoverable-error'
  | 'fatal-error';

export interface PlaybackFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface PlayerState {
  queue: Song[];
  currentIndex: number;
  positionMs: number;
  isPlaying: boolean;
  volume: number;
  isMuted: boolean;
  repeat: RepeatMode;
  shuffle: boolean;
  playbackState: PlaybackState;
  playbackDurationMs: number | null;
  playbackError: PlaybackFailure | null;
  observedAtMs: number;
  queueOpen: boolean;
  lyricsOpen: boolean;
}

interface PlayerActions {
  hydrateQueue: (tracks: Song[]) => void;
  playTracks: (tracks: Song[], startAtId?: EntityId) => void;
  playFromQueue: (index: number) => void;
  togglePlayback: () => void;
  next: () => void;
  previous: () => void;
  seek: (positionMs: number) => void;
  tick: (elapsedMs: number) => void;
  setVolume: (volume: number) => void;
  toggleMuted: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  toggleQueue: () => void;
  toggleLyrics: () => void;
  closePanels: () => void;
  addToQueue: (song: Song) => void;
  removeFromQueue: (index: number) => void;
  applyExternalSnapshot: (snapshot: AuthoritativePlayerSnapshot) => void;
}

export type PlayerStore = PlayerState & PlayerActions;

export interface AuthoritativePlayerSnapshot {
  queue: Song[];
  currentIndex: number;
  positionMs: number;
  isPlaying: boolean;
  volume: number;
  isMuted: boolean;
  repeat: RepeatMode;
  shuffle: boolean;
  playbackState: PlaybackState;
  playbackDurationMs: number | null;
  playbackError: PlaybackFailure | null;
}

export const initialPlayerState: PlayerState = {
  queue: [],
  currentIndex: -1,
  positionMs: 0,
  isPlaying: false,
  volume: 0.72,
  isMuted: false,
  repeat: 'off',
  shuffle: false,
  playbackState: 'idle',
  playbackDurationMs: null,
  playbackError: null,
  observedAtMs: 0,
  queueOpen: false,
  lyricsOpen: false,
};

function getNextIndex(state: PlayerState): number {
  if (state.queue.length === 0) return -1;
  if (state.shuffle && state.queue.length > 1) {
    const candidates = state.queue
      .map((_, index) => index)
      .filter((index) => index !== state.currentIndex);
    return candidates[Math.floor(Math.random() * candidates.length)] ?? state.currentIndex;
  }
  if (state.currentIndex < state.queue.length - 1) return state.currentIndex + 1;
  return state.repeat === 'all' ? 0 : state.currentIndex;
}

export const usePlayerStore = create<PlayerStore>((set, get) => ({
  ...initialPlayerState,

  hydrateQueue: (tracks) =>
    set((state) => {
      if (state.queue.length > 0 || tracks.length === 0) return state;
      if (dispatchPlayerCommand({ type: 'hydrateQueue', tracks })) return state;
      return { queue: tracks, currentIndex: 0 };
    }),

  playTracks: (tracks, startAtId) => {
    const playable = tracks.filter((track) => track.availability.status === 'available');
    if (playable.length === 0) return;
    if (dispatchPlayerCommand({ type: 'playTracks', tracks: playable, startAtId })) return;
    const requestedIndex = startAtId ? playable.findIndex((track) => track.id === startAtId) : 0;
    set({
      queue: playable,
      currentIndex: requestedIndex >= 0 ? requestedIndex : 0,
      positionMs: 0,
      isPlaying: true,
      playbackState: 'playing',
      playbackDurationMs: playable[requestedIndex >= 0 ? requestedIndex : 0]?.durationMs ?? null,
      playbackError: null,
      observedAtMs: performance.now(),
    });
  },

  playFromQueue: (index) => {
    const { queue } = get();
    if (index < 0 || index >= queue.length) return;
    if (dispatchPlayerCommand({ type: 'playFromQueue', index })) return;
    set({
      currentIndex: index,
      positionMs: 0,
      isPlaying: true,
      playbackState: 'playing',
      playbackDurationMs: queue[index]?.durationMs ?? null,
      playbackError: null,
      observedAtMs: performance.now(),
    });
  },

  togglePlayback: () => {
    if (dispatchPlayerCommand({ type: 'togglePlayback' })) return;
    set((state) => {
      if (state.currentIndex < 0 || state.queue.length === 0) return state;
      const isPlaying = !state.isPlaying;
      return {
        isPlaying,
        playbackState: isPlaying ? 'playing' : 'paused',
        observedAtMs: performance.now(),
      };
    });
  },

  next: () => {
    if (dispatchPlayerCommand({ type: 'next' })) return;
    set((state) => {
      const nextIndex = getNextIndex(state);
      if (nextIndex < 0) return state;
      const reachedEnd = nextIndex === state.currentIndex && state.repeat === 'off';
      return {
        currentIndex: nextIndex,
        positionMs: 0,
        isPlaying: reachedEnd ? false : state.isPlaying,
        playbackState: reachedEnd ? 'ended' : state.isPlaying ? 'playing' : state.playbackState,
        playbackDurationMs: state.queue[nextIndex]?.durationMs ?? null,
        observedAtMs: performance.now(),
      };
    });
  },

  previous: () => {
    if (dispatchPlayerCommand({ type: 'previous' })) return;
    set((state) => {
      if (state.queue.length === 0) return state;
      if (state.positionMs > 4_000) return { positionMs: 0, observedAtMs: performance.now() };
      const currentIndex = state.currentIndex > 0 ? state.currentIndex - 1 : 0;
      return {
        currentIndex,
        positionMs: 0,
        playbackDurationMs: state.queue[currentIndex]?.durationMs ?? null,
        observedAtMs: performance.now(),
      };
    });
  },

  seek: (positionMs) => {
    const state = get();
    const duration = state.playbackDurationMs ?? state.queue[state.currentIndex]?.durationMs ?? 0;
    const boundedPosition = Math.max(0, Math.min(positionMs, duration));
    if (dispatchPlayerCommand({ type: 'seek', positionMs: boundedPosition })) return;
    set({ positionMs: boundedPosition, observedAtMs: performance.now() });
  },

  tick: (elapsedMs) =>
    set((state) => {
      if (!state.isPlaying || state.currentIndex < 0) return state;
      const current = state.queue[state.currentIndex];
      if (!current) return state;
      const nextPosition = state.positionMs + elapsedMs;
      if (nextPosition < current.durationMs) {
        return { positionMs: nextPosition, observedAtMs: performance.now() };
      }
      if (state.repeat === 'one') return { positionMs: 0, observedAtMs: performance.now() };

      const nextIndex = getNextIndex(state);
      const reachedEnd = nextIndex === state.currentIndex && state.repeat === 'off';
      return {
        currentIndex: nextIndex,
        positionMs: 0,
        isPlaying: !reachedEnd,
        playbackState: reachedEnd ? 'ended' : 'playing',
        playbackDurationMs: state.queue[nextIndex]?.durationMs ?? null,
        observedAtMs: performance.now(),
      };
    }),

  setVolume: (volume) => {
    const boundedVolume = Math.max(0, Math.min(volume, 1));
    if (dispatchPlayerCommand({ type: 'setVolume', volume: boundedVolume })) return;
    set({ volume: boundedVolume, isMuted: false });
  },
  toggleMuted: () => {
    if (dispatchPlayerCommand({ type: 'toggleMuted' })) return;
    set((state) => ({ isMuted: !state.isMuted }));
  },
  toggleShuffle: () => {
    if (dispatchPlayerCommand({ type: 'toggleShuffle' })) return;
    set((state) => ({ shuffle: !state.shuffle }));
  },
  cycleRepeat: () => {
    if (dispatchPlayerCommand({ type: 'cycleRepeat' })) return;
    set((state) => ({
      repeat: state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off',
    }));
  },
  toggleQueue: () => set((state) => ({ queueOpen: !state.queueOpen, lyricsOpen: false })),
  toggleLyrics: () => set((state) => ({ lyricsOpen: !state.lyricsOpen, queueOpen: false })),
  closePanels: () => set({ queueOpen: false, lyricsOpen: false }),

  addToQueue: (song) => {
    if (dispatchPlayerCommand({ type: 'addToQueue', song })) return;
    set((state) => ({
      queue: [...state.queue, song],
      currentIndex: state.currentIndex < 0 ? 0 : state.currentIndex,
    }));
  },

  removeFromQueue: (index) => {
    if (dispatchPlayerCommand({ type: 'removeFromQueue', index })) return;
    set((state) => {
      if (index < 0 || index >= state.queue.length) return state;
      const queue = state.queue.filter((_, candidateIndex) => candidateIndex !== index);
      if (queue.length === 0) {
        return {
          queue,
          currentIndex: -1,
          positionMs: 0,
          isPlaying: false,
          playbackState: 'idle',
          playbackDurationMs: null,
          playbackError: null,
        };
      }
      const currentIndex =
        index < state.currentIndex
          ? state.currentIndex - 1
          : Math.min(state.currentIndex, queue.length - 1);
      return { queue, currentIndex };
    });
  },

  applyExternalSnapshot: (snapshot) =>
    set({
      ...snapshot,
      observedAtMs: performance.now(),
    }),
}));

export function useCurrentSong(): Song | null {
  return usePlayerStore((state) => state.queue[state.currentIndex] ?? null);
}

export function getEstimatedPositionMs(now = performance.now()): number {
  const state = usePlayerStore.getState();
  const current = state.queue[state.currentIndex];
  if (!current) return 0;
  const elapsed = state.isPlaying ? Math.max(0, now - state.observedAtMs) : 0;
  return Math.min(state.playbackDurationMs ?? current.durationMs, state.positionMs + elapsed);
}
