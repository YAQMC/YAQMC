import { create } from 'zustand';
import type {
  AudioQualityPreference,
  EntityId,
  PlaybackSourceSelection,
  Song,
} from '../domain/music';
import { applyPrimaryPlaybackMode, type PrimaryPlaybackMode } from './playback-mode';
import { dispatchPlayerCommand } from './player-command-adapter';

export type RepeatMode = 'off' | 'all' | 'one';
export type PlaybackOrder = 'sequential' | 'shuffle';
export interface QueueEntry {
  id: string;
  track: Song;
}
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
  queueEntries: QueueEntry[];
  currentIndex: number;
  currentQueueEntryId: string | null;
  positionMs: number;
  isPlaying: boolean;
  volume: number;
  isMuted: boolean;
  repeat: RepeatMode;
  playbackOrder: PlaybackOrder;
  shuffle: boolean;
  shuffleTraversal: string[];
  shuffleCursor: number;
  playbackHistory: string[];
  historyCursor: number;
  upcomingQueueEntryIds: string[];
  playbackState: PlaybackState;
  playbackDurationMs: number | null;
  playbackError: PlaybackFailure | null;
  sourceSelection: PlaybackSourceSelection | null;
  observedAtMs: number;
  timelineRevision: number;
  queueOpen: boolean;
  lyricsOpen: boolean;
  guessSessionActive: boolean;
  sessionId: number;
  snapshotRevision: number;
  sourceGeneration: number;
  lastSeekRevision: number;
  sampledAtMs: number;
  isScrubbing: boolean;
  scrubPosition: number;
  scrubAwaitingAckFrom: number | null;
  isVolumeScrubbing: boolean;
}

interface PlayerActions {
  hydrateQueue: (tracks: Song[]) => void;
  playTracks: (tracks: Song[], startAtId?: EntityId, shuffle?: boolean) => void;
  playFromQueue: (index: number) => void;
  playQueueEntry: (entryId: string) => void;
  playNextQueueEntry: (entryId: string) => void;
  togglePlayback: () => void;
  next: () => void;
  previous: () => void;
  seek: (positionMs: number) => void;
  beginScrub: () => void;
  previewScrub: (positionMs: number) => void;
  commitScrub: (positionMs: number) => void;
  tick: (elapsedMs: number) => void;
  beginVolumeScrub: () => void;
  setVolume: (volume: number) => void;
  toggleMuted: () => void;
  toggleShuffle: () => void;
  setShuffle: (enabled: boolean) => void;
  setQuality: (quality: AudioQualityPreference) => void;
  cycleRepeat: () => void;
  setRepeat: (mode: RepeatMode) => void;
  setPrimaryPlaybackMode: (mode: PrimaryPlaybackMode) => void;
  toggleQueue: () => void;
  toggleLyrics: () => void;
  openLyrics: () => void;
  closePanels: () => void;
  addToQueue: (song: Song) => void;
  addTracksToQueue: (tracks: Song[]) => void;
  removeFromQueue: (index: number) => void;
  removeQueueEntry: (entryId: string) => void;
  reorderQueueEntry: (entryId: string, targetIndex: number) => void;
  applyExternalSnapshot: (snapshot: AuthoritativePlayerSnapshot) => void;
  startGuessSession: () => void;
  endGuessSession: () => void;
}

export type PlayerStore = PlayerState & PlayerActions;

export interface AuthoritativePlayerSnapshot {
  queue: Song[];
  queueEntries?: QueueEntry[];
  currentIndex: number;
  currentQueueEntryId?: string | null;
  positionMs: number;
  isPlaying: boolean;
  volume: number;
  isMuted: boolean;
  repeat: RepeatMode;
  playbackOrder?: PlaybackOrder;
  shuffle: boolean;
  shuffleTraversal?: string[];
  shuffleCursor?: number;
  playbackHistory?: string[];
  historyCursor?: number;
  upcomingQueueEntryIds?: string[];
  playbackState: PlaybackState;
  playbackDurationMs: number | null;
  playbackError: PlaybackFailure | null;
  sourceSelection?: PlaybackSourceSelection | null;
  sessionId?: number;
  snapshotRevision?: number;
  sourceGeneration?: number;
  lastSeekRevision?: number;
  sampledAtMs?: number;
}

