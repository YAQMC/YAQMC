import type {
  HostBridge,
  HostDialogBridge,
  HostShellBridge,
  HostWindowBridge,
  WindowRole,
} from '../bridge';
import { CHANNEL_PLAYER_SNAPSHOT, type ChannelName, type ChannelPayload } from '../protocol/events';
import type { HomeFeed, PlayerSnapshot, PlayTracksRequest, Song } from '../protocol/dto';
import type { MethodName, MethodParams, MethodResult } from '../protocol/methods';

export interface FakeCatalog {
  getHome(refresh?: boolean): Promise<HomeFeed>;
}

const emptySnapshot = (): PlayerSnapshot => ({
  queue: [],
  queueEntries: [],
  currentIndex: null,
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
  playbackState: 'paused',
  playbackDurationMs: 0,
});

function noopWindow(): HostWindowBridge {
  return {
    minimize: async () => undefined,
    toggleMaximize: async () => undefined,
    close: async () => undefined,
    setFullscreen: async () => undefined,
  };
}

function noopShell(): HostShellBridge {
  return {
    openExternal: async () => undefined,
  };
}

function unusedDialog(): HostDialogBridge {
  return {
    pickSave: async () => null,
    pickFile: async () => null,
  };
}

export function createFakeBridge(options?: {
  catalog?: FakeCatalog;
  windowRole?: WindowRole;
}): HostBridge {
  let snapshot = emptySnapshot();
  const listeners = new Map<ChannelName, Set<(payload: never) => void>>();

  function emit<C extends ChannelName>(channel: C, payload: ChannelPayload[C]): void {
    for (const handler of listeners.get(channel) ?? []) {
      (handler as (payload: ChannelPayload[C]) => void)(payload);
    }
  }

  function publish(): PlayerSnapshot {
    emit(CHANNEL_PLAYER_SNAPSHOT, snapshot);
    return snapshot;
  }

  function hydrate(tracks: Song[]): PlayerSnapshot {
    snapshot = {
      ...snapshot,
      queue: tracks,
      queueEntries: tracks.map((track, index) => ({ id: `entry-${index}`, track })),
      currentIndex: tracks.length > 0 ? 0 : null,
      currentQueueEntryId: tracks.length > 0 ? 'entry-0' : null,
      upcomingQueueEntryIds: tracks.map((_, index) => `entry-${index}`),
      playbackDurationMs: tracks[0]?.durationMs ?? 0,
      playbackState: 'paused',
      isPlaying: false,
      positionMs: 0,
    };
    return publish();
  }

  async function invoke<M extends MethodName>(
    method: M,
    ...params: MethodParams[M] extends void ? [] : [MethodParams[M]]
  ): Promise<MethodResult[M]> {
    const args = params[0];
    switch (method) {
      case 'player_snapshot':
        return snapshot as MethodResult[M];
      case 'player_hydrate_queue':
        return hydrate((args as MethodParams['player_hydrate_queue']).tracks) as MethodResult[M];
      case 'player_play_tracks': {
        const request = (args as MethodParams['player_play_tracks']).request as PlayTracksRequest;
        hydrate(request.tracks);
        snapshot = { ...snapshot, isPlaying: true, playbackState: 'playing' };
        return publish() as MethodResult[M];
      }
      case 'player_play':
      case 'player_toggle':
        snapshot = {
          ...snapshot,
          isPlaying: method === 'player_play' ? true : !snapshot.isPlaying,
          playbackState: method === 'player_play' || !snapshot.isPlaying ? 'playing' : 'paused',
        };
        return publish() as MethodResult[M];
      case 'player_pause':
        snapshot = { ...snapshot, isPlaying: false, playbackState: 'paused' };
        return publish() as MethodResult[M];
      case 'player_seek':
        snapshot = {
          ...snapshot,
          positionMs: (args as MethodParams['player_seek']).positionMs,
        };
        return publish() as MethodResult[M];
      case 'player_set_volume':
        snapshot = { ...snapshot, volume: (args as MethodParams['player_set_volume']).volume };
        return publish() as MethodResult[M];
      case 'qqmusic_home': {
        if (!options?.catalog) {
          throw new Error('Fake catalog is not attached');
        }
        const refresh = (args as MethodParams['qqmusic_home']).refresh;
        return (await options.catalog.getHome(refresh)) as MethodResult[M];
      }
      case 'core_ping':
        return { ok: true } as MethodResult[M];
      default:
        throw new Error(`${method} is not implemented on the fake bridge`);
    }
  }

  return {
    kind: 'fake',
    windowRole: options?.windowRole ?? 'main',
    window: noopWindow(),
    shell: noopShell(),
    dialog: unusedDialog(),
    invoke,
    listen: (channel, handler) => {
      const bucket = listeners.get(channel) ?? new Set();
      bucket.add(handler as (payload: never) => void);
      listeners.set(channel, bucket);
      return () => bucket.delete(handler as (payload: never) => void);
    },
  };
}
