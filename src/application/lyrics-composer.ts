import type { LyricsPresetDefinition } from './lyrics-preset';

export const COMPOSER_HISTORY_LIMIT = 40;

export function clonePresetDraft(preset: LyricsPresetDefinition): LyricsPresetDefinition {
  return {
    ...preset,
    typography: { ...preset.typography },
    artwork: { ...preset.artwork },
    background: { ...preset.background },
    scene: {
      background: { ...preset.scene.background },
      artwork: { ...preset.scene.artwork },
      metadata: { ...preset.scene.metadata },
      lyrics: { ...preset.scene.lyrics },
      transport: { ...preset.scene.transport },
    },
  };
}

export function presetsEqualForHistory(
  left: LyricsPresetDefinition,
  right: LyricsPresetDefinition,
): boolean {
  return (
    JSON.stringify(left.scene) === JSON.stringify(right.scene) &&
    left.typography.fontScale === right.typography.fontScale &&
    left.typography.lineHeight === right.typography.lineHeight &&
    left.layout === right.layout
  );
}

export function pushComposerHistory(
  past: LyricsPresetDefinition[],
  snapshot: LyricsPresetDefinition,
): LyricsPresetDefinition[] {
  const next = [...past, clonePresetDraft(snapshot)];
  return next.length > COMPOSER_HISTORY_LIMIT ? next.slice(-COMPOSER_HISTORY_LIMIT) : next;
}
