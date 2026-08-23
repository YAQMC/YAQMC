import { describe, expect, it, vi } from 'vitest';
import { CoreUnavailableError, READY_QUEUE_TIMEOUT_MS, YaqmcClient } from './client';
import type { HostBridge } from './bridge';
import type { MethodName, MethodResult } from './protocol/methods';
import type { ChannelName, ChannelPayload } from './protocol/events';
import type { PlayerSnapshot } from './protocol/dto';

function snapshot(): PlayerSnapshot {
  return {
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
  };
}

function testBridge(invoked: Array<{ method: MethodName; params: unknown }> = []): HostBridge {
  const handlers = new Map<ChannelName, Set<(payload: never) => void>>();
  return {
    kind: 'fake',
    windowRole: 'main',
    window: {
      minimize: async () => undefined,
      toggleMaximize: async () => undefined,
      close: async () => undefined,
      setFullscreen: async () => undefined,
    },
    shell: {
      openExternal: async () => undefined,
    },
    invoke: async (method, ...params) => {
      invoked.push({ method, params: params[0] });
      if (method === 'player_snapshot') return snapshot() as MethodResult[typeof method];
      if (method === 'lyrics_surface_projection') {
        return {
          timestampMs: 1,
          currentTrack: null,
          positionMs: 0,
          isPlaying: false,
          playbackState: 'paused',
          playbackDurationMs: 0,
          syncMode: null,
          lineIndex: null,
          wordIndex: null,
          currentLine: null,
          nextLine: null,
        } as MethodResult[typeof method];
      }
      if (method === 'player_lyrics') return null as MethodResult[typeof method];
      if (method === 'app_preferences_get') return null as MethodResult[typeof method];
      if (method === 'plugin_list') return [] as MethodResult[typeof method];
      if (method === 'player_seek') return snapshot() as MethodResult[typeof method];
      return undefined as MethodResult[typeof method];
    },
    listen: (channel, handler) => {
      const bucket = handlers.get(channel) ?? new Set();
      bucket.add(handler as (payload: never) => void);
      handlers.set(channel, bucket);
      return () => bucket.delete(handler as (payload: never) => void);
    },
  };
}

describe('YaqmcClient', () => {
  it('exposes song and artist catalog detail invokes', async () => {
    const invoked: Array<{ method: MethodName; params: unknown }> = [];
    const client = new YaqmcClient(testBridge(invoked));
    client.markReady();

    await client.catalog.song('qqmusic:track:mid');
    await client.catalog.artist('qqmusic:artist:mid');

    expect(invoked).toEqual([
      { method: 'qqmusic_song', params: { id: 'qqmusic:track:mid' } },
      { method: 'qqmusic_artist', params: { id: 'qqmusic:artist:mid' } },
    ]);
    client.dispose();
  });

  it('sends the typed catalog search kind in the native payload', async () => {
    const invoked: Array<{ method: MethodName; params: unknown }> = [];
    const client = new YaqmcClient(testBridge(invoked));
    client.markReady();

    await client.catalog.search('MIRA', 'artist', 2, 8);

    expect(invoked).toContainEqual({
      method: 'qqmusic_search',
      params: { query: 'MIRA', kind: 'artist', page: 2, limit: 8 },
    });
    client.dispose();
  });

  it('queues invokes until markReady', async () => {
    const invoked: Array<{ method: MethodName; params: unknown }> = [];
    const client = new YaqmcClient(testBridge(invoked));
    const pending = client.player.seek(4800);
    expect(invoked).toEqual([]);
    client.markReady();
    await pending;
    expect(invoked).toEqual([{ method: 'player_seek', params: { positionMs: 4800 } }]);
    client.dispose();
  });

  it('rejects queued invokes as core.unavailable after 15s', async () => {
    vi.useFakeTimers();
    const client = new YaqmcClient(testBridge());
    const pending = client.invoke('player_snapshot');
    const assertion = expect(pending).rejects.toBeInstanceOf(CoreUnavailableError);
    await vi.advanceTimersByTimeAsync(READY_QUEUE_TIMEOUT_MS);
    await assertion;
    vi.useRealTimers();
    client.dispose();
  });

  it('fans host events to on() subscribers', async () => {
    const handlers = new Map<string, Array<(payload: unknown) => void>>();
    const bridge = testBridge();
    bridge.listen = (channel, handler) => {
      const list = handlers.get(channel) ?? [];
      list.push(handler as (payload: unknown) => void);
      handlers.set(channel, list);
      return () => undefined;
    };
    const client = new YaqmcClient(bridge);
    const seen: ChannelPayload['player://snapshot'][] = [];
    client.on('player://snapshot', (payload) => {
      seen.push(payload);
    });
    const payload = snapshot();
    for (const handler of handlers.get('player://snapshot') ?? []) handler(payload);
    expect(seen).toEqual([payload]);
    client.dispose();
  });

  it('resync pulls the §14.5 snapshot set and re-emits player/lyrics channels', async () => {
    const invoked: Array<{ method: MethodName; params: unknown }> = [];
    const client = new YaqmcClient(testBridge(invoked));
    client.markReady();
    const seen: string[] = [];
    client.on('player://snapshot', () => seen.push('player://snapshot'));
    client.on('lyrics://projection', () => seen.push('lyrics://projection'));
    const pulled = await client.resync();
    expect(pulled.plugins).toEqual([]);
    expect(invoked.map((entry) => entry.method).sort()).toEqual([
      'app_preferences_get',
      'lyrics_surface_projection',
      'player_lyrics',
      'player_snapshot',
      'plugin_list',
    ]);
    expect(seen).toEqual(['player://snapshot', 'lyrics://projection']);
    client.dispose();
  });
});
