import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot, FavoriteMutationRequest, Song } from '../domain/music';
import type { AccountMusicProvider } from '../providers/music-provider';
import { resetAccountRuntimeForTest, useAccountStore } from './account-runtime';
import { setPlayerCommandAdapter } from './player-command-adapter';
import {
  getEstimatedPositionMs,
  initialPlayerState,
  usePlayerStore,
  type AuthoritativePlayerSnapshot,
} from './player-store';

const track = (id: string, durationMs = 10_000): Song => ({
  id,
  title: id,
  artists: [{ id: 'artist', name: 'Artist' }],
  album: { id: 'album', title: 'Album' },
  artwork: { src: '/cover.svg', alt: 'Cover', dominantColor: '#000' },
  durationMs,
  trackNumber: 1,
  isFavorite: false,
  quality: 'high',
  availability: { status: 'available' },
});

function snapshot(
  overrides: Partial<AuthoritativePlayerSnapshot> = {},
): AuthoritativePlayerSnapshot {
  return {
    queue: [track('one'), track('two')],
    currentIndex: 0,
    positionMs: 1_000,
    isPlaying: true,
    volume: 0.72,
    isMuted: false,
    repeat: 'off',
    shuffle: false,
    playbackState: 'playing',
    playbackDurationMs: 10_000,
    playbackError: null,
    ...overrides,
  };
}

