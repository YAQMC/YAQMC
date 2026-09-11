// @ts-expect-error Vitest runs in Node; the renderer tsconfig does not include Node types.
import { readFileSync } from 'node:fs';
// @ts-expect-error Vitest runs in Node; the renderer tsconfig does not include Node types.
import path from 'node:path';
// @ts-expect-error Vitest runs in Node; the renderer tsconfig does not include Node types.
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import {
  applyPluginResources,
  broadcastPluginEvent,
  dispatchPluginUiAction,
  PLUGIN_EVENT_PERMISSIONS,
  setPluginEnabled,
  usePluginHost,
} from './plugin-runtime';
import { usePlayerStore } from './player-store';

const invokeMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.hoisted(() => vi.fn());

vi.mock('./logger', () => ({ logger: { error: logErrorMock } }));

vi.mock('./yaqmc-runtime', () => ({
  getHostBridge: () => ({ kind: 'electron' }),
  getYaqmcClient: () => ({
    invoke: invokeMock,
    on: vi.fn(() => () => undefined),
  }),
}));

vi.mock('./native-player-runtime', () => ({ isNativeRuntime: true }));

type PostedMessage = { type?: string; event?: string; payload?: unknown };

class FakeWorker {
  static instances: FakeWorker[] = [];

  posted: PostedMessage[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeWorker.instances.push(this);
  }

  postMessage(message: PostedMessage): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }
}

const GRANTED = 'dev.yaqmc.test.granted';
const UNGRANTED = 'dev.yaqmc.test.ungranted';

let grants: Record<string, string[]> = {};
let grantsUnavailable = false;