export const initialPlayerState: PlayerState = {
  queue: [],
  queueEntries: [],
  currentIndex: -1,
  currentQueueEntryId: null,
  positionMs: 0,
  isPlaying: false,
  volume: 0.72,
  isMuted: false,
  repeat: 'off',
  playbackOrder: 'sequential',
  shuffle: false,
  shuffleTraversal: [],
  shuffleCursor: 0,
  playbackHistory: [],
  historyCursor: 0,
  upcomingQueueEntryIds: [],
  playbackState: 'idle',
  playbackDurationMs: null,
  playbackError: null,
  sourceSelection: null,
  observedAtMs: 0,
  timelineRevision: 0,
  queueOpen: false,
  lyricsOpen: false,
  guessSessionActive: false,
  sessionId: 0,
  snapshotRevision: 0,
  sourceGeneration: 0,
  lastSeekRevision: 0,
  sampledAtMs: 0,
  isScrubbing: false,
  scrubPosition: 0,
  scrubAwaitingAckFrom: null,
  isVolumeScrubbing: false,
};

let localQueueEntrySequence = 0;
let localShuffleGeneration = 0;

function newLocalQueueEntry(track: Song): QueueEntry {
  localQueueEntrySequence += 1;
  return { id: `local-queue:${localQueueEntrySequence}`, track };
}

function entriesForTracks(tracks: Song[]): QueueEntry[] {
  return tracks.map(newLocalQueueEntry);
}

function indexOfEntry(entries: QueueEntry[], id: string | null): number {
  return id === null ? -1 : entries.findIndex((entry) => entry.id === id);
}