describe('player store', () => {
  beforeEach(() => {
    setPlayerCommandAdapter(null);
    resetAccountRuntimeForTest();
    usePlayerStore.setState(initialPlayerState);
  });

  afterEach(() => {
    setPlayerCommandAdapter(null);
    resetAccountRuntimeForTest();
    vi.restoreAllMocks();
  });

  it('does not mutate the player queue or active track during a favorite mutation', async () => {
    const song = track('one');
    const queue = [song];
    const snapshot: AccountSnapshot = {
      state: 'authenticated',
      profile: { avatarUrl: null, nickname: 'Listener', maskedIdentity: '10******01' },
      entitlement: {
        tier: 'free',
        membership: 'active',
        expiresAtMs: null,
        permittedQualities: ['standard'],
        observedMaximumQuality: 'standard',
        restrictions: [],
      },
      revision: 7,
      capabilities: {
        qrLogin: true,
        favoriteRead: true,
        favoriteWrite: true,
        playlistRead: true,
        playlistWrite: false,
        recentHistoryRead: true,
      },
    };
    const provider = {
      setFavorite: vi.fn(async (request: FavoriteMutationRequest) => ({
        ...request,
        status: 'applied' as const,
        errorCode: null,
        authRevision: 7,
      })),
    } as unknown as AccountMusicProvider;
    usePlayerStore.setState({ queue, currentIndex: 0 });
    useAccountStore.setState({ snapshot, favoriteByTrackId: { [song.id]: false } });

    await useAccountStore.getState().setFavorite(provider, song, true);

    expect(usePlayerStore.getState().queue).toBe(queue);
    expect(usePlayerStore.getState().queue[0]).toBe(song);
    expect(song.isFavorite).toBe(false);
    expect(useAccountStore.getState().favoriteByTrackId[song.id]).toBe(true);
  });

  it('starts a requested track in a new queue', () => {
    usePlayerStore.getState().playTracks([track('one'), track('two')], 'two');

    expect(usePlayerStore.getState()).toMatchObject({
      currentIndex: 1,
      positionMs: 0,
      isPlaying: true,
    });
  });

  it('lets account-gated tracks reach the native entitlement resolver', () => {
    const gated = {
      ...track('vip-track'),
      availability: {
        status: 'entitlement-required' as const,
        requiredTier: 'QQ Music VIP',
      },
    };
    const commands: unknown[] = [];
    setPlayerCommandAdapter(async (command) => {
      commands.push(command);
    });

    usePlayerStore.getState().playTracks([gated]);

    expect(commands).toEqual([
      { type: 'playTracks', tracks: [gated], startAtId: undefined, shuffle: undefined },
    ]);
  });

  it('still rejects explicitly unavailable catalog rows before native playback', () => {
    const unavailable = {
      ...track('removed-track'),
      availability: { status: 'unavailable' as const, reason: 'copyright' },
    };
    const commands: unknown[] = [];
    setPlayerCommandAdapter(async (command) => {
      commands.push(command);
    });

    usePlayerStore.getState().playTracks([unavailable]);

    expect(commands).toEqual([]);
  });

  it('sends queue replacement and shuffle mode as one native command', () => {
    const commands: unknown[] = [];
    setPlayerCommandAdapter(async (command) => {
      commands.push(command);
    });
    const tracks = [track('one'), track('two')];

    usePlayerStore.getState().playTracks(tracks, undefined, true);

    expect(commands).toEqual([{ type: 'playTracks', tracks, startAtId: undefined, shuffle: true }]);
  });

  it('toggles a stable shuffle traversal back to canonical sequential order', () => {
    usePlayerStore
      .getState()
      .playTracks([track('one'), track('two'), track('three'), track('four')], 'two');
    const before = usePlayerStore.getState();
    const currentEntryId = before.currentQueueEntryId;

    usePlayerStore.getState().toggleShuffle();
    const shuffled = usePlayerStore.getState();

    expect(shuffled).toMatchObject({
      playbackOrder: 'shuffle',
      shuffle: true,
      currentQueueEntryId: currentEntryId,
      currentIndex: 1,
    });
    expect(shuffled.shuffleTraversal).toHaveLength(4);
    expect(new Set(shuffled.shuffleTraversal)).toEqual(
      new Set(shuffled.queueEntries.map((entry) => entry.id)),
    );
    expect(shuffled.upcomingQueueEntryIds).toEqual(shuffled.shuffleTraversal.slice(1));

    usePlayerStore.getState().toggleShuffle();
    expect(usePlayerStore.getState()).toMatchObject({
      playbackOrder: 'sequential',
      shuffle: false,
      currentQueueEntryId: currentEntryId,
      currentIndex: 1,
      upcomingQueueEntryIds: before.queueEntries.slice(2).map((entry) => entry.id),
    });
  });

  it('uses shuffle history for Previous and canonical Next after shuffle is disabled', () => {
    usePlayerStore
      .getState()
      .playTracks([track('one'), track('two'), track('three'), track('four')], 'two', true);
    const firstId = usePlayerStore.getState().currentQueueEntryId;

    usePlayerStore.getState().next();
    const secondId = usePlayerStore.getState().currentQueueEntryId;
    expect(secondId).not.toBe(firstId);
    usePlayerStore.getState().previous();
    expect(usePlayerStore.getState().currentQueueEntryId).toBe(firstId);

    usePlayerStore.getState().next();
    const currentId = usePlayerStore.getState().currentQueueEntryId;
    usePlayerStore.getState().setShuffle(false);
    const canonicalIndex = usePlayerStore
      .getState()
      .queueEntries.findIndex((entry) => entry.id === currentId);
    usePlayerStore.getState().next();
    const after = usePlayerStore.getState();
    const expectedIndex = Math.min(canonicalIndex + 1, after.queueEntries.length - 1);
    expect(after.currentQueueEntryId).toBe(after.queueEntries[expectedIndex]?.id);
  });

  it('keeps duplicate songs as uniquely addressable queue entries during reorder', () => {
    usePlayerStore
      .getState()
      .playTracks([track('duplicate'), track('middle'), track('duplicate'), track('last')]);
    const original = usePlayerStore.getState();
    const firstDuplicate = original.queueEntries[0]!;
    const secondDuplicate = original.queueEntries[2]!;
    expect(firstDuplicate.id).not.toBe(secondDuplicate.id);

    usePlayerStore.getState().reorderQueueEntry(secondDuplicate.id, 1);
    const reordered = usePlayerStore.getState();
    expect(reordered.queueEntries.map((entry) => entry.id)).toEqual([
      firstDuplicate.id,
      secondDuplicate.id,
      original.queueEntries[1]!.id,
      original.queueEntries[3]!.id,
    ]);
    expect(reordered.currentQueueEntryId).toBe(firstDuplicate.id);
  });

  it('sends identity-based queue actions through the native adapter', () => {
    const commands: unknown[] = [];
    setPlayerCommandAdapter(async (command) => {
      commands.push(command);
    });
    const queueEntries = [
      { id: 'entry-a', track: track('one') },
      { id: 'entry-b', track: track('two') },
    ];
    usePlayerStore.setState({
      queue: queueEntries.map((entry) => entry.track),
      queueEntries,
      currentIndex: 0,
      currentQueueEntryId: 'entry-a',
    });

    usePlayerStore.getState().playQueueEntry('entry-b');
    usePlayerStore.getState().playNextQueueEntry('entry-b');
    usePlayerStore.getState().removeQueueEntry('entry-b');
    usePlayerStore.getState().reorderQueueEntry('entry-b', 0);

    expect(commands).toEqual([
      { type: 'playQueueEntry', entryId: 'entry-b' },
      { type: 'playNextQueueEntry', entryId: 'entry-b' },
      { type: 'removeQueueEntry', entryId: 'entry-b' },
      { type: 'reorderQueueEntry', entryId: 'entry-b', targetIndex: 0 },
    ]);
  });

  it('appends multiple tracks in one queue mutation', () => {
    usePlayerStore.setState({ queue: [track('zero')], currentIndex: 0 });
    usePlayerStore.getState().addTracksToQueue([track('one'), track('two')]);

    expect(usePlayerStore.getState().queue.map((song) => song.id)).toEqual(['zero', 'one', 'two']);
  });

  it('advances when a track reaches its duration', () => {
    usePlayerStore.getState().playTracks([track('one'), track('two')]);
    usePlayerStore.getState().tick(10_000);

    expect(usePlayerStore.getState()).toMatchObject({ currentIndex: 1, positionMs: 0 });
  });

  it('stops at the end when repeat is disabled', () => {
    usePlayerStore.getState().playTracks([track('one')]);
    usePlayerStore.getState().tick(10_000);

    expect(usePlayerStore.getState()).toMatchObject({ isPlaying: false, positionMs: 0 });
  });

  it('keeps the active track stable when removing an earlier queue entry', () => {
    usePlayerStore.getState().playTracks([track('one'), track('two'), track('three')], 'two');
    usePlayerStore.setState({
      sourceSelection: {
        requestedQuality: 'lossless',
        resolvedQuality: 'high',
        fallbackReason: 'account-rights',
        preview: false,
      },
    });
    usePlayerStore.getState().removeFromQueue(0);

    const state = usePlayerStore.getState();
    expect(state.currentIndex).toBe(0);
    expect(state.queue[state.currentIndex]?.id).toBe('two');
    expect(state.sourceSelection?.fallbackReason).toBe('account-rights');
  });

  it('clears source selection when removing the active queue entry', () => {
    usePlayerStore.getState().playTracks([track('one'), track('two')]);
    usePlayerStore.setState({
      sourceSelection: {
        requestedQuality: 'high',
        resolvedQuality: 'standard',
        fallbackReason: 'source-unavailable',
        preview: false,
      },
    });

    usePlayerStore.getState().removeFromQueue(0);

    expect(usePlayerStore.getState()).toMatchObject({
      currentIndex: 0,
      sourceSelection: null,
    });
    expect(usePlayerStore.getState().queue[0]?.id).toBe('two');
  });

  it('opens lyrics, closes the queue, and preserves playback state', () => {
    usePlayerStore.setState({
      ...initialPlayerState,
      queue: [track('one')],
      currentIndex: 0,
      positionMs: 3_210,
      isPlaying: true,
      playbackState: 'playing',
      playbackDurationMs: 10_000,
      observedAtMs: 123,
      queueOpen: true,
      lyricsOpen: false,
    });
    const before = usePlayerStore.getState();

    usePlayerStore.getState().openLyrics();

    const after = usePlayerStore.getState();
    expect(after).toMatchObject({ queueOpen: false, lyricsOpen: true });
    expect({
      queue: after.queue,
      currentIndex: after.currentIndex,
      positionMs: after.positionMs,
      isPlaying: after.isPlaying,
      volume: after.volume,
      isMuted: after.isMuted,
      repeat: after.repeat,
      shuffle: after.shuffle,
      playbackState: after.playbackState,
      playbackDurationMs: after.playbackDurationMs,
      playbackError: after.playbackError,
      observedAtMs: after.observedAtMs,
      timelineRevision: after.timelineRevision,
    }).toEqual({
      queue: before.queue,
      currentIndex: before.currentIndex,
      positionMs: before.positionMs,
      isPlaying: before.isPlaying,
      volume: before.volume,
      isMuted: before.isMuted,
      repeat: before.repeat,
      shuffle: before.shuffle,
      playbackState: before.playbackState,
      playbackDurationMs: before.playbackDurationMs,
      playbackError: before.playbackError,
      observedAtMs: before.observedAtMs,
      timelineRevision: before.timelineRevision,
    });
  });

  it.each([
    { label: 'near predicted', positionMs: 1_300, expectedDelta: 0 },
    { label: 'exactly 250 ms ahead', positionMs: 1_350, expectedDelta: 0 },
    { label: '251 ms ahead', positionMs: 1_351, expectedDelta: 1 },
    { label: '251 ms behind', positionMs: 849, expectedDelta: 1 },
  ])(
    'classifies an external $label snapshot against the prior predicted position',
    ({ positionMs, expectedDelta }) => {
      vi.spyOn(performance, 'now').mockReturnValue(1_100);
      usePlayerStore.setState({
        ...initialPlayerState,
        queue: [track('one'), track('two')],
        currentIndex: 0,
        positionMs: 1_000,
        isPlaying: true,
        playbackState: 'playing',
        playbackDurationMs: 10_000,
        observedAtMs: 1_000,
        timelineRevision: 7,
      });

      usePlayerStore.getState().applyExternalSnapshot(snapshot({ positionMs }));

      expect(usePlayerStore.getState()).toMatchObject({
        timelineRevision: 7 + expectedDelta,
        observedAtMs: 1_100,
      });
      expect(performance.now).toHaveBeenCalledOnce();
    },
  );

  it('clamps the prior predicted position before classifying an external snapshot', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    usePlayerStore.setState({
      ...initialPlayerState,
      queue: [track('one')],
      currentIndex: 0,
      positionMs: -1_000,
      isPlaying: false,
      playbackState: 'paused',
      playbackDurationMs: 10_000,
      observedAtMs: 1_000,
      timelineRevision: 3,
    });

    usePlayerStore.getState().applyExternalSnapshot(
      snapshot({
        queue: [track('one')],
        positionMs: 0,
        isPlaying: false,
        playbackState: 'paused',
      }),
    );

    expect(usePlayerStore.getState().timelineRevision).toBe(3);
  });

  it.each([
    {
      label: 'pause',
      overrides: { isPlaying: false, playbackState: 'paused' } as const,
    },
    {
      label: 'resume',
      prior: { isPlaying: false, playbackState: 'paused' } as const,
      overrides: { isPlaying: true, playbackState: 'playing' } as const,
    },
    { label: 'index change', overrides: { currentIndex: 1 } as const },
    {
      label: 'track ID change at the same index',
      overrides: { queue: [track('replacement'), track('two')] },
    },
  ])('increments timeline revision for an external $label', ({ prior, overrides }) => {
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    usePlayerStore.setState({
      ...initialPlayerState,
      queue: [track('one'), track('two')],
      currentIndex: 0,
      positionMs: 1_000,
      isPlaying: true,
      playbackState: 'playing',
      playbackDurationMs: 10_000,
      observedAtMs: 1_000,
      timelineRevision: 11,
      ...prior,
    });

    usePlayerStore.getState().applyExternalSnapshot(snapshot(overrides));

    expect(usePlayerStore.getState().timelineRevision).toBe(12);
  });

  it.each([
    {
      label: 'seek',
      arrange: () => undefined,
      act: () => usePlayerStore.getState().seek(2_000),
    },
    {
      label: 'pause or resume',
      arrange: () => undefined,
      act: () => usePlayerStore.getState().togglePlayback(),
    },
    {
      label: 'playTracks',
      arrange: () => undefined,
      act: () => usePlayerStore.getState().playTracks([track('three')]),
    },
    {
      label: 'playFromQueue',
      arrange: () => undefined,
      act: () => usePlayerStore.getState().playFromQueue(1),
    },
    {
      label: 'next',
      arrange: () => undefined,
      act: () => usePlayerStore.getState().next(),
    },
    {
      label: 'previous position reset',
      arrange: () => usePlayerStore.setState({ positionMs: 5_000 }),
      act: () => usePlayerStore.getState().previous(),
    },
    {
      label: 'previous track',
      arrange: () => usePlayerStore.setState({ currentIndex: 1, positionMs: 0 }),
      act: () => usePlayerStore.getState().previous(),
    },
    {
      label: 'repeat-one reset',
      arrange: () => usePlayerStore.setState({ repeat: 'one', positionMs: 9_000 }),
      act: () => usePlayerStore.getState().tick(1_000),
    },
    {
      label: 'automatic track advance',
      arrange: () => usePlayerStore.setState({ positionMs: 9_000 }),
      act: () => usePlayerStore.getState().tick(1_000),
    },
  ])('increments timeline revision for local $label discontinuity', ({ arrange, act }) => {
    usePlayerStore.setState({
      ...initialPlayerState,
      queue: [track('one'), track('two')],
      currentIndex: 0,
      positionMs: 1_000,
      isPlaying: true,
      playbackState: 'playing',
      playbackDurationMs: 10_000,
      observedAtMs: 0,
      timelineRevision: 20,
    });
    arrange();

    act();

    expect(usePlayerStore.getState().timelineRevision).toBe(21);
  });

  it('does not increment timeline revision for an ordinary local tick', () => {
    usePlayerStore.setState({
      ...initialPlayerState,
      queue: [track('one')],
      currentIndex: 0,
      positionMs: 1_000,
      isPlaying: true,
      playbackState: 'playing',
      playbackDurationMs: 10_000,
      timelineRevision: 4,
    });

    usePlayerStore.getState().tick(100);

    expect(usePlayerStore.getState()).toMatchObject({ positionMs: 1_100, timelineRevision: 4 });
  });

  it('projects only the typed source selection and clears it when a later snapshot omits it', () => {
    usePlayerStore.getState().applyExternalSnapshot(
      snapshot({
        sourceSelection: {
          requestedQuality: 'lossless',
          resolvedQuality: 'high',
          fallbackReason: 'account-rights',
          preview: false,
        },
      }),
    );
    expect(usePlayerStore.getState().sourceSelection).toEqual({
      requestedQuality: 'lossless',
      resolvedQuality: 'high',
      fallbackReason: 'account-rights',
      preview: false,
    });

    usePlayerStore.getState().applyExternalSnapshot(snapshot());
    expect(usePlayerStore.getState().sourceSelection).toBeNull();
  });

  it('ignores an older playback session snapshot so the current track cannot roll back', () => {
    usePlayerStore.getState().applyExternalSnapshot(
      snapshot({
        currentIndex: 1,
        sessionId: 12,
        snapshotRevision: 4,
        currentQueueEntryId: 'queue:b',
        queueEntries: [
          { id: 'queue:a', track: track('one') },
          { id: 'queue:b', track: track('two') },
        ],
      }),
    );
    usePlayerStore.getState().applyExternalSnapshot(
      snapshot({
        currentIndex: 0,
        sessionId: 11,
        snapshotRevision: 99,
        positionMs: 8_000,
        currentQueueEntryId: 'queue:a',
        queueEntries: [
          { id: 'queue:a', track: track('one') },
          { id: 'queue:b', track: track('two') },
        ],
      }),
    );
    expect(usePlayerStore.getState().currentIndex).toBe(1);
    expect(usePlayerStore.getState().sessionId).toBe(12);
    expect(usePlayerStore.getState().queue[1]?.id).toBe('two');
  });

  it('keeps the scrub thumb stable while native position events arrive', () => {
    usePlayerStore
      .getState()
      .applyExternalSnapshot(snapshot({ sessionId: 3, snapshotRevision: 1, positionMs: 1_000 }));
    usePlayerStore.getState().beginScrub();
    usePlayerStore.getState().previewScrub(4_000);
    usePlayerStore
      .getState()
      .applyExternalSnapshot(
        snapshot({ sessionId: 3, snapshotRevision: 1, positionMs: 1_250, lastSeekRevision: 0 }),
      );
    expect(usePlayerStore.getState().isScrubbing).toBe(true);
    expect(usePlayerStore.getState().positionMs).toBe(4_000);
    usePlayerStore.getState().commitScrub(4_000);
    usePlayerStore
      .getState()
      .applyExternalSnapshot(
        snapshot({ sessionId: 3, snapshotRevision: 2, positionMs: 4_000, lastSeekRevision: 1 }),
      );
    expect(usePlayerStore.getState().isScrubbing).toBe(false);
    expect(usePlayerStore.getState().positionMs).toBe(4_000);
  });

  it('keeps optimistic volume while stale native snapshots arrive', () => {
    setPlayerCommandAdapter(async () => {});
    usePlayerStore
      .getState()
      .applyExternalSnapshot(snapshot({ sessionId: 3, snapshotRevision: 1, volume: 0.72 }));
    usePlayerStore.getState().setVolume(0.2);
    expect(usePlayerStore.getState().volume).toBe(0.2);
    expect(usePlayerStore.getState().isMuted).toBe(false);
    expect(usePlayerStore.getState().isVolumeScrubbing).toBe(true);

    usePlayerStore
      .getState()
      .applyExternalSnapshot(
        snapshot({ sessionId: 3, snapshotRevision: 2, volume: 0.72, isMuted: false }),
      );
    expect(usePlayerStore.getState().volume).toBe(0.2);
    expect(usePlayerStore.getState().isVolumeScrubbing).toBe(true);

    usePlayerStore
      .getState()
      .applyExternalSnapshot(
        snapshot({ sessionId: 3, snapshotRevision: 3, volume: 0.2, isMuted: false }),
      );
    expect(usePlayerStore.getState().volume).toBe(0.2);
    expect(usePlayerStore.getState().isVolumeScrubbing).toBe(false);
  });

  it('estimates playing position from a fresh Core sample timestamp instead of arrival time', () => {
    const nowUnix = Date.now();
    const observedAtMs = performance.now();
    usePlayerStore.setState({
      ...initialPlayerState,
      queue: [track('one')],
      currentIndex: 0,
      positionMs: 1_000,
      isPlaying: true,
      playbackState: 'playing',
      playbackDurationMs: 10_000,
      observedAtMs,
      sampledAtMs: nowUnix - 400,
    });
    expect(getEstimatedPositionMs(observedAtMs, nowUnix)).toBe(1_400);

    usePlayerStore.setState({ sampledAtMs: nowUnix - 5_000 });
    expect(getEstimatedPositionMs(observedAtMs, nowUnix)).toBe(1_000);
  });
});
