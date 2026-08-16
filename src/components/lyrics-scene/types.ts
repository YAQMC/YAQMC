import type { PointerEvent as ReactPointerEvent } from 'react';
import type { LyricDocument } from '../../domain/music';
import type { LyricWordEffect, SecondaryLyricVisibility } from '../../application/preferences';
import type {
  LyricsPreviewFrame,
  LyricsPresetDefinition,
  SceneWidgetId,
} from '../../application/lyrics-preset';
import type { ResolvedLyricsAppearance } from '../../application/lyrics-appearance';
import type { SnapGuide } from '../../application/lyrics-scene-geometry';

export type LyricsSceneMode = 'runtime' | 'editor';
export type LyricsFollowState = 'active' | 'suspended';
export type LyricsStatus = 'idle' | 'loading' | 'ready' | 'error' | 'missing';

export interface LyricsSceneBindings {
  songId: string | null;
  title: string;
  artistLabel: string;
  albumTitle?: string;
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
  beginScrub?: () => void;
  previewScrub?: (positionMs: number) => void;
  commitScrub?: (positionMs: number) => void;
  togglePlayback: () => void;
  next?: () => void;
  previous?: () => void;
  translation: SecondaryLyricVisibility;
  romanization: SecondaryLyricVisibility;
  wordEffect: LyricWordEffect;
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
  onEditorDragStart?: (id: SceneWidgetId, event: ReactPointerEvent<HTMLElement>) => void;
}
