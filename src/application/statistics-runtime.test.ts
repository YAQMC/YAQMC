import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostBridge, StatisticsRange, StatisticsSnapshot } from '@yaqmc/client';

const runtimeMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, (payload: unknown) => void>(),
}));

vi.mock('./yaqmc-runtime', async () => {
  const { YaqmcClient } = await import('@yaqmc/client');
  const bridge = {
    kind: 'electron' as const,
    windowRole: 'main' as const,
    window: {
      minimize: async () => undefined,
      toggleMaximize: async () => undefined,
      close: async () => undefined,
      setFullscreen: async () => undefined,
    },
    shell: { openExternal: async () => undefined },
    dialog: { pickSave: async () => null, pickFile: async () => null },
    invoke: runtimeMocks.invoke,
    listen: (channel: string, handler: (payload: unknown) => void) => {
      runtimeMocks.handlers.set(channel, handler);
      return () => runtimeMocks.handlers.delete(channel);
    },
  };
  const client = new YaqmcClient(bridge as HostBridge);
  client.markReady();
  return { getYaqmcClient: () => client };
});

import { useStatisticsRuntime } from './statistics-runtime';

function snapshot(range: StatisticsRange, plays: number): StatisticsSnapshot {
  return {
    range,
    fromMs: 0,
    toMs: 1,
    qualifiedListeningMs: plays * 1_000,
    qualifiedPlayCount: plays,
    completedCount: plays,
    skippedCount: 0,
    skipRate: 0,
    recordCount: plays,
    databaseBytes: 1,
    topSongs: [],
    topArtists: [],
    topAlbums: [],
    daily: [],
    qualities: [],
    providers: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe('useStatisticsRuntime', () => {
  beforeEach(() => {
    runtimeMocks.invoke.mockReset();
  });

  afterEach(() => vi.useRealTimers());

  it('loads the selected range and ignores an older range response', async () => {
    const oldRequest = deferred<StatisticsSnapshot>();
    runtimeMocks.invoke.mockImplementation(
      (method: string, params?: { range?: StatisticsRange }) => {
        if (method !== 'statistics_snapshot') throw new Error(`unexpected ${method}`);
        return params?.range === '7-days'
          ? oldRequest.promise
          : Promise.resolve(snapshot('30-days', 2));
      },
    );
    const { result, rerender } = renderHook(({ range }) => useStatisticsRuntime(range), {
      initialProps: { range: '7-days' as StatisticsRange },
    });

    rerender({ range: '30-days' });
    await waitFor(() => expect(result.current.resource.data?.qualifiedPlayCount).toBe(2));
    oldRequest.resolve(snapshot('7-days', 99));
    await act(async () => Promise.resolve());
    expect(result.current.resource.data?.range).toBe('30-days');
  });

  it('coalesces statistics.changed revisions into one quiet refresh', async () => {
    vi.useFakeTimers();
    runtimeMocks.invoke.mockResolvedValue(snapshot('30-days', 1));
    const { result } = renderHook(() => useStatisticsRuntime('30-days'));
    await act(async () => Promise.resolve());
    expect(result.current.resource.status).toBe('ready');
    runtimeMocks.invoke.mockClear();

    const emit = runtimeMocks.handlers.get('api://event');
    const event = (revision: number) => ({
      version: 1,
      type: 'statistics.changed',
      timestampMs: revision,
      data: { revision },
    });
    act(() => {
      emit?.(event(1));
      emit?.(event(2));
      vi.advanceTimersByTime(250);
    });
    await act(async () => Promise.resolve());
    expect(runtimeMocks.invoke).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.invoke).toHaveBeenCalledWith('statistics_snapshot', { range: '30-days' });
  });

  it('clears statistics and refreshes the active range', async () => {
    runtimeMocks.invoke.mockImplementation((method: string) => {
      if (method === 'statistics_clear')
        return Promise.resolve({ deletedSessions: 3, revision: 4 });
      if (method === 'statistics_snapshot') return Promise.resolve(snapshot('all-time', 0));
      throw new Error(`unexpected ${method}`);
    });
    const { result } = renderHook(() => useStatisticsRuntime('all-time'));
    await waitFor(() => expect(result.current.resource.status).toBe('ready'));
    runtimeMocks.invoke.mockClear();

    await act(async () => {
      await result.current.clear();
    });
    expect(runtimeMocks.invoke.mock.calls).toEqual([
      ['statistics_clear'],
      ['statistics_snapshot', { range: 'all-time' }],
    ]);
  });
});
