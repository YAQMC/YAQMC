import { createElement } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostBridge } from '@yaqmc/client';
import type { Song } from '../domain/music';
import { initialPlayerState, usePlayerStore } from './player-store';

interface TestNativeSnapshot {
  queue: Song[];
  queueEntries?: Array<{ id: string; track: Song }>;
  currentIndex: number | null;
  currentQueueEntryId?: string | null;
  positionMs: number;
  isPlaying: boolean;
  volume: number;
  isMuted: boolean;
  repeat: 'off' | 'all' | 'one';
  playbackOrder?: 'sequential' | 'shuffle';
  shuffle: boolean;
  shuffleTraversal?: string[];
  shuffleCursor?: number;
  playbackHistory?: string[];
  historyCursor?: number;
  upcomingQueueEntryIds?: string[];
  playbackState: 'playing' | 'paused';
  playbackDurationMs: number | null;
  playbackError: null;
  sourceSelection?: {
    requestedQuality: 'automatic' | 'standard' | 'high' | 'lossless' | 'master';
    resolvedQuality: 'standard' | 'high' | 'lossless' | 'master';
    fallbackReason?: 'source-unavailable' | 'account-rights' | 'preview-only';
    preview: boolean;
  };
}

const nativeMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  unlisten: vi.fn(),
  snapshotHandler: null as ((payload: TestNativeSnapshot) => void) | null,
}));

vi.mock('./yaqmc-runtime', async () => {
  const { YaqmcClient } = await import('@yaqmc/client');
  const bridge = {
    kind: 'tauri' as const,
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
    invoke: nativeMocks.invoke,
    listen: (channel: string, handler: (payload: unknown) => void) => {
      if (channel === 'player://snapshot') {
        nativeMocks.snapshotHandler = handler as (payload: TestNativeSnapshot) => void;
      }
      return nativeMocks.unlisten;
    },
  };
  const client = new YaqmcClient(bridge as HostBridge);
  client.markReady();
  return {
    getHostBridge: () => bridge,
    getYaqmcClient: () => client,
  };
});

import { isNativeRuntime, useNativePlayerRuntime } from './native-player-runtime';

const track = (id: string): Song => ({
  id,
  title: id,
  artists: [{ id: 'artist', name: 'Artist' }],
  album: { id: 'album', title: 'Album' },
  artwork: { src: '/cover.svg', alt: 'Cover', dominantColor: '#000' },
  durationMs: 10_000,
  trackNumber: 1,
  isFavorite: false,
  quality: 'high',
  availability: { status: 'available' },
});

function snapshot(id: string, positionMs: number): TestNativeSnapshot {
  return {
    queue: [track(id)],
    currentIndex: 0,
    positionMs,
    isPlaying: true,
    volume: 0.72,
    isMuted: false,
    repeat: 'off',
    shuffle: false,
    playbackState: 'playing',
    playbackDurationMs: 10_000,
    playbackError: null,
  };
}

function RuntimeHarness() {
  useNativePlayerRuntime();
  return null;
}

