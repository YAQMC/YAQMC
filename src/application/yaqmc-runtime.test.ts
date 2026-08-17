import { afterEach, describe, expect, it, vi } from 'vitest';
import { READY_QUEUE_TIMEOUT_MS } from '@yaqmc/client';

const hostMocks = vi.hoisted(() => {
  const snapshot = {
    queue: [],
    queueEntries: [],
    currentIndex: null,
    currentQueueEntryId: null,
    positionMs: 0,
    isPlaying: false,
    volume: 0.72,
    isMuted: false,
    repeat: 'off' as const,
    playbackOrder: 'sequential' as const,
    shuffle: false,
    shuffleTraversal: [],
    shuffleCursor: 0,
    playbackHistory: [],
    historyCursor: 0,
    upcomingQueueEntryIds: [],
    playbackState: 'paused' as const,
    playbackDurationMs: 0,
  };
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    kind: 'tauri' as 'electron' | 'tauri' | 'fake',
    snapshot,
    listeners,
    coreStatus: { status: 'down' as 'down' | 'ready' | 'restarting' | 'safe-mode' },
    invoke: vi.fn(async (method: string) => {
      if (method === 'host.coreStatus') {
        return hostMocks.coreStatus;
      }
      return snapshot;
    }),
    listen: vi.fn((channel: string, handler: (payload: unknown) => void) => {
      const bucket = listeners.get(channel) ?? new Set<(payload: unknown) => void>();
      bucket.add(handler);
      listeners.set(channel, bucket);
      return () => {
        bucket.delete(handler);
      };
    }),
    emit(channel: string, payload: unknown) {
      for (const handler of listeners.get(channel) ?? []) {
        handler(payload);
      }
    },
  };
});

vi.mock('./tauri-host-bridge', () => ({
  selectHostBridge: () => ({
    kind: hostMocks.kind,
    windowRole: 'main' as const,
    window: {
      minimize: async () => undefined,
      toggleMaximize: async () => undefined,
      close: async () => undefined,
      setFullscreen: async () => undefined,
    },
    shell: {
      openExternal: async () => undefined,
    },
    invoke: hostMocks.invoke,
    listen: hostMocks.listen,
  }),
}));

async function loadRuntime() {
  vi.resetModules();
  return import('./yaqmc-runtime');
}

describe('yaqmc runtime singleton', () => {
  afterEach(() => {
    vi.useRealTimers();
    hostMocks.kind = 'tauri';
    hostMocks.coreStatus = { status: 'down' };
    hostMocks.listeners.clear();
    hostMocks.invoke.mockClear();
    hostMocks.listen.mockClear();
  });

  it('returns the same client and bridge on repeated calls', async () => {
    const { getHostBridge, getYaqmcClient } = await loadRuntime();
    expect(getHostBridge()).toBe(getHostBridge());
    expect(getYaqmcClient()).toBe(getYaqmcClient());
    expect(getYaqmcClient().bridge).toBe(getHostBridge());
  });

  it.each(['tauri', 'fake'] as const)('marks %s ready immediately so invoke does not stall', async (kind) => {
    hostMocks.kind = kind;
    const { getYaqmcClient } = await loadRuntime();
    await expect(getYaqmcClient().player.snapshot()).resolves.toMatchObject({ queue: [] });
    expect(hostMocks.invoke).toHaveBeenCalledWith('player_snapshot');
  });

  it('marks electron ready from host.coreStatus probe so invoke does not stall', async () => {
    hostMocks.kind = 'electron';
    hostMocks.coreStatus = { status: 'ready' };
    const { getYaqmcClient } = await loadRuntime();
    await expect(getYaqmcClient().player.snapshot()).resolves.toMatchObject({ queue: [] });
    expect(hostMocks.invoke).toHaveBeenCalledWith('host.coreStatus');
    expect(hostMocks.invoke).toHaveBeenCalledWith('player_snapshot');
  });

  it('marks electron ready from host://core-status when the probe missed ready', async () => {
    hostMocks.kind = 'electron';
    hostMocks.coreStatus = { status: 'down' };
    const { getYaqmcClient } = await loadRuntime();
    const client = getYaqmcClient();
    await vi.waitFor(() => {
      expect(hostMocks.invoke).toHaveBeenCalledWith('host.coreStatus');
    });
    await Promise.resolve();
    const pending = client.player.snapshot();
    expect(hostMocks.invoke).not.toHaveBeenCalledWith('player_snapshot');
    hostMocks.emit('host://core-status', { status: 'ready' });
    await expect(pending).resolves.toMatchObject({ queue: [] });
    expect(hostMocks.invoke).toHaveBeenCalledWith('player_snapshot');
  });

  it('keeps electron invoke queued until ready when core is down', async () => {
    vi.useFakeTimers();
    hostMocks.kind = 'electron';
    hostMocks.coreStatus = { status: 'down' };
    const { getYaqmcClient } = await loadRuntime();
    const pending = getYaqmcClient().player.snapshot();
    await Promise.resolve();
    expect(hostMocks.invoke).toHaveBeenCalledWith('host.coreStatus');
    expect(hostMocks.invoke).not.toHaveBeenCalledWith('player_snapshot');
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'core.unavailable',
      name: 'CoreUnavailableError',
    });
    await vi.advanceTimersByTimeAsync(READY_QUEUE_TIMEOUT_MS);
    await assertion;
    expect(hostMocks.invoke).not.toHaveBeenCalledWith('player_snapshot');
  });
});