function emptyResources(safeMode = false) {
  return {
    safeMode,
    developerMode: false,
    styleOrder: [] as string[],
    styles: [] as unknown[],
    scenes: [] as unknown[],
    scripts: [] as unknown[],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function postedEvents(worker: FakeWorker): string[] {
  return worker.posted
    .filter((message) => message.type === 'yaqmc/event')
    .map((message) => message.event ?? '');
}

function instanceAt(index: number): FakeWorker {
  const worker = FakeWorker.instances[index];
  if (!worker) throw new Error(`missing fake plugin worker at index ${index}`);
  return worker;
}

function installHostMock(): void {
  invokeMock.mockImplementation((method: string) => {
    if (method === 'plugin_active_resources') {
      return Promise.resolve({
        safeMode: false,
        developerMode: false,
        styleOrder: [],
        styles: [],
        scenes: [],
        scripts: [
          { pluginId: GRANTED, pluginName: GRANTED, source: 'definePlugin({});' },
          { pluginId: UNGRANTED, pluginName: UNGRANTED, source: 'definePlugin({});' },
        ],
      });
    }
    if (method === 'plugin_list') {
      if (grantsUnavailable) return Promise.reject(new Error('credential store unavailable'));
      return Promise.resolve(
        Object.entries(grants).map(([id, grantedPermissions]) => ({
          id,
          grantedPermissions,
        })),
      );
    }
    if (method === 'plugin_runtime_start') return Promise.resolve('runtime-token');
    return Promise.resolve(undefined);
  });
}

function trackState(index: number, sessionId: number) {
  const track = {
    id: `track-${sessionId}`,
    title: `Track ${sessionId}`,
    artists: [{ id: 'artist-1', name: 'Artist' }],
    album: { id: 'album-1', title: 'Album' },
  };
  return {
    queue: [track as never],
    currentIndex: index,
    currentQueueEntryId: `entry-${sessionId}`,
    isPlaying: true,
    sessionId,
    positionMs: sessionId * 1_000,
    playbackDurationMs: 2_000,
  };
}

describe('PLUG-07 plugin event fan-out permissions', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    grants = {};
    grantsUnavailable = false;
    vi.stubGlobal('Worker', FakeWorker);
    URL.createObjectURL = () => 'blob:yaqmc-plugin';
    URL.revokeObjectURL = () => undefined;
    installHostMock();
  });

  afterEach(() => {
    // Unmount before the bridge mock is reset: cleanup must keep observing the
    // same host contract that live code sees.
    cleanup();
    vi.unstubAllGlobals();
    invokeMock.mockReset();
    logErrorMock.mockReset();
  });

  it('declares a permission for every broadcast site in the runtime source', () => {
    const source = readFileSync(
      path.join(
        path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),
        'src',
        'application',
        'plugin-runtime.ts',
      ),
      'utf8',
    );
    const broadcasts = [...source.matchAll(/emitToPlugins\(\s*'([^']+)'/gu)].map(
      (match) => match[1],
    );
    expect(broadcasts.length).toBeGreaterThan(0);
    for (const event of broadcasts) {
      expect(Object.hasOwn(PLUGIN_EVENT_PERMISSIONS, event)).toBe(true);
    }
    expect(PLUGIN_EVENT_PERMISSIONS['track.changed']).toBe('track.read');
    expect(PLUGIN_EVENT_PERMISSIONS['playback.stateChanged']).toBe('player.read');
    expect(PLUGIN_EVENT_PERMISSIONS['playback.position']).toBe('player.read');
    expect(PLUGIN_EVENT_PERMISSIONS['queue.changed']).toBe('player.read');
    expect(PLUGIN_EVENT_PERMISSIONS['lyrics.lineChanged']).toBe('lyrics.read');
  });

  it('delivers read-only events only to plugins holding the matching grant', async () => {
    grants = {
      [GRANTED]: ['track.read', 'player.read', 'lyrics.read'],
      [UNGRANTED]: [],
    };

    const { unmount } = renderHook(() => usePluginHost());
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
    const granted = instanceAt(0);
    const ungranted = instanceAt(1);

    usePlayerStore.setState(trackState(0, 1) as never);

    await waitFor(() => expect(postedEvents(granted)).toContain('track.changed'));

    const delivered = postedEvents(granted);
    expect(delivered).toContain('playback.stateChanged');
    expect(delivered).toContain('queue.changed');
    expect(delivered).toContain('lyrics.lineChanged');
    expect(postedEvents(ungranted)).toEqual([]);

    unmount();
  });

  it('never broadcasts events that have no declared permission', async () => {
    grants = { [GRANTED]: ['track.read', 'player.read', 'lyrics.read'] };
    const { unmount } = renderHook(() => usePluginHost());
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(2));

    expect(broadcastPluginEvent('plugin.undeclared', { secret: 'value' })).toBe(false);

    for (const worker of FakeWorker.instances) {
      expect(postedEvents(worker)).not.toContain('plugin.undeclared');
    }
    expect(logErrorMock).toHaveBeenCalledWith(
      'plugin.runtime.unknown_event',
      expect.stringContaining('plugin.undeclared'),
    );

    unmount();
  });

  it('fails closed when the host cannot report granted permissions', async () => {
    grantsUnavailable = true;
    const { unmount } = renderHook(() => usePluginHost());
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(2));

    usePlayerStore.setState(trackState(0, 2) as never);
    await new Promise((resolve) => setTimeout(resolve, 50));

    for (const worker of FakeWorker.instances) {
      expect(postedEvents(worker)).toEqual([]);
    }
    expect(logErrorMock).toHaveBeenCalledWith('plugin.permissions.load_failed', expect.anything());

    unmount();
  });

  it('stops delivering after a grant is revoked and retires the old runtime', async () => {
    grants = { [GRANTED]: ['track.read', 'player.read', 'lyrics.read'] };
    const { unmount } = renderHook(() => usePluginHost());
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
    const firstGranted = instanceAt(0);

    usePlayerStore.setState(trackState(0, 3) as never);
    await waitFor(() => expect(postedEvents(firstGranted)).toContain('track.changed'));

    grants = {};
    await setPluginEnabled(GRANTED, true, []);
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(4));

    expect(firstGranted.terminated).toBe(true);
    const restartedGranted = instanceAt(2);
    expect(restartedGranted).not.toBe(firstGranted);

    const retiredDeliveries = postedEvents(firstGranted).length;
    usePlayerStore.setState(trackState(0, 4) as never);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(postedEvents(restartedGranted)).not.toContain('track.changed');
    // The retired runtime must not receive anything new after revocation.
    expect(postedEvents(firstGranted)).toHaveLength(retiredDeliveries);

    unmount();
  });

  it('coalesces refreshes and never applies an obsolete resource snapshot', async () => {
    const firstResources = deferred<ReturnType<typeof emptyResources>>();
    const latestResources = deferred<ReturnType<typeof emptyResources>>();
    let resourceCalls = 0;
    invokeMock.mockImplementation((method: string) => {
      if (method === 'plugin_active_resources') {
        resourceCalls += 1;
        return resourceCalls === 1 ? firstResources.promise : latestResources.promise;
      }
      if (method === 'plugin_list') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    const firstRefresh = applyPluginResources();
    await waitFor(() => expect(resourceCalls).toBe(1));
    const secondRefresh = applyPluginResources();
    expect(secondRefresh).toBe(firstRefresh);

    firstResources.resolve({
      ...emptyResources(),
      styles: [{ pluginId: 'obsolete', css: '[data-obsolete]{}' }],
    });
    await waitFor(() => expect(resourceCalls).toBe(2));
    latestResources.resolve(emptyResources());

    await expect(firstRefresh).resolves.toEqual(emptyResources());
    expect(document.querySelector('[data-yaqmc-plugin-style="obsolete"]')).toBeNull();
  });

  it('drops an in-flight bridge result after the runtime is revoked', async () => {
    const bridgeResult = deferred<{ ok: boolean }>();
    let resources = {
      safeMode: false,
      developerMode: false,
      styleOrder: [] as string[],
      styles: [],
      scenes: [],
      scripts: [{ pluginId: GRANTED, pluginName: GRANTED, source: 'definePlugin({});' }],
    };
    invokeMock.mockImplementation((method: string) => {
      if (method === 'plugin_active_resources') return Promise.resolve(resources);
      if (method === 'plugin_list') {
        return Promise.resolve([{ id: GRANTED, grantedPermissions: ['player.control'] }]);
      }
      if (method === 'plugin_runtime_start') return Promise.resolve('revocable-token');
      if (method === 'plugin_runtime_stop') return Promise.resolve(undefined);
      if (method === 'plugin_bridge') return bridgeResult.promise;
      return Promise.resolve(undefined);
    });

    await applyPluginResources();
    const worker = instanceAt(FakeWorker.instances.length - 1);
    worker.onmessage?.({
      data: { type: 'yaqmc/call', id: 'in-flight', method: 'player.play', payload: {} },
    } as MessageEvent);

    resources = {
      safeMode: false,
      developerMode: false,
      styleOrder: [],
      styles: [],
      scenes: [],
      scripts: [],
    };
    const refresh = applyPluginResources();
    bridgeResult.resolve({ ok: true });
    await refresh;
    await Promise.resolve();

    expect(worker.terminated).toBe(true);
    expect(worker.posted).not.toContainEqual(
      expect.objectContaining({ id: 'in-flight', type: 'yaqmc/result' }),
    );
  });

  it('keeps control messages addressed to one runtime instead of fanning out', async () => {
    grants = { [GRANTED]: [] };
    const { unmount } = renderHook(() => usePluginHost());
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(2));

    dispatchPluginUiAction(GRANTED, 'refresh', 'toolbar');

    const controlMessages = (worker: FakeWorker) =>
      worker.posted.filter((message) => message.type === 'yaqmc/event');
    expect(controlMessages(instanceAt(0))).toEqual([
      { type: 'yaqmc/event', event: 'ui.action', payload: { id: 'refresh', slot: 'toolbar' } },
    ]);
    expect(controlMessages(instanceAt(1))).toEqual([]);

    unmount();
  });
});
