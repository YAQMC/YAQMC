import type { AudioQualityPreference, EntityId, Song } from '../domain/music';
import type { PrimaryPlaybackMode } from './playback-mode';
import type { RepeatMode } from './player-store';

export type PlayerCommand =
  | { type: 'hydrateQueue'; tracks: Song[] }
  | { type: 'playTracks'; tracks: Song[]; startAtId?: EntityId; shuffle?: boolean }
  | { type: 'playFromQueue'; index: number }
  | { type: 'playQueueEntry'; entryId: string }
  | { type: 'playNextQueueEntry'; entryId: string }
  | { type: 'togglePlayback' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'seek'; positionMs: number }
  | { type: 'setVolume'; volume: number }
  | { type: 'toggleMuted' }
  | { type: 'toggleShuffle' }
  | { type: 'setShuffle'; enabled: boolean }
  | { type: 'setQuality'; quality: AudioQualityPreference }
  | { type: 'cycleRepeat' }
  | { type: 'setRepeat'; mode: RepeatMode }
  | { type: 'setPrimaryPlaybackMode'; mode: PrimaryPlaybackMode }
  | { type: 'addToQueue'; song: Song }
  | { type: 'addTracksToQueue'; tracks: Song[] }
  | { type: 'removeFromQueue'; index: number }
  | { type: 'removeQueueEntry'; entryId: string }
  | { type: 'reorderQueueEntry'; entryId: string; targetIndex: number };

export type PlayerCommandAdapter = (command: PlayerCommand) => Promise<void>;

let activeAdapter: PlayerCommandAdapter | null = null;

export function setPlayerCommandAdapter(adapter: PlayerCommandAdapter | null): void {
  activeAdapter = adapter;
}

export function dispatchPlayerCommand(command: PlayerCommand): boolean {
  if (!activeAdapter) return false;
  void activeAdapter(command).catch((error: unknown) => {
    console.error('Native player command failed', error);
  });
  return true;
}
