import { afterEach, describe, expect, it } from 'vitest';
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
  lineGapFromLineHeight,
  listResolvedPresets,
  lyricsPresetDiagnostics,
  nextResolvedPreset,
  normalizeLyricsPresetState,
  resetOverride,
  resolveLyricsPreset,
  resolvePrimaryFontSizePx,
  saveAsNewPreset,
  setPluginPresetCatalog,
} from './lyrics-preset';

describe('lyrics preset foundation', () => {
  it('ships three built-in presets with stable ids and schema v2 widget graphs', () => {
    expect(builtinPresetCatalog.map((preset) => preset.id)).toEqual([
      BUILTIN_CLASSIC_ID,
      BUILTIN_IMMERSIVE_ID,
      BUILTIN_VINYL_ID,
    ]);
    expect(builtinPresetCatalog.every((preset) => preset.schemaVersion === 2)).toBe(true);
    expect(builtinPresetCatalog.map((preset) => preset.layout)).toEqual(['split', 'full', 'vinyl']);
    expect(resolveLyricsPreset(defaultLyricsPresetState).background.fit).toBe('cover');
    expect(resolveLyricsPreset(defaultLyricsPresetState).scene.lyrics.followAnchor).toBe(0.35);
    expect(resolveLyricsPreset(defaultLyricsPresetState).scene.artwork.renderer).toBe('square');
    expect(
      resolveLyricsPreset(defaultLyricsPresetState, BUILTIN_VINYL_ID).scene.artwork.renderer,
    ).toBe('vinyl');
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
      rendererVersion: 1,
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
    expect(resolveLyricsPreset(restored).scene.lyrics.id).toBe('lyrics');
  });

  it('migrates v1 overrides and custom presets into factory widget graphs', () => {
    const migrated = normalizeLyricsPresetState({
      schemaVersion: 1,
      selectedId: 'builtin.vinyl',
      overrides: { 'builtin.vinyl': { typography: { fontScale: 1.2 } } },
      custom: [
        {
          schemaVersion: 1,
          id: 'custom.old',
          name: 'Studio',
          layout: 'full',
          typography: { fontScale: 1.1, lineHeight: 1.3 },
          artwork: { style: 'square' },
          background: { fit: 'contain', fallbackColor: '#20231C' },
        },
      ],
    });
    expect(migrated.schemaVersion).toBe(2);
    expect(resolveLyricsPreset(migrated, BUILTIN_VINYL_ID).scene.artwork.renderer).toBe('vinyl');
    expect(resolveLyricsPreset(migrated, BUILTIN_VINYL_ID).typography.fontScale).toBe(1.2);
    const custom = resolveLyricsPreset(migrated, 'custom.old');
    expect(custom.layout).toBe('full');
    expect(custom.scene.artwork.width).toBe(0.5);
    expect(custom.background.fit).toBe('contain');
  });

  it('falls back to the factory graph when layout is malformed', () => {
    const migrated = normalizeLyricsPresetState({
      selectedId: 'custom.broken',
      custom: [
        {
          id: 'custom.broken',
          layout: 'vinyl',
          scene: { lyrics: { x: 'nope' } },
        },
      ],
    });
    const resolved = resolveLyricsPreset(migrated, 'custom.broken');
    expect(resolved.scene.artwork.renderer).toBe('vinyl');
    expect(resolved.scene.lyrics.followAnchor).toBe(0.35);
  });

  it('makes 70% and 145% font scales differ by a large computed ratio', () => {
    const small = resolvePrimaryFontSizePx(0.7, 800);
    const large = resolvePrimaryFontSizePx(1.45, 800);
    expect(small).toBeCloseTo(44.8 * 0.7);
    expect(large).toBeCloseTo(44.8 * 1.45);
    expect(large / small).toBeGreaterThan(2);
  });

  it('changes primary line gap when lineHeight moves from 1.05 to 1.60', () => {
    expect(lineGapFromLineHeight(1.05)).toBeCloseTo(0.35);
    expect(lineGapFromLineHeight(1.6)).toBeCloseTo(2.35);
    expect(lineGapFromLineHeight(1.6) / lineGapFromLineHeight(1.05)).toBeGreaterThan(1.4);
  });

  it('cycles custom full-layout presets after immersive in the cover group', () => {
    const created = saveAsNewPreset(defaultLyricsPresetState, BUILTIN_IMMERSIVE_ID, {
      name: 'Studio',
    });
    expect(created.state.custom[0]?.layout).toBe('full');
    expect(nextResolvedPreset({ ...created.state, selectedId: BUILTIN_CLASSIC_ID }).id).toBe(
      BUILTIN_IMMERSIVE_ID,
    );
    expect(nextResolvedPreset({ ...created.state, selectedId: BUILTIN_IMMERSIVE_ID }).id).toBe(
      created.id,
    );
    expect(nextResolvedPreset(created.state).id).toBe(BUILTIN_VINYL_ID);
    expect(nextResolvedPreset({ ...created.state, selectedId: BUILTIN_VINYL_ID }).id).toBe(
      BUILTIN_CLASSIC_ID,
    );
  });

  afterEach(() => {
    setPluginPresetCatalog([]);
  });

  it('keeps plugin scene references and falls back when the plugin is gone', () => {
    setPluginPresetCatalog([
      {
        ...builtinPresetCatalog[0]!,
        id: 'plugin:dev.example.scene:vinyl',
        name: 'Sakura vinyl',
        source: 'plugin',
        pluginId: 'dev.example.scene',
        pluginName: 'Sakura',
      },
    ]);
    const state = normalizeLyricsPresetState({
      selectedId: 'plugin:dev.example.scene:vinyl',
    });
    expect(state.selectedId).toBe('plugin:dev.example.scene:vinyl');
    expect(resolveLyricsPreset(state).name).toBe('Sakura vinyl');
    expect(listResolvedPresets(state).some((preset) => preset.source === 'plugin')).toBe(true);
    setPluginPresetCatalog([]);
    expect(resolveLyricsPreset(state).id).toBe(BUILTIN_CLASSIC_ID);
  });

  it('normalizes color field emitters and extra text widgets', () => {
    const migrated = normalizeLyricsPresetState({
      selectedId: 'custom.field',
      custom: [
        {
          id: 'custom.field',
          layout: 'full',
          scene: {
            ...resolveLyricsPreset(defaultLyricsPresetState, BUILTIN_IMMERSIVE_ID).scene,
            background: {
              ...resolveLyricsPreset(defaultLyricsPresetState, BUILTIN_IMMERSIVE_ID).scene
                .background,
              source: 'colorField',
              colorField: {
                emitters: [
                  {
                    id: 'left',
                    position: 'left',
                    color: '#FF00AA',
                    intensity: 0.8,
                    falloff: 0.4,
                    radius: 0.6,
                    bind: 'artworkPrimary',
                  },
                ],
              },
            },
            extras: [
              {
                id: 'title',
                kind: 'text',
                x: 0.5,
                y: 0.1,
                width: 0.4,
                height: 0.1,
                anchor: 'top-center',
                zIndex: 9,
                visible: true,
                locked: false,
                bind: 'track.title',
              },
            ],
          },
        },
      ],
    });
    const resolved = resolveLyricsPreset(migrated, 'custom.field');
    expect(resolved.scene.background.source).toBe('colorField');
    expect(resolved.scene.background.colorField?.emitters[0]?.bind).toBe('artworkPrimary');
    expect(resolved.scene.extras?.[0]?.bind).toBe('track.title');
  });

  it('forks a plugin scene into a custom preset without remaining a plugin source', () => {
    setPluginPresetCatalog([
      {
        ...builtinPresetCatalog[0]!,
        id: 'plugin:dev.example.scene:vinyl',
        name: 'Sakura vinyl',
        source: 'plugin',
        pluginId: 'dev.example.scene',
        pluginName: 'Sakura',
      },
    ]);
    const forked = saveAsNewPreset(defaultLyricsPresetState, 'plugin:dev.example.scene:vinyl', {
      name: 'My vinyl',
    });
    const created = resolveLyricsPreset(forked.state, forked.id);
    expect(created.source).toBe('custom');
    expect(created.pluginId).toBeUndefined();
    expect(created.forkedFromPluginId).toBe('dev.example.scene');
  });
});
