import { useEffect } from 'react';
import type { PlaybackSourceSelection, Song } from '../domain/music';
import { getHostBridge, getYaqmcClient } from './yaqmc-runtime';
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
  playbackError?: PlaybackFailure | null;
  sourceSelection?: PlaybackSourceSelection | null;
  sessionId?: number;
  snapshotRevision?: number;
  sourceGeneration?: number;
  lastSeekRevision?: number;
  sampledAtMs?: number;
}

export const isNativeRuntime = getHostBridge().kind !== 'fake';

function toAuthoritativeSnapshot(snapshot: NativePlayerSnapshot): AuthoritativePlayerSnapshot {
  return {
    ...snapshot,
    currentIndex: snapshot.currentIndex ?? -1,
    sourceSelection: snapshot.sourceSelection ?? null,
    playbackError: snapshot.playbackError ?? null,
  };
}

async function invokePlayerCommand(command: PlayerCommand): Promise<void> {
  const client = getYaqmcClient();
  switch (command.type) {
    case 'hydrateQueue':
      await client.player.hydrateQueue(command.tracks);
      return;
    case 'playTracks':
      await client.player.playTracks({
        tracks: command.tracks,
        startAtId: command.startAtId ?? null,
        shuffle: command.shuffle ?? null,
      });
      return;
    case 'playFromQueue':
      await client.player.playFromQueue(command.index);
      return;
    case 'playQueueEntry':
      await client.player.playQueueEntry(command.entryId);
      return;
    case 'playNextQueueEntry':
      await client.player.playNextQueueEntry(command.entryId);
      return;
    case 'togglePlayback':
      await client.player.toggle();
      return;
    case 'next':
      await client.player.next();
      return;
    case 'previous':
      await client.player.previous();
      return;
    case 'seek':
      await client.player.seek(command.positionMs);
      return;
    case 'setVolume':
      await client.player.setVolume(command.volume);
      return;
    case 'toggleMuted':
      await client.player.toggleMuted();
      return;
    case 'toggleShuffle':
      await client.player.toggleShuffle();
      return;
    case 'setShuffle':
      await client.player.setShuffle(command.enabled);
      return;
    case 'setQuality':
      await client.invoke('qqmusic_set_current_quality', { quality: command.quality });
      return;
    case 'cycleRepeat':
      await client.player.cycleRepeat();
      return;
    case 'setRepeat':
      await client.player.setRepeat(command.mode);
      return;
    case 'setPrimaryPlaybackMode':
      await client.player.setPrimaryPlaybackMode(command.mode);
      return;
    case 'addToQueue':
      await client.player.addToQueue(command.song);
      return;
    case 'addTracksToQueue':
      await client.player.addTracksToQueue(command.tracks);
      return;
    case 'removeFromQueue':
      await client.player.removeFromQueue(command.index);
      return;
    case 'removeQueueEntry':
      await client.player.removeQueueEntry(command.entryId);
      return;
    case 'reorderQueueEntry':
      await client.player.reorderQueueEntry(command.entryId, command.targetIndex);
  }
}

export function useNativePlayerRuntime(): void {
  useEffect(() => {
    if (!isNativeRuntime) return;
    let active = true;
    let receivedSnapshotEvent = false;
    const client = getYaqmcClient();

    setPlayerCommandAdapter(invokePlayerCommand);

    const unlisten = client.on('player://snapshot', (payload) => {
      if (active) {
        receivedSnapshotEvent = true;
        usePlayerStore.getState().applyExternalSnapshot(toAuthoritativeSnapshot(payload));
      }
    });

    void client.player
      .snapshot()
      .then((snapshot) => {
        if (active && !receivedSnapshotEvent)
          usePlayerStore.getState().applyExternalSnapshot(toAuthoritativeSnapshot(snapshot));
      })
      .catch(() => undefined);

    return () => {
      active = false;
      unlisten();
      setPlayerCommandAdapter(null);
    };
  }, []);
}
