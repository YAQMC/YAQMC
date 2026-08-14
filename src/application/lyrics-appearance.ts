import type { BackgroundMode } from './preferences';
import { isCachedArtworkDataUri } from './artwork-cache';
import { normalizeHexColor } from './theme-tokens';

export interface LyricsAppearanceBackground {
  mode: BackgroundMode;
  imageSource: string | null;
  imageFit: 'cover' | 'contain';
  color: string;
}

export interface ResolvedLyricsAppearance {
  mode: BackgroundMode;
  imageSource: string | null;
  imageFit: 'cover' | 'contain';
  baseColor: string | null;
}

export function resolveLyricsAppearance(
  background: LyricsAppearanceBackground,
  safeArtworkSource: string | null,
): ResolvedLyricsAppearance {
  switch (background.mode) {
    case 'color':
      return {
        mode: 'color',
        imageSource: null,
        imageFit: 'cover',
        baseColor: normalizeHexColor(background.color, '#20231C'),
      };
    case 'image':
      return {
        mode: 'image',
        imageSource: isCachedArtworkDataUri(background.imageSource) ? background.imageSource : null,
        imageFit: background.imageFit,
        baseColor: normalizeHexColor(background.color, '#20231C'),
      };
    case 'artwork':
      return {
        mode: 'artwork',
        imageSource: safeArtworkSource,
        imageFit: 'cover',
        baseColor: null,
      };
    default:
      return {
        mode: 'default',
        imageSource: safeArtworkSource,
        imageFit: 'cover',
        baseColor: null,
      };
  }
}

export function applySceneBackdrop(
  appearance: ResolvedLyricsAppearance,
  blur: number,
  blurredSource: string | null,
): ResolvedLyricsAppearance {
  if (appearance.mode === 'color' || !appearance.imageSource) {
    return appearance;
  }
  if (blur <= 0) return appearance;
  return {
    ...appearance,
    imageSource: blurredSource ?? appearance.imageSource,
  };
}
