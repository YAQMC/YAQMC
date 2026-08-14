import { describe, expect, it } from 'vitest';
import {
  applyOverride,
  BUILTIN_CLASSIC_ID,
  BUILTIN_IMMERSIVE_ID,
  BUILTIN_VINYL_ID,
  builtinPresetCatalog,
  clampFontScale,
  clampLineHeight,
  defaultLyricsPresetState,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  LYRICS_PRESET_SCHEMA_VERSION,
  lyricsPresetDiagnostics,
  normalizeLyricsPresetState,
  resetOverride,
  resolveLyricsPreset,
  saveAsNewPreset,
} from './lyrics-preset';

describe('lyrics preset foundation', () => {
  it('ships three built-in presets with stable ids and schema v1', () => {
    expect(builtinPresetCatalog.map((preset) => preset.id)).toEqual([
      BUILTIN_CLASSIC_ID,
      BUILTIN_IMMERSIVE_ID,
      BUILTIN_VINYL_ID,
    ]);
    expect(builtinPresetCatalog.every((preset) => preset.schemaVersion === 1)).toBe(true);
    expect(builtinPresetCatalog.map((preset) => preset.layout)).toEqual(['split', 'full', 'vinyl']);
    expect(resolveLyricsPreset(defaultLyricsPresetState).background.fit).toBe('cover');
  });

  it('keeps built-in definitions intact when applying an override', () => {
    const next = applyOverride(defaultLyricsPresetState, BUILTIN_CLASSIC_ID, {
      typography: { fontScale: 1.2, lineHeight: 1.4 },
    });
    expect(resolveLyricsPreset(next, BUILTIN_CLASSIC_ID).typography).toEqual({
      fontScale: 1.2,
      lineHeight: 1.4,
    });
    expect(builtinPresetCatalog[0]?.typography.fontScale).toBe(1);
    expect(resetOverride(next, BUILTIN_CLASSIC_ID).overrides).toEqual({});
  });

  it('saves a custom preset with a new id and leaves the built-in slot in place', () => {
    const overridden = applyOverride(defaultLyricsPresetState, BUILTIN_VINYL_ID, {
      typography: { fontScale: 1.1 },
    });
    const created = saveAsNewPreset(overridden, BUILTIN_VINYL_ID);
    expect(created.id.startsWith('custom.')).toBe(true);
    expect(created.id).not.toBe(BUILTIN_VINYL_ID);
    expect(created.state.custom).toHaveLength(1);
    expect(created.state.selectedId).toBe(created.id);
    expect(resolveLyricsPreset(created.state, BUILTIN_VINYL_ID).layout).toBe('vinyl');
    expect(resolveLyricsPreset(created.state).source).toBe('custom');
  });

  it('clamps typography and rejects malformed documents', () => {
    expect(clampFontScale(0.1)).toBe(FONT_SCALE_MIN);
    expect(clampFontScale(8)).toBe(FONT_SCALE_MAX);
    expect(clampLineHeight(0.2)).toBe(LINE_HEIGHT_MIN);
    expect(clampLineHeight(9)).toBe(LINE_HEIGHT_MAX);
    const normalized = normalizeLyricsPresetState({
      selectedId: 'not-a-preset',
      overrides: { 'builtin.classic': { typography: { fontScale: 99 } } },
      custom: [
        { id: '', layout: 'nope' },
        { id: 'custom.ok', layout: 'full' },
      ],
    });
    expect(normalized.selectedId).toBe(BUILTIN_CLASSIC_ID);
    expect(normalized.overrides[BUILTIN_CLASSIC_ID]?.typography?.fontScale).toBe(FONT_SCALE_MAX);
    expect(normalized.custom.map((preset) => preset.id)).toEqual([
      'custom.imported-0',
      'custom.ok',
    ]);
  });

  it('preserves an existing Contain preference when first creating preset state', () => {
    const migrated = normalizeLyricsPresetState(undefined, {
      coverLayout: 'full',
      preserveContainFit: true,
    });
    expect(migrated.selectedId).toBe(BUILTIN_IMMERSIVE_ID);
    expect(resolveLyricsPreset(migrated).background.fit).toBe('contain');
  });

  it('reports a compact diagnostics projection', () => {
    expect(lyricsPresetDiagnostics(defaultLyricsPresetState)).toEqual({
      id: BUILTIN_CLASSIC_ID,
      kind: 'built-in',
      schemaVersion: LYRICS_PRESET_SCHEMA_VERSION,
    });
  });

  it('round-trips a custom preset through normalization', () => {
    const created = saveAsNewPreset(defaultLyricsPresetState, BUILTIN_IMMERSIVE_ID, {
      patch: { typography: { fontScale: 1.2, lineHeight: 1.3 } },
      name: 'Studio',
    });
    const restored = normalizeLyricsPresetState(JSON.parse(JSON.stringify(created.state)));
    expect(restored.custom).toHaveLength(1);
    expect(restored.custom[0]?.id).toBe(created.id);
    expect(restored.custom[0]?.name).toBe('Studio');
    expect(resolveLyricsPreset(restored).typography.fontScale).toBe(1.2);
  });
});
