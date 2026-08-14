import { applyPrimaryPlaybackMode, primaryPlaybackMode, visualPlaybackMode } from './playback-mode';
import { afterEach, describe, expect, it } from 'vitest';
import { setPlayerCommandAdapter } from './player-command-adapter';
import { initialPlayerState, usePlayerStore } from './player-store';
import type { Song } from '../domain/music';

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

describe('primary playback mode projection', () => {
  it('maps Sequential / Shuffle / RepeatOne without collapsing Repeat All', () => {
    expect(primaryPlaybackMode('sequential', 'off')).toBe('sequential');
    expect(primaryPlaybackMode('shuffle', 'off')).toBe('shuffle');
    expect(primaryPlaybackMode('sequential', 'one')).toBe('repeat-one');
    expect(primaryPlaybackMode('shuffle', 'one')).toBe('repeat-one');
    expect(primaryPlaybackMode('sequential', 'all')).toBe('sequential');
    expect(primaryPlaybackMode('shuffle', 'all')).toBe('shuffle');
    expect(visualPlaybackMode('sequential', 'off')).toBe('sequential');
    expect(visualPlaybackMode('shuffle', 'off')).toBe('shuffle');
    expect(visualPlaybackMode('sequential', 'one')).toBe('repeat-one');
    expect(visualPlaybackMode('sequential', 'all')).toBe('repeat-all');
    expect(visualPlaybackMode('shuffle', 'all')).toBe('repeat-all');
  });

  it('keeps the previous order when entering Repeat One', () => {
    expect(applyPrimaryPlaybackMode('shuffle', 'repeat-one')).toEqual({
      playbackOrder: 'shuffle',
      repeat: 'one',
    });
    expect(applyPrimaryPlaybackMode('sequential', 'repeat-one')).toEqual({
      playbackOrder: 'sequential',
      repeat: 'one',
    });
    expect(applyPrimaryPlaybackMode('shuffle', 'sequential')).toEqual({
      playbackOrder: 'sequential',
      repeat: 'off',
    });
  });
});

describe('player store primary playback mode', () => {
  afterEach(() => {
    setPlayerCommandAdapter(null);
    usePlayerStore.setState(initialPlayerState);
  });

  it('selects Repeat One from Shuffle and restores Shuffle without a restart', () => {
    usePlayerStore.setState({
      ...initialPlayerState,
      queue: [],
      playbackOrder: 'shuffle',
      shuffle: true,
      repeat: 'off',
      positionMs: 4_200,
    });
    usePlayerStore.getState().setPrimaryPlaybackMode('repeat-one');
    expect(usePlayerStore.getState()).toMatchObject({
      playbackOrder: 'shuffle',
      shuffle: true,
      repeat: 'one',
      positionMs: 4_200,
    });
    usePlayerStore.getState().setPrimaryPlaybackMode('shuffle');
    expect(usePlayerStore.getState()).toMatchObject({
      playbackOrder: 'shuffle',
      shuffle: true,
      repeat: 'off',
      positionMs: 4_200,
    });
  });

  it('dispatches a single native command for primary mode changes', () => {
    const commands: unknown[] = [];
    setPlayerCommandAdapter(async (command) => {
      commands.push(command);
    });
    usePlayerStore.getState().setPrimaryPlaybackMode('repeat-one');
    expect(commands).toEqual([{ type: 'setPrimaryPlaybackMode', mode: 'repeat-one' }]);
  });

  it('advances on explicit Next during Repeat One and resets the lyric clock on EOS', () => {
    usePlayerStore.getState().playTracks([track('one'), track('two')]);
    usePlayerStore.getState().setPrimaryPlaybackMode('repeat-one');
    usePlayerStore.setState({
      isPlaying: true,
      playbackState: 'playing',
      positionMs: 9_500,
      playbackDurationMs: 10_000,
    });
    const currentId = usePlayerStore.getState().currentQueueEntryId;
    const revision = usePlayerStore.getState().timelineRevision;

    usePlayerStore.getState().tick(1_000);
    expect(usePlayerStore.getState()).toMatchObject({
      currentQueueEntryId: currentId,
      positionMs: 0,
      repeat: 'one',
    });
    expect(usePlayerStore.getState().timelineRevision).toBeGreaterThan(revision);

    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().currentQueueEntryId).not.toBe(currentId);
    expect(usePlayerStore.getState().repeat).toBe('one');
  });
});
