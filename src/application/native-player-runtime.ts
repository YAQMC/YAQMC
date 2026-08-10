import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEffect } from 'react';
import type { Song } from '../domain/music';
import { setPlayerCommandAdapter, type PlayerCommand } from './player-command-adapter';
import {
  usePlayerStore,
  type AuthoritativePlayerSnapshot,
  type PlaybackFailure,
  type PlaybackState,
  type RepeatMode,
} from './player-store';

interface NativePlayerSnapshot {
  queue: Song[];
  currentIndex: number | null;
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

export const isNativeRuntime = isTauri();

function toAuthoritativeSnapshot(snapshot: NativePlayerSnapshot): AuthoritativePlayerSnapshot {
  return { ...snapshot, currentIndex: snapshot.currentIndex ?? -1 };
}

async function invokePlayerCommand(command: PlayerCommand): Promise<void> {
  switch (command.type) {
    case 'hydrateQueue':
      await invoke('player_hydrate_queue', { tracks: command.tracks });
      return;
    case 'playTracks':
      await invoke('player_play_tracks', {
        request: { tracks: command.tracks, startAtId: command.startAtId ?? null },
      });
      return;
    case 'playFromQueue':
      await invoke('player_play_from_queue', { index: command.index });
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
    case 'cycleRepeat':
      await invoke('player_cycle_repeat');
      return;
    case 'addToQueue':
      await invoke('player_add_to_queue', { track: command.song });
      return;
    case 'removeFromQueue':
      await invoke('player_remove_from_queue', { index: command.index });
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
