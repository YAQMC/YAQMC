import type { PlaybackOrder, RepeatMode } from './player-store';

/** Player-facing exclusive modes. Repeat All remains a RepeatMode for API/MPRIS. */
export type PrimaryPlaybackMode = 'sequential' | 'shuffle' | 'repeat-one';

/** What the player-bar control should draw, including Repeat All from API/MPRIS. */
export type VisualPlaybackMode = PrimaryPlaybackMode | 'repeat-all';

export function primaryPlaybackMode(
  playbackOrder: PlaybackOrder,
  repeat: RepeatMode,
): PrimaryPlaybackMode {
  if (repeat === 'one') return 'repeat-one';
  return playbackOrder === 'shuffle' ? 'shuffle' : 'sequential';
}

export function visualPlaybackMode(
  playbackOrder: PlaybackOrder,
  repeat: RepeatMode,
): VisualPlaybackMode {
  if (repeat === 'one') return 'repeat-one';
  if (repeat === 'all') return 'repeat-all';
  return playbackOrder === 'shuffle' ? 'shuffle' : 'sequential';
}

export function applyPrimaryPlaybackMode(
  playbackOrder: PlaybackOrder,
  mode: PrimaryPlaybackMode,
): { playbackOrder: PlaybackOrder; repeat: RepeatMode } {
  switch (mode) {
    case 'sequential':
      return { playbackOrder: 'sequential', repeat: 'off' };
    case 'shuffle':
      return { playbackOrder: 'shuffle', repeat: 'off' };
    case 'repeat-one':
      return { playbackOrder, repeat: 'one' };
  }
}
