import type { LyricDocument } from '../../domain/music';
import type { SecondaryLyricVisibility } from '../../application/preferences';
import type { LyricsPreviewFrame, LyricsPresetDefinition } from '../../application/lyrics-preset';
import type { ResolvedLyricsAppearance } from '../../application/lyrics-appearance';
import type { SnapGuide } from '../../application/lyrics-scene-geometry';

export type LyricsSceneMode = 'runtime' | 'editor';
export type LyricsFollowState = 'active' | 'suspended';
export type LyricsStatus = 'idle' | 'loading' | 'ready' | 'error' | 'missing';

export interface LyricsSceneBindings {
  songId: string | null;
  title: string;
  artistLabel: string;
  artworkSrc: string | null;
  artworkAlt: string;
  artworkColor: string;
  lyrics: LyricDocument | null;
  lyricsStatus: LyricsStatus;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  timelineRevision: number;
  presentationOffsetMs: number;
  getPositionMs: () => number;
  seek: (positionMs: number) => void;
  togglePlayback: () => void;
  next?: () => void;
  previous?: () => void;
  translation: SecondaryLyricVisibility;
  romanization: SecondaryLyricVisibility;
}

export interface LyricsSceneProps {
  preset: LyricsPresetDefinition;
  bindings: LyricsSceneBindings;
  appearance: ResolvedLyricsAppearance;
  mode: LyricsSceneMode;
  selectedWidgetId?: string | null;
  onSelectWidget?: (id: string | null) => void;
  editorGesture?: boolean;
  guides?: SnapGuide[];
  className?: string;
  previewFrame?: LyricsPreviewFrame;
  fallbackNotice?: string | null;
  onFollowStateChange?: (state: LyricsFollowState) => void;
}
