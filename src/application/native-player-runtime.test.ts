import { createElement } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Song } from '../domain/music';
import { initialPlayerState, usePlayerStore } from './player-store';

interface TestNativeSnapshot {
  queue: Song[];
  currentIndex: number | null;
  positionMs: number;
  isPlaying: boolean;
  volume: number;
  isMuted: boolean;
  repeat: 'off' | 'all' | 'one';
  shuffle: boolean;
  playbackState: 'playing' | 'paused';
  playbackDurationMs: number | null;
  playbackError: null;
}

const nativeMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  snapshotHandler: null as ((event: { payload: TestNativeSnapshot }) => void) | null,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: nativeMocks.invoke,
  isTauri: () => true,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: nativeMocks.listen,
}));

import { useNativePlayerRuntime } from './native-player-runtime';

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
    nativeMocks.listen.mockReset();
    nativeMocks.unlisten.mockReset();
    nativeMocks.snapshotHandler = null;
    nativeMocks.listen.mockImplementation(
      async (_event: string, handler: (event: { payload: TestNativeSnapshot }) => void) => {
        nativeMocks.snapshotHandler = handler;
        return nativeMocks.unlisten;
      },
    );
    usePlayerStore.setState(initialPlayerState);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
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

    act(() => nativeMocks.snapshotHandler?.({ payload: snapshot('event-track', 4_000) }));
    await act(async () => {
      resolveInitial?.(snapshot('stale-initial-track', 1_000));
      await Promise.resolve();
    });

    const state = usePlayerStore.getState();
    expect(state.queue[state.currentIndex]?.id).toBe('event-track');
    expect(state.positionMs).toBe(4_000);
  });
});
