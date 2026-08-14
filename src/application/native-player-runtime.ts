import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEffect } from 'react';
import type { PlaybackSourceSelection, Song } from '../domain/music';
import { setPlayerCommandAdapter, type PlayerCommand } from './player-command-adapter';
import {
  usePlayerStore,
  type AuthoritativePlayerSnapshot,
  type PlaybackFailure,
  type PlaybackOrder,
  type PlaybackState,
  type QueueEntry,
  type RepeatMode,
} from './player-store';

interface NativePlayerSnapshot {
  queue: Song[];
  queueEntries: QueueEntry[];
  currentIndex: number | null;
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
  sourceSelection?: PlaybackSourceSelection | null;
}

export const isNativeRuntime = isTauri();

function toAuthoritativeSnapshot(snapshot: NativePlayerSnapshot): AuthoritativePlayerSnapshot {
  return {
    ...snapshot,
    currentIndex: snapshot.currentIndex ?? -1,
    sourceSelection: snapshot.sourceSelection ?? null,
  };
}

async function invokePlayerCommand(command: PlayerCommand): Promise<void> {
  switch (command.type) {
    case 'hydrateQueue':
      await invoke('player_hydrate_queue', { tracks: command.tracks });
      return;
    case 'playTracks':
      await invoke('player_play_tracks', {
        request: {
          tracks: command.tracks,
          startAtId: command.startAtId ?? null,
          shuffle: command.shuffle ?? null,
        },
      });
      return;
    case 'playFromQueue':
      await invoke('player_play_from_queue', { index: command.index });
      return;
    case 'playQueueEntry':
      await invoke('player_play_queue_entry', { entryId: command.entryId });
      return;
    case 'playNextQueueEntry':
      await invoke('player_play_next_queue_entry', { entryId: command.entryId });
      return;
    case 'togglePlayback':
      await invoke('player_toggle');
      return;
    case 'next':
      await invoke('player_next');
      return;
    case 'previous':
      await invoke('player_previous');
      return;
    case 'seek':
      await invoke('player_seek', { positionMs: command.positionMs });
      return;
    case 'setVolume':
      await invoke('player_set_volume', { volume: command.volume });
      return;
    case 'toggleMuted':
      await invoke('player_toggle_muted');
      return;
    case 'toggleShuffle':
      await invoke('player_toggle_shuffle');
      return;
    case 'setShuffle':
      await invoke('player_set_shuffle', { enabled: command.enabled });
      return;
    case 'setQuality':
      await invoke('qqmusic_set_current_quality', { quality: command.quality });
      return;
    case 'cycleRepeat':
      await invoke('player_cycle_repeat');
      return;
    case 'setRepeat':
      await invoke('player_set_repeat', { mode: command.mode });
      return;
    case 'setPrimaryPlaybackMode':
      await invoke('player_set_primary_playback_mode', { mode: command.mode });
      return;
    case 'addToQueue':
      await invoke('player_add_to_queue', { track: command.song });
      return;
    case 'addTracksToQueue':
      await invoke('player_add_tracks_to_queue', { tracks: command.tracks });
      return;
    case 'removeFromQueue':
      await invoke('player_remove_from_queue', { index: command.index });
      return;
    case 'removeQueueEntry':
      await invoke('player_remove_queue_entry', { entryId: command.entryId });
      return;
    case 'reorderQueueEntry':
      await invoke('player_reorder_queue_entry', {
        entryId: command.entryId,
        targetIndex: command.targetIndex,
      });
  }
}

export function useNativePlayerRuntime(): void {
  useEffect(() => {
    if (!isNativeRuntime) return;
    let active = true;
    let receivedSnapshotEvent = false;
    let unlisten: UnlistenFn | null = null;

    setPlayerCommandAdapter(invokePlayerCommand);

    void listen<NativePlayerSnapshot>('player://snapshot', (event) => {
      if (active) {
        receivedSnapshotEvent = true;
        usePlayerStore.getState().applyExternalSnapshot(toAuthoritativeSnapshot(event.payload));
      }
    })
      .then((stopListening) => {
        if (active) unlisten = stopListening;
        else stopListening();
      })
      .catch(() => undefined);

    void invoke<NativePlayerSnapshot>('player_snapshot')
      .then((snapshot) => {
        if (active && !receivedSnapshotEvent)
          usePlayerStore.getState().applyExternalSnapshot(toAuthoritativeSnapshot(snapshot));
      })
      .catch(() => undefined);

    return () => {
      active = false;
      unlisten?.();
      setPlayerCommandAdapter(null);
    };
  }, []);
}