describe('native player runtime', () => {
  beforeEach(() => {
    nativeMocks.invoke.mockReset();
    nativeMocks.unlisten.mockReset();
    nativeMocks.invoke.mockResolvedValue(snapshot('current', 0));
    usePlayerStore.setState(initialPlayerState);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps isNativeRuntime as a boolean export for non-fake hosts', () => {
    expect(isNativeRuntime).toBe(true);
  });

  it('discards the older initial invoke response when a snapshot event wins the race', async () => {
    let resolveInitial: ((value: TestNativeSnapshot) => void) | null = null;
    nativeMocks.invoke.mockImplementation(
      () =>
        new Promise<TestNativeSnapshot>((resolve) => {
          resolveInitial = resolve;
        }),
    );
    render(createElement(RuntimeHarness));
    await waitFor(() => expect(nativeMocks.snapshotHandler).not.toBeNull());

    act(() => nativeMocks.snapshotHandler?.(snapshot('event-track', 4_000)));
    await act(async () => {
      resolveInitial?.(snapshot('stale-initial-track', 1_000));
      await Promise.resolve();
    });

    const state = usePlayerStore.getState();
    expect(state.queue[state.currentIndex]?.id).toBe('event-track');
    expect(state.positionMs).toBe(4_000);
  });

  it('carries the sanitized source decision and normalizes its absence to null', async () => {
    nativeMocks.invoke.mockResolvedValue({
      ...snapshot('selected', 2_000),
      sourceSelection: {
        requestedQuality: 'high',
        resolvedQuality: 'standard',
        fallbackReason: 'source-unavailable',
        preview: false,
      },
    } satisfies TestNativeSnapshot);
    render(createElement(RuntimeHarness));

    await waitFor(() =>
      expect(usePlayerStore.getState().sourceSelection).toMatchObject({
        fallbackReason: 'source-unavailable',
      }),
    );

    act(() => nativeMocks.snapshotHandler?.(snapshot('next', 0)));
    expect(usePlayerStore.getState().sourceSelection).toBeNull();
  });

  it('maps the player quality command to the immediate native preference command', async () => {
    nativeMocks.invoke.mockResolvedValue(snapshot('current', 2_000));
    render(createElement(RuntimeHarness));
    await waitFor(() => expect(nativeMocks.snapshotHandler).not.toBeNull());
    nativeMocks.invoke.mockClear();

    usePlayerStore.getState().setQuality('master');

    await waitFor(() =>
      expect(nativeMocks.invoke).toHaveBeenCalledWith('qqmusic_set_current_quality', {
        quality: 'master',
      }),
    );
  });

  it('projects authoritative queue entry identity and playback order', async () => {
    const one = track('one');
    const two = track('two');
    nativeMocks.invoke.mockResolvedValue({
      ...snapshot('ignored', 2_000),
      queue: [one, two],
      queueEntries: [
        { id: 'queue-one', track: one },
        { id: 'queue-two', track: two },
      ],
      currentQueueEntryId: 'queue-one',
      playbackOrder: 'shuffle',
      shuffle: true,
      shuffleTraversal: ['queue-one', 'queue-two'],
      shuffleCursor: 0,
      playbackHistory: ['queue-one'],
      historyCursor: 0,
      upcomingQueueEntryIds: ['queue-two'],
    } satisfies TestNativeSnapshot);
    render(createElement(RuntimeHarness));

    await waitFor(() => expect(usePlayerStore.getState().playbackOrder).toBe('shuffle'));
    expect(usePlayerStore.getState()).toMatchObject({
      currentQueueEntryId: 'queue-one',
      upcomingQueueEntryIds: ['queue-two'],
    });
  });

  it.each([
    ['playQueueEntry', 'player_play_queue_entry', { entryId: 'queue-two' }],
    ['playNextQueueEntry', 'player_play_next_queue_entry', { entryId: 'queue-two' }],
    ['removeQueueEntry', 'player_remove_queue_entry', { entryId: 'queue-two' }],
    ['reorderQueueEntry', 'player_reorder_queue_entry', { entryId: 'queue-two', targetIndex: 0 }],
  ] as const)('maps %s to the identity-based native command', async (action, command, args) => {
    nativeMocks.invoke.mockResolvedValue(snapshot('current', 2_000));
    render(createElement(RuntimeHarness));
    await waitFor(() => expect(nativeMocks.snapshotHandler).not.toBeNull());
    const one = track('one');
    const two = track('two');
    usePlayerStore.setState({
      queue: [one, two],
      queueEntries: [
        { id: 'queue-one', track: one },
        { id: 'queue-two', track: two },
      ],
      currentIndex: 0,
      currentQueueEntryId: 'queue-one',
    });
    nativeMocks.invoke.mockClear();

    if (action === 'reorderQueueEntry') {
      usePlayerStore.getState().reorderQueueEntry('queue-two', 0);
    } else {
      usePlayerStore.getState()[action]('queue-two');
    }

    await waitFor(() => expect(nativeMocks.invoke).toHaveBeenCalledWith(command, args));
  });
});
