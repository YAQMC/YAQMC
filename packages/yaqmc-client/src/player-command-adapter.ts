import type {
  AudioQualityPreference,
  EntityId,
  PrimaryPlaybackMode,
  RepeatMode,
  Song,
} from './protocol/dto';

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
let pendingSeekMs: number | null = null;
let seekFlush: Promise<void> | null = null;

async function flushSeekMailbox(): Promise<void> {
  try {
    while (pendingSeekMs !== null && activeAdapter) {
      const positionMs = pendingSeekMs;
      pendingSeekMs = null;
      const started = performance.now();
      await activeAdapter({ type: 'seek', positionMs });
      console.debug('player.seek.hop', {
        positionMs,
        clientRpcMs: Math.round(performance.now() - started),
      });
    }
  } finally {
    seekFlush = null;
    if (pendingSeekMs !== null && activeAdapter) {
      seekFlush = flushSeekMailbox().catch((error: unknown) => {
        console.error('Native player command failed', error);
      });
    }
  }
}

export function setPlayerCommandAdapter(adapter: PlayerCommandAdapter | null): void {
  activeAdapter = adapter;
  if (!adapter) pendingSeekMs = null;
}

export function dispatchPlayerCommand(command: PlayerCommand): boolean {
  if (!activeAdapter) return false;
  if (command.type === 'seek') {
    pendingSeekMs = command.positionMs;
    seekFlush ??= flushSeekMailbox().catch((error: unknown) => {
      console.error('Native player command failed', error);
    });
    return true;
  }
  pendingSeekMs = null;
  void activeAdapter(command).catch((error: unknown) => {
    console.error('Native player command failed', error);
  });
  return true;
}