function deterministicLocalShuffle(ids: string[]): string[] {
  localShuffleGeneration += 1;
  let state = (localShuffleGeneration ^ 0x9e3779b9) >>> 0;
  for (const id of ids) {
    for (let index = 0; index < id.length; index += 1) {
      state ^= id.charCodeAt(index);
      state = Math.imul(state, 16777619) >>> 0;
    }
  }
  const result = [...ids];
  for (let index = result.length - 1; index > 0; index -= 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const target = (state >>> 0) % (index + 1);
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

function shuffledFromCurrent(entries: QueueEntry[], currentId: string | null): string[] {
  if (currentId === null) return [];
  return [
    currentId,
    ...deterministicLocalShuffle(
      entries.filter((entry) => entry.id !== currentId).map((entry) => entry.id),
    ),
  ];
}

function sequentialUpcoming(entries: QueueEntry[], currentIndex: number): string[] {
  return currentIndex < 0 ? [] : entries.slice(currentIndex + 1).map((entry) => entry.id);
}

function fallbackOrderState(
  entries: QueueEntry[],
  currentId: string | null,
  playbackOrder: PlaybackOrder,
): Pick<
  PlayerState,
  | 'playbackOrder'
  | 'shuffle'
  | 'shuffleTraversal'
  | 'shuffleCursor'
  | 'playbackHistory'
  | 'historyCursor'
  | 'upcomingQueueEntryIds'
> {
  const currentIndex = indexOfEntry(entries, currentId);
  if (playbackOrder === 'sequential') {
    return {
      playbackOrder,
      shuffle: false,
      shuffleTraversal: [],
      shuffleCursor: 0,
      playbackHistory: [],
      historyCursor: 0,
      upcomingQueueEntryIds: sequentialUpcoming(entries, currentIndex),
    };
  }
  const traversal = shuffledFromCurrent(entries, currentId);
  return {
    playbackOrder,
    shuffle: true,
    shuffleTraversal: traversal,
    shuffleCursor: 0,
    playbackHistory: currentId === null ? [] : [currentId],
    historyCursor: 0,
    upcomingQueueEntryIds: traversal.slice(1),
  };
}

function reuseQueueIfSameTracks(previous: Song[], incoming: Song[]): Song[] {
  if (
    previous.length === incoming.length &&
    previous.every((song, index) => song.id === incoming[index]?.id)
  ) {
    return previous;
  }
  return incoming;
}

function reuseQueueEntriesIfSameIds(previous: QueueEntry[], incoming: QueueEntry[]): QueueEntry[] {
  if (
    previous.length === incoming.length &&
    previous.every((entry, index) => entry.id === incoming[index]?.id)
  ) {
    return previous;
  }
  return incoming;
}

function normalizedEntries(
  snapshot: AuthoritativePlayerSnapshot,
  previous: PlayerState,
): QueueEntry[] {
  if (
    snapshot.queueEntries?.length === snapshot.queue.length &&
    snapshot.queueEntries.every((entry, index) => entry.track.id === snapshot.queue[index]?.id)
  ) {
    return snapshot.queueEntries;
  }
  if (
    previous.queueEntries.length === snapshot.queue.length &&
    previous.queueEntries.every((entry, index) => entry.track.id === snapshot.queue[index]?.id)
  ) {
    return previous.queueEntries.map((entry, index) => ({
      ...entry,
      track: snapshot.queue[index]!,
    }));
  }
  return entriesForTracks(snapshot.queue);
}

function localEntries(state: PlayerState): QueueEntry[] {
  if (
    state.queueEntries.length === state.queue.length &&
    state.queueEntries.every((entry, index) => entry.track.id === state.queue[index]?.id)
  ) {
    return [...state.queueEntries];
  }
  return state.queue.map((track, index) => ({
    id: `local-legacy:${index}:${track.id}`,
    track,
  }));
}

function localCurrentId(state: PlayerState, entries: QueueEntry[]): string | null {
  if (indexOfEntry(entries, state.currentQueueEntryId) >= 0) return state.currentQueueEntryId;
  return entries[state.currentIndex]?.id ?? null;
}

function getNextTransition(state: PlayerState): {
  index: number;
  orderPatch: Partial<PlayerState>;
  reachedEnd: boolean;
} {
  if (state.queueEntries.length === 0 || state.currentQueueEntryId === null) {
    return { index: -1, orderPatch: {}, reachedEnd: true };
  }
  if (state.playbackOrder === 'shuffle') {
    let traversal = state.shuffleTraversal;
    let cursor = state.shuffleCursor;
    let targetId = state.playbackHistory[state.historyCursor + 1];
    let history = state.playbackHistory;
    let historyCursor = state.historyCursor;
    if (!targetId) targetId = traversal[cursor + 1];
    if (!targetId && state.repeat === 'all') {
      traversal = shuffledFromCurrent(state.queueEntries, state.currentQueueEntryId);
      targetId = traversal[1] ?? state.currentQueueEntryId;
    }
    if (!targetId) return { index: state.currentIndex, orderPatch: {}, reachedEnd: true };
    const index = indexOfEntry(state.queueEntries, targetId);
    if (index < 0) return { index: state.currentIndex, orderPatch: {}, reachedEnd: true };
    cursor = Math.max(0, traversal.indexOf(targetId));
    if (history[historyCursor + 1] === targetId) {
      historyCursor += 1;
    } else {
      history = [...history.slice(0, historyCursor + 1), targetId];
      historyCursor = history.length - 1;
    }
    return {
      index,
      reachedEnd: false,
      orderPatch: {
        shuffleTraversal: traversal,
        shuffleCursor: cursor,
        playbackHistory: history,
        historyCursor,
        upcomingQueueEntryIds: traversal.slice(cursor + 1),
      },
    };
  }
  const index = state.currentIndex + 1;
  if (index < state.queueEntries.length) return { index, orderPatch: {}, reachedEnd: false };
  if (state.repeat === 'all') return { index: 0, orderPatch: {}, reachedEnd: false };
  return { index: state.currentIndex, orderPatch: {}, reachedEnd: true };
}

export const usePlayerStore = create<PlayerStore>((set, get) => ({
  ...initialPlayerState,

  hydrateQueue: (tracks) =>
    set((state) => {
      if (state.queue.length > 0 || tracks.length === 0) return state;
      if (dispatchPlayerCommand({ type: 'hydrateQueue', tracks })) return state;
      const queueEntries = entriesForTracks(tracks);
      const currentQueueEntryId = queueEntries[0]?.id ?? null;
      return {
        queue: tracks,
        queueEntries,
        currentIndex: 0,
        currentQueueEntryId,
        ...fallbackOrderState(queueEntries, currentQueueEntryId, state.playbackOrder),
      };
    }),

  playTracks: (tracks, startAtId, shuffle) => {
    const playable = tracks.filter((track) => track.availability.status !== 'unavailable');
    if (playable.length === 0) return;
    if (dispatchPlayerCommand({ type: 'playTracks', tracks: playable, startAtId, shuffle })) return;
    const requestedIndex = startAtId ? playable.findIndex((track) => track.id === startAtId) : 0;
    const currentIndex = requestedIndex >= 0 ? requestedIndex : 0;
    const queueEntries = entriesForTracks(playable);
    const currentQueueEntryId = queueEntries[currentIndex]?.id ?? null;
    const playbackOrder =
      shuffle === undefined ? get().playbackOrder : shuffle ? 'shuffle' : 'sequential';
    set((state) => ({
      queue: playable,
      queueEntries,
      currentIndex,
      currentQueueEntryId,
      positionMs: 0,
      isPlaying: true,
      playbackState: 'playing',
      playbackDurationMs: playable[currentIndex]?.durationMs ?? null,
      playbackError: null,
      sourceSelection: null,
      observedAtMs: performance.now(),
      timelineRevision: state.timelineRevision + 1,
      guessSessionActive: false,
      ...fallbackOrderState(queueEntries, currentQueueEntryId, playbackOrder),
    }));
  },

  playFromQueue: (index) => {
    const state = get();
    const { queue } = state;
    if (index < 0 || index >= queue.length) return;
    if (dispatchPlayerCommand({ type: 'playFromQueue', index })) return;
    const queueEntries = localEntries(state);
    const currentQueueEntryId = queueEntries[index]?.id ?? null;
    set((state) => ({
      queueEntries,
      currentIndex: index,
      currentQueueEntryId,
      positionMs: 0,
      isPlaying: true,
      playbackState: 'playing',
      playbackDurationMs: queue[index]?.durationMs ?? null,
      playbackError: null,
      sourceSelection: null,
      observedAtMs: performance.now(),
      timelineRevision: state.timelineRevision + 1,
      ...(state.playbackOrder === 'sequential'
        ? { upcomingQueueEntryIds: sequentialUpcoming(queueEntries, index) }
        : fallbackOrderState(queueEntries, currentQueueEntryId, 'shuffle')),
    }));
  },

  playQueueEntry: (entryId) => {
    const state = get();
    const entries = localEntries(state);
    const index = indexOfEntry(entries, entryId);
    if (index < 0) return;
    if (dispatchPlayerCommand({ type: 'playQueueEntry', entryId })) return;
    state.playFromQueue(index);
  },

  playNextQueueEntry: (entryId) => {
    const state = get();
    const entries = localEntries(state);
    const from = indexOfEntry(entries, entryId);
    const currentId = localCurrentId(state, entries);
    const current = indexOfEntry(entries, currentId);
    if (from < 0 || current < 0 || from === current) return;
    if (dispatchPlayerCommand({ type: 'playNextQueueEntry', entryId })) return;
    const [entry] = entries.splice(from, 1);
    if (!entry) return;
    const currentAfterRemove = indexOfEntry(entries, currentId);
    entries.splice(currentAfterRemove + 1, 0, entry);
    const currentIndex = indexOfEntry(entries, currentId);
    const queue = entries.map((candidate) => candidate.track);
    const order = fallbackOrderState(entries, currentId, state.playbackOrder);
    if (state.playbackOrder === 'shuffle') {
      const traversal = state.shuffleTraversal.filter((candidate) => candidate !== entryId);
      const cursor = Math.max(0, traversal.indexOf(currentId ?? ''));
      traversal.splice(cursor + 1, 0, entryId);
      order.shuffleTraversal = traversal;
      order.shuffleCursor = cursor;
      order.upcomingQueueEntryIds = traversal.slice(cursor + 1);
    }
    set({ queue, queueEntries: entries, currentIndex, currentQueueEntryId: currentId, ...order });
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
        timelineRevision: state.timelineRevision + 1,
      };
    });
  },

  next: () => {
    if (dispatchPlayerCommand({ type: 'next' })) return;
    set((state) => {
      const entries = localEntries(state);
      const currentQueueEntryId = localCurrentId(state, entries);
      const normalized = { ...state, queueEntries: entries, currentQueueEntryId };
      const transition = getNextTransition(normalized);
      const nextIndex = transition.index;
      if (nextIndex < 0) return state;
      return {
        queueEntries: entries,
        currentIndex: nextIndex,
        currentQueueEntryId: entries[nextIndex]?.id ?? null,
        positionMs: 0,
        isPlaying: transition.reachedEnd ? false : state.isPlaying,
        playbackState: transition.reachedEnd
          ? 'ended'
          : state.isPlaying
            ? 'playing'
            : state.playbackState,
        playbackDurationMs: state.queue[nextIndex]?.durationMs ?? null,
        sourceSelection: null,
        observedAtMs: performance.now(),
        timelineRevision: state.timelineRevision + 1,
        ...(state.playbackOrder === 'sequential'
          ? { upcomingQueueEntryIds: sequentialUpcoming(entries, nextIndex) }
          : transition.orderPatch),
      };
    });
  },

  previous: () => {
    if (dispatchPlayerCommand({ type: 'previous' })) return;
    set((state) => {
      if (state.queue.length === 0) return state;
      if (state.positionMs > 4_000)
        return {
          positionMs: 0,
          observedAtMs: performance.now(),
          timelineRevision: state.timelineRevision + 1,
        };
      const entries = localEntries(state);
      let currentIndex = state.currentIndex > 0 ? state.currentIndex - 1 : 0;
      let historyCursor = state.historyCursor;
      if (state.playbackOrder === 'shuffle' && state.historyCursor > 0) {
        historyCursor -= 1;
        currentIndex = indexOfEntry(entries, state.playbackHistory[historyCursor] ?? null);
        if (currentIndex < 0) currentIndex = state.currentIndex;
      }
      return {
        queueEntries: entries,
        currentIndex,
        currentQueueEntryId: entries[currentIndex]?.id ?? null,
        positionMs: 0,
        playbackDurationMs: state.queue[currentIndex]?.durationMs ?? null,
        sourceSelection: null,
        observedAtMs: performance.now(),
        timelineRevision: state.timelineRevision + 1,
        ...(state.playbackOrder === 'shuffle'
          ? { historyCursor }
          : { upcomingQueueEntryIds: sequentialUpcoming(entries, currentIndex) }),
      };
    });
  },

  seek: (positionMs) => {
    const state = get();
    const duration = state.playbackDurationMs ?? state.queue[state.currentIndex]?.durationMs ?? 0;
    const boundedPosition = Math.max(0, Math.min(positionMs, duration));
    if (dispatchPlayerCommand({ type: 'seek', positionMs: boundedPosition })) {
      set({
        positionMs: boundedPosition,
        observedAtMs: performance.now(),
        sampledAtMs: Date.now(),
        timelineRevision: get().timelineRevision + 1,
        isScrubbing: false,
        scrubPosition: boundedPosition,
        scrubAwaitingAckFrom: get().lastSeekRevision,
      });
      return;
    }
    set((current) => ({
      positionMs: boundedPosition,
      observedAtMs: performance.now(),
      timelineRevision: current.timelineRevision + 1,
      isScrubbing: false,
      scrubPosition: boundedPosition,
    }));
  },

  beginScrub: () =>
    set((state) => ({
      isScrubbing: true,
      scrubPosition: state.positionMs,
      scrubAwaitingAckFrom: null,
    })),

  previewScrub: (positionMs) => {
    const state = get();
    const duration = state.playbackDurationMs ?? state.queue[state.currentIndex]?.durationMs ?? 0;
    const boundedPosition = Math.max(0, Math.min(positionMs, duration));
    set({
      isScrubbing: true,
      scrubPosition: boundedPosition,
    });
  },

  commitScrub: (positionMs) => {
    const state = get();
    const duration = state.playbackDurationMs ?? state.queue[state.currentIndex]?.durationMs ?? 0;
    const boundedPosition = Math.max(0, Math.min(positionMs, duration));
    set({
      isScrubbing: true,
      scrubPosition: boundedPosition,
      positionMs: boundedPosition,
      observedAtMs: performance.now(),
      sampledAtMs: Date.now(),
      timelineRevision: state.timelineRevision + 1,
      scrubAwaitingAckFrom: state.lastSeekRevision,
    });
    if (!dispatchPlayerCommand({ type: 'seek', positionMs: boundedPosition })) {
      set({ isScrubbing: false, scrubAwaitingAckFrom: null });
    }
  },

  tick: (elapsedMs) =>
    set((state) => {
      if (state.isScrubbing || !state.isPlaying || state.currentIndex < 0) return state;
      const current = state.queue[state.currentIndex];
      if (!current) return state;
      const nextPosition = state.positionMs + elapsedMs;
      if (nextPosition < current.durationMs) {
        return { positionMs: nextPosition, observedAtMs: performance.now() };
      }
      if (state.repeat === 'one')
        return {
          positionMs: 0,
          observedAtMs: performance.now(),
          timelineRevision: state.timelineRevision + 1,
        };

      const entries = localEntries(state);
      const currentQueueEntryId = localCurrentId(state, entries);
      const transition = getNextTransition({
        ...state,
        queueEntries: entries,
        currentQueueEntryId,
      });
      const nextIndex = transition.index;
      return {
        queueEntries: entries,
        currentIndex: nextIndex,
        currentQueueEntryId: entries[nextIndex]?.id ?? null,
        positionMs: 0,
        isPlaying: !transition.reachedEnd,
        playbackState: transition.reachedEnd ? 'ended' : 'playing',
        playbackDurationMs: state.queue[nextIndex]?.durationMs ?? null,
        sourceSelection: null,
        observedAtMs: performance.now(),
        timelineRevision: state.timelineRevision + 1,
        ...(state.playbackOrder === 'sequential'
          ? { upcomingQueueEntryIds: sequentialUpcoming(entries, nextIndex) }
          : transition.orderPatch),
      };
    }),

  beginVolumeScrub: () => {
    set({ isVolumeScrubbing: true });
  },
  setVolume: (volume) => {
    const boundedVolume = Math.max(0, Math.min(volume, 1));
    set({ volume: boundedVolume, isMuted: false, isVolumeScrubbing: true });
    if (dispatchPlayerCommand({ type: 'setVolume', volume: boundedVolume })) return;
    set({ isVolumeScrubbing: false });
  },
  toggleMuted: () => {
    set((state) => ({ isMuted: !state.isMuted, isVolumeScrubbing: true }));
    if (dispatchPlayerCommand({ type: 'toggleMuted' })) return;
    set({ isVolumeScrubbing: false });
  },
  toggleShuffle: () => {
    if (dispatchPlayerCommand({ type: 'toggleShuffle' })) return;
    set((state) => {
      const entries = localEntries(state);
      const currentId = localCurrentId(state, entries);
      const playbackOrder = state.playbackOrder === 'shuffle' ? 'sequential' : 'shuffle';
      return {
        queueEntries: entries,
        currentQueueEntryId: currentId,
        ...fallbackOrderState(entries, currentId, playbackOrder),
      };
    });
  },
  setShuffle: (enabled) => {
    if (dispatchPlayerCommand({ type: 'setShuffle', enabled })) return;
    set((state) => {
      const entries = localEntries(state);
      const currentId = localCurrentId(state, entries);
      return {
        queueEntries: entries,
        currentQueueEntryId: currentId,
        ...fallbackOrderState(entries, currentId, enabled ? 'shuffle' : 'sequential'),
      };
    });
  },
  setQuality: (quality) => {
    if (dispatchPlayerCommand({ type: 'setQuality', quality })) return;
    set((state) => ({
      sourceSelection: state.sourceSelection
        ? { ...state.sourceSelection, requestedQuality: quality }
        : state.sourceSelection,
    }));
  },
  cycleRepeat: () => {
    if (dispatchPlayerCommand({ type: 'cycleRepeat' })) return;
    set((state) => ({
      repeat: state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off',
    }));
  },
  setRepeat: (mode) => {
    if (dispatchPlayerCommand({ type: 'setRepeat', mode })) return;
    set({ repeat: mode });
  },
  setPrimaryPlaybackMode: (mode) => {
    if (dispatchPlayerCommand({ type: 'setPrimaryPlaybackMode', mode })) return;
    set((state) => {
      if (mode === 'repeat-one') return { repeat: 'one' };
      const applied = applyPrimaryPlaybackMode(state.playbackOrder, mode);
      if (applied.playbackOrder === state.playbackOrder) return { repeat: 'off' };
      const entries = localEntries(state);
      const currentId = localCurrentId(state, entries);
      return {
        repeat: 'off',
        queueEntries: entries,
        currentQueueEntryId: currentId,
        ...fallbackOrderState(entries, currentId, applied.playbackOrder),
      };
    });
  },
  toggleQueue: () => set((state) => ({ queueOpen: !state.queueOpen, lyricsOpen: false })),
  toggleLyrics: () => set((state) => ({ lyricsOpen: !state.lyricsOpen, queueOpen: false })),
  openLyrics: () => set({ lyricsOpen: true, queueOpen: false }),
  closePanels: () => set({ queueOpen: false, lyricsOpen: false }),

  startGuessSession: () => set({ guessSessionActive: true }),
  endGuessSession: () => set({ guessSessionActive: false }),

  addToQueue: (song) => {
    if (dispatchPlayerCommand({ type: 'addToQueue', song })) return;
    set((state) => {
      const queueEntries = [...localEntries(state), newLocalQueueEntry(song)];
      const currentIndex = state.currentIndex < 0 ? 0 : state.currentIndex;
      const currentQueueEntryId =
        localCurrentId(state, queueEntries) ?? queueEntries[currentIndex]?.id ?? null;
      return {
        queue: queueEntries.map((entry) => entry.track),
        queueEntries,
        currentIndex,
        currentQueueEntryId,
        ...fallbackOrderState(queueEntries, currentQueueEntryId, state.playbackOrder),
      };
    });
  },

  addTracksToQueue: (tracks) => {
    const playable = tracks.filter((track) => track.availability.status !== 'unavailable');
    if (playable.length === 0) return;
    if (dispatchPlayerCommand({ type: 'addTracksToQueue', tracks: playable })) return;
    set((state) => {
      const queueEntries = [...localEntries(state), ...entriesForTracks(playable)];
      const currentIndex = state.currentIndex < 0 ? 0 : state.currentIndex;
      const currentQueueEntryId =
        localCurrentId(state, queueEntries) ?? queueEntries[currentIndex]?.id ?? null;
      return {
        queue: queueEntries.map((entry) => entry.track),
        queueEntries,
        currentIndex,
        currentQueueEntryId,
        ...fallbackOrderState(queueEntries, currentQueueEntryId, state.playbackOrder),
      };
    });
  },

  removeFromQueue: (index) => {
    if (dispatchPlayerCommand({ type: 'removeFromQueue', index })) return;
    set((state) => {
      if (index < 0 || index >= state.queue.length) return state;
      const previousEntries = localEntries(state);
      const removedId = previousEntries[index]?.id ?? null;
      const currentId = localCurrentId(state, previousEntries);
      const queueEntries = previousEntries.filter((_, candidateIndex) => candidateIndex !== index);
      const queue = queueEntries.map((entry) => entry.track);
      if (queue.length === 0) {
        return {
          queue,
          queueEntries,
          currentIndex: -1,
          currentQueueEntryId: null,
          positionMs: 0,
          isPlaying: false,
          playbackState: 'idle',
          playbackDurationMs: null,
          playbackError: null,
          sourceSelection: null,
          ...fallbackOrderState(queueEntries, null, state.playbackOrder),
        };
      }
      const currentQueueEntryId =
        removedId === currentId
          ? (queueEntries[Math.min(index, queueEntries.length - 1)]?.id ?? null)
          : currentId;
      const currentIndex = indexOfEntry(queueEntries, currentQueueEntryId);
      return {
        queue,
        queueEntries,
        currentIndex,
        currentQueueEntryId,
        ...(index === state.currentIndex ? { sourceSelection: null } : {}),
        ...fallbackOrderState(queueEntries, currentQueueEntryId, state.playbackOrder),
      };
    });
  },

  removeQueueEntry: (entryId) => {
    const state = get();
    const index = indexOfEntry(localEntries(state), entryId);
    if (index < 0) return;
    if (dispatchPlayerCommand({ type: 'removeQueueEntry', entryId })) return;
    state.removeFromQueue(index);
  },

  reorderQueueEntry: (entryId, targetIndex) => {
    const state = get();
    const entries = localEntries(state);
    const from = indexOfEntry(entries, entryId);
    if (from < 0 || targetIndex < 0 || targetIndex >= entries.length || from === targetIndex)
      return;
    if (dispatchPlayerCommand({ type: 'reorderQueueEntry', entryId, targetIndex })) return;
    const currentQueueEntryId = localCurrentId(state, entries);
    const [entry] = entries.splice(from, 1);
    if (!entry) return;
    entries.splice(targetIndex, 0, entry);
    const currentIndex = indexOfEntry(entries, currentQueueEntryId);
    set({
      queue: entries.map((candidate) => candidate.track),
      queueEntries: entries,
      currentIndex,
      currentQueueEntryId,
      ...fallbackOrderState(entries, currentQueueEntryId, state.playbackOrder),
    });
  },

  applyExternalSnapshot: (snapshot) =>
    set((state) => {
      const incomingSession = snapshot.sessionId ?? 0;
      const incomingRevision = snapshot.snapshotRevision ?? 0;
      if (
        incomingSession !== 0 &&
        (incomingSession < state.sessionId ||
          (incomingSession === state.sessionId && incomingRevision < state.snapshotRevision))
      ) {
        return state;
      }
      const now = performance.now();
      const current = state.queue[state.currentIndex];
      const durationMs = state.playbackDurationMs ?? current?.durationMs ?? 0;
      const elapsedMs = state.isPlaying ? Math.max(0, now - state.observedAtMs) : 0;
      const predictedPositionMs = current
        ? Math.max(0, Math.min(durationMs, state.positionMs + elapsedMs))
        : 0;
      const queue = reuseQueueIfSameTracks(state.queue, snapshot.queue);
      const queueEntries = reuseQueueEntriesIfSameIds(
        state.queueEntries,
        normalizedEntries({ ...snapshot, queue }, state),
      );
      const currentQueueEntryId =
        snapshot.currentQueueEntryId ?? queueEntries[snapshot.currentIndex]?.id ?? null;
      const previousTrackId = current?.id ?? null;
      const nextTrackId = snapshot.queue[snapshot.currentIndex]?.id ?? null;
      const queueIdentityChanged =
        state.currentQueueEntryId !== null && currentQueueEntryId !== null
          ? state.currentQueueEntryId !== currentQueueEntryId
          : state.currentIndex !== snapshot.currentIndex || previousTrackId !== nextTrackId;
      const sessionChanged = incomingSession !== 0 && incomingSession !== state.sessionId;
      const lastSeekRevision = snapshot.lastSeekRevision ?? 0;
      const ackSeek =
        state.isScrubbing &&
        state.scrubAwaitingAckFrom !== null &&
        lastSeekRevision > state.scrubAwaitingAckFrom;
      const isScrubbing = !sessionChanged && !queueIdentityChanged && state.isScrubbing && !ackSeek;
      const discontinuity =
        queueIdentityChanged ||
        sessionChanged ||
        state.isPlaying !== snapshot.isPlaying ||
        (!isScrubbing && Math.abs(snapshot.positionMs - predictedPositionMs) > 250);
      const volumeCaughtUp =
        Math.abs(snapshot.volume - state.volume) <= 0.005 && snapshot.isMuted === state.isMuted;
      const isVolumeScrubbing = !sessionChanged && state.isVolumeScrubbing && !volumeCaughtUp;

      const playbackOrder = snapshot.playbackOrder ?? (snapshot.shuffle ? 'shuffle' : 'sequential');
      const shuffleTraversal = snapshot.shuffleTraversal ?? [];
      const shuffleCursor = snapshot.shuffleCursor ?? 0;
      const playbackHistory = snapshot.playbackHistory ?? [];
      const historyCursor = snapshot.historyCursor ?? 0;
      const upcomingQueueEntryIds =
        snapshot.upcomingQueueEntryIds ??
        (playbackOrder === 'shuffle'
          ? shuffleTraversal.slice(shuffleCursor + 1)
          : sequentialUpcoming(queueEntries, snapshot.currentIndex));

      return {
        ...snapshot,
        queue,
        queueEntries,
        currentQueueEntryId,
        playbackOrder,
        shuffle: playbackOrder === 'shuffle',
        shuffleTraversal,
        shuffleCursor,
        playbackHistory,
        historyCursor,
        upcomingQueueEntryIds,
        sourceSelection: snapshot.sourceSelection ?? null,
        sessionId: incomingSession || state.sessionId,
        snapshotRevision: incomingSession === 0 ? state.snapshotRevision : incomingRevision,
        sourceGeneration: snapshot.sourceGeneration ?? state.sourceGeneration,
        lastSeekRevision,
        sampledAtMs: snapshot.sampledAtMs ?? 0,
        positionMs: isScrubbing ? state.positionMs : snapshot.positionMs,
        isScrubbing,
        scrubPosition: isScrubbing ? state.scrubPosition : snapshot.positionMs,
        scrubAwaitingAckFrom: isScrubbing ? state.scrubAwaitingAckFrom : null,
        volume: isVolumeScrubbing ? state.volume : snapshot.volume,
        isMuted: isVolumeScrubbing ? state.isMuted : snapshot.isMuted,
        isVolumeScrubbing,
        observedAtMs: now,
        timelineRevision: state.timelineRevision + (discontinuity ? 1 : 0),
      };
    }),
}));

export function useCurrentSong(): Song | null {
  return usePlayerStore((state) => state.queue[state.currentIndex] ?? null);
}

const UNIX_MS = 1_000_000_000_000;
const SAMPLE_FRESH_MS = 2_000;

export function getEstimatedPositionMs(now = performance.now(), nowUnix = Date.now()): number {
  const state = usePlayerStore.getState();
  const current = state.queue[state.currentIndex];
  if (!current) return 0;
  if (state.isScrubbing) return state.scrubPosition;
  let elapsed = 0;
  if (state.isPlaying) {
    if (
      state.sampledAtMs >= UNIX_MS &&
      nowUnix - state.sampledAtMs >= 0 &&
      nowUnix - state.sampledAtMs < SAMPLE_FRESH_MS
    ) {
      elapsed = nowUnix - state.sampledAtMs;
    } else {
      elapsed = Math.max(0, now - state.observedAtMs);
    }
  }
  return Math.min(state.playbackDurationMs ?? current.durationMs, state.positionMs + elapsed);
}
