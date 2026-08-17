import { afterEach, describe, expect, it, vi } from 'vitest';
import { READY_QUEUE_TIMEOUT_MS } from '@yaqmc/client';

const hostMocks = vi.hoisted(() => ({
  kind: 'tauri' as 'electron' | 'tauri' | 'fake',
  invoke: vi.fn(async () => ({
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
  })),
}));

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
    listen: () => () => undefined,
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
    hostMocks.invoke.mockClear();
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

  it('does not markReady for electron; queued invoke times out as core.unavailable', async () => {
    vi.useFakeTimers();
    hostMocks.kind = 'electron';
    const { getYaqmcClient } = await loadRuntime();
    const pending = getYaqmcClient().player.snapshot();
    expect(hostMocks.invoke).not.toHaveBeenCalled();
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'core.unavailable',
      name: 'CoreUnavailableError',
    });
    await vi.advanceTimersByTimeAsync(READY_QUEUE_TIMEOUT_MS);
    await assertion;
    expect(hostMocks.invoke).not.toHaveBeenCalled();
  });
});
