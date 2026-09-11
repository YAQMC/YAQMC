import { afterEach, describe, expect, it } from 'vitest';
import {
  authorizeTransportDefinition,
  BUILTIN_TRANSPORT_FULLSCREEN_ID,
  BUILTIN_TRANSPORT_WINDOW_ID,
  builtinTransportDefinition,
  defaultLyricsTransportState,
  getPluginTransportCatalog,
  LYRICS_TRANSPORT_SCHEMA_VERSION,
  listTransportPresets,
  lyricsTransportRequiresMigration,
  normalizeLyricsTransportState,
  resolveLyricsTransport,
  setPluginTransportCatalog,
  transportIconIdFor,
  validateTransportDefinition,
  type LyricsTransportDefinition,
} from './lyrics-transport';

function pluginDeclaration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'plugin.studio.transport',
    name: 'Studio transport',
    surface: 'window',
    layout: 'compact',
    actions: ['previous', 'playPause', 'next', 'progress', 'time'],
    tokens: {
      surface: '#0F1113',
      text: '#FFFFFF',
      muted: '#9AA0A6',
      accent: '#A8C95E',
    },
    metrics: { artworkSize: 0, controlSize: 48, gap: 8, radius: 14 },
    ...overrides,
  };
}

function grant(entry: { definition: LyricsTransportDefinition }, permissions: string[]) {
  setPluginTransportCatalog([
    {
      pluginId: 'dev.example.studio',
      definition: entry.definition,
      grantedPermissions: permissions,
    },
  ]);
  return entry.definition;
}

afterEach(() => {
  setPluginTransportCatalog([]);
});

describe('lyrics transport presets', () => {
  it('ships a window and a fullscreen built-in preset with the full control set', () => {
    for (const surface of ['window', 'fullscreen'] as const) {
      const preset = builtinTransportDefinition(surface);
      expect(preset.surface).toBe(surface);
      expect(preset.actions).toContain('previous');
      expect(preset.actions).toContain('playPause');
      expect(preset.actions).toContain('next');
      expect(preset.actions).toContain('progress');
      expect(preset.actions).toContain('time');
      expect(preset.metrics.controlSize).toBeGreaterThanOrEqual(44);
    }
    expect(builtinTransportDefinition('window').id).toBe(BUILTIN_TRANSPORT_WINDOW_ID);
    expect(builtinTransportDefinition('fullscreen').id).toBe(BUILTIN_TRANSPORT_FULLSCREEN_ID);
  });

  it('resolves each surface to its own default preset', () => {
    expect(resolveLyricsTransport(defaultLyricsTransportState, 'window').id).toBe(
      BUILTIN_TRANSPORT_WINDOW_ID,
    );
    expect(resolveLyricsTransport(defaultLyricsTransportState, 'fullscreen').id).toBe(
      BUILTIN_TRANSPORT_FULLSCREEN_ID,
    );
  });

  it('offers both built-in styles in either mode without changing persisted defaults', () => {
    for (const surface of ['window', 'fullscreen'] as const) {
      expect(listTransportPresets(surface).map((preset) => preset.id)).toEqual([
        BUILTIN_TRANSPORT_WINDOW_ID,
        BUILTIN_TRANSPORT_FULLSCREEN_ID,
      ]);
      for (const id of [BUILTIN_TRANSPORT_WINDOW_ID, BUILTIN_TRANSPORT_FULLSCREEN_ID]) {
        expect(
          resolveLyricsTransport({ ...defaultLyricsTransportState, [surface]: id }, surface),
        ).toMatchObject({ id, surface, canSeek: true });
      }
    }
  });

  it('migrates legacy or malformed documents back to the defaults', () => {
    expect(normalizeLyricsTransportState(undefined)).toEqual(defaultLyricsTransportState);
    expect(normalizeLyricsTransportState({ schemaVersion: 99, window: 'x' })).toEqual(
      defaultLyricsTransportState,
    );
    expect(
      normalizeLyricsTransportState({ schemaVersion: 1, window: 'bad id!', fullscreen: 7 }),
    ).toEqual(defaultLyricsTransportState);
    expect(lyricsTransportRequiresMigration(undefined)).toBe(true);
    expect(lyricsTransportRequiresMigration({ schemaVersion: 1 })).toBe(true);
    expect(lyricsTransportRequiresMigration(defaultLyricsTransportState)).toBe(false);
  });
});

describe('plugin transport declaration validation', () => {
  it('accepts a bounded icon map and falls back per action', () => {
    const definition = validateTransportDefinition(
      pluginDeclaration({ icons: { previous: 'chevrons-back', playPause: 'circle-play' } }),
    );
    expect(definition?.icons).toEqual({ previous: 'chevrons-back', playPause: 'circle-play' });
    expect(transportIconIdFor(definition!, 'previous')).toBe('chevrons-back');
    expect(transportIconIdFor(definition!, 'playPause')).toBe('circle-play');
    // No declaration for `next`, so the built-in glyph is used.
    expect(transportIconIdFor(definition!, 'next')).toBe('skip-forward');
    expect(transportIconIdFor(builtinTransportDefinition('window'), 'playPause')).toBe(
      'play-pause',
    );
    expect(validateTransportDefinition(pluginDeclaration())?.icons).toEqual({});
  });

  it('accepts a fully specified declaration', () => {
    const definition = validateTransportDefinition(pluginDeclaration());
    expect(definition).not.toBeNull();
    expect(definition?.actions).toEqual(['previous', 'playPause', 'next', 'progress', 'time']);
    expect(definition?.metrics.controlSize).toBe(48);
    expect(definition?.tokens.surface).toBe('#0F1113');
  });

  it.each([
    ['unknown field', pluginDeclaration({ injected: '<script/>' })],
    ['forged seek permission', pluginDeclaration({ canSeek: true })],
    ['unknown action', pluginDeclaration({ actions: ['previous', 'launchMissiles'] })],
    ['duplicate action', pluginDeclaration({ actions: ['previous', 'previous'] })],
    ['empty actions', pluginDeclaration({ actions: [] })],
    [
      'too many actions',
      pluginDeclaration({
        actions: ['previous', 'playPause', 'next', 'progress', 'time', 'artwork', 'track', 'time'],
      }),
    ],
    [
      'illegal color',
      pluginDeclaration({
        tokens: { surface: 'red', text: '#fff', muted: '#9AA0A6', accent: '#A8C95E' },
      }),
    ],
    [
      'illegal control size',
      pluginDeclaration({ metrics: { artworkSize: 0, controlSize: 20, gap: 8, radius: 14 } }),
    ],
    [
      'illegal artwork size',
      pluginDeclaration({ metrics: { artworkSize: 200, controlSize: 48, gap: 8, radius: 14 } }),
    ],
    [
      'illegal radius',
      pluginDeclaration({ metrics: { artworkSize: 0, controlSize: 48, gap: 8, radius: 400 } }),
    ],
    ['unknown layout', pluginDeclaration({ layout: 'floating' })],
    ['unknown surface', pluginDeclaration({ surface: 'pip' })],
    ['bad schema version', pluginDeclaration({ schemaVersion: 2 })],
    ['builtin id spoofing', pluginDeclaration({ id: 'builtin.transport.window' })],
    [
      'unknown token key',
      pluginDeclaration({
        tokens: {
          surface: '#000',
          text: '#fff',
          muted: '#999',
          accent: '#888',
          url: 'https://evil',
        },
      }),
    ],
    ['unknown icon id', pluginDeclaration({ icons: { next: 'party-parrot' } })],
    [
      'icon for an undeclared action',
      pluginDeclaration({ actions: ['playPause'], icons: { previous: 'chevrons-back' } }),
    ],
    ['icon slot for a read action', pluginDeclaration({ icons: { progress: 'play-pause' } })],
    [
      'icon id belonging to another action',
      pluginDeclaration({ icons: { playPause: 'skip-forward' } }),
    ],
    ['icons that are not an object', pluginDeclaration({ icons: ['skip-back'] })],
  ])('rejects %s', (_label, declaration) => {
    expect(validateTransportDefinition(declaration)).toBeNull();
  });

  it('never renders arbitrary payload shapes', () => {
    expect(validateTransportDefinition('<div>html</div>')).toBeNull();
    expect(validateTransportDefinition(['previous'])).toBeNull();
    expect(validateTransportDefinition({ schemaVersion: 1 })).toBeNull();
    expect(
      validateTransportDefinition({ ...pluginDeclaration(), style: 'position:fixed' }),
    ).toBeNull();
  });
});

describe('plugin transport authorization', () => {
  it('drops actions the plugin is not granted', () => {
    const definition = validateTransportDefinition(pluginDeclaration())!;
    const controlOnly = authorizeTransportDefinition(definition, new Set(['player.control']))!;
    expect(controlOnly.actions).toEqual(['previous', 'playPause', 'next']);
    const readOnly = authorizeTransportDefinition(definition, new Set(['player.read']))!;
    expect(readOnly.actions).toEqual(['progress', 'time']);
    expect(readOnly.canSeek).toBe(false);
    expect(
      authorizeTransportDefinition(definition, new Set(['player.read', 'player.control']))?.canSeek,
    ).toBe(true);
    expect(authorizeTransportDefinition(definition, new Set())).toBeNull();
  });

  it('hides unauthorized actions and falls back without a usable declaration', () => {
    const definition = validateTransportDefinition(
      pluginDeclaration({
        id: 'plugin.studio.controls-only',
        actions: ['previous', 'playPause', 'next'],
      }),
    )!;
    const state = { ...defaultLyricsTransportState, window: definition.id };
    grant({ definition }, ['player.read']);
    expect(resolveLyricsTransport(state, 'window').id).toBe(BUILTIN_TRANSPORT_WINDOW_ID);

    grant({ definition }, ['player.control']);
    const resolved = resolveLyricsTransport(state, 'window');
    expect(resolved.id).toBe(definition.id);
    expect(resolved.actions).toEqual(['previous', 'playPause', 'next']);
  });

  it('keeps read-only declarations usable when only player.read is granted', () => {
    const definition = validateTransportDefinition(
      pluginDeclaration({
        id: 'plugin.studio.readonly',
        actions: ['artwork', 'track', 'progress', 'time'],
      }),
    )!;
    grant({ definition }, ['player.read']);
    const resolved = resolveLyricsTransport(
      { ...defaultLyricsTransportState, window: definition.id },
      'window',
    );
    expect(resolved.id).toBe(definition.id);
    expect(resolved.actions).toEqual(['artwork', 'track', 'progress', 'time']);
  });

  it('drops icon entries together with the control actions that were not granted', () => {
    const definition = validateTransportDefinition(
      pluginDeclaration({
        actions: ['previous', 'playPause', 'progress'],
        icons: { previous: 'chevrons-back', playPause: 'circle-play' },
      }),
    )!;
    const readOnly = authorizeTransportDefinition(definition, new Set(['player.read']))!;
    expect(readOnly.actions).toEqual(['progress']);
    expect(readOnly.icons).toEqual({});

    const full = authorizeTransportDefinition(
      definition,
      new Set(['player.read', 'player.control']),
    )!;
    expect(full.icons).toEqual({ previous: 'chevrons-back', playPause: 'circle-play' });
  });

  it('falls back immediately when the plugin is unloaded or reads as a different surface', () => {
    const definition = validateTransportDefinition(pluginDeclaration())!;
    const state = { ...defaultLyricsTransportState, window: definition.id };
    grant({ definition }, ['player.read', 'player.control']);
    expect(resolveLyricsTransport(state, 'window').id).toBe(definition.id);

    // Uninstalled: the catalog is rebuilt without the plugin.
    setPluginTransportCatalog([]);
    expect(resolveLyricsTransport(state, 'window').id).toBe(BUILTIN_TRANSPORT_WINDOW_ID);

    // Declared for the window only: the fullscreen surface ignores it.
    grant({ definition }, ['player.read', 'player.control']);
    expect(resolveLyricsTransport(state, 'fullscreen').id).toBe(BUILTIN_TRANSPORT_FULLSCREEN_ID);
  });

  it('drops rejected declarations from the catalog and from the preset list', () => {
    setPluginTransportCatalog([
      {
        pluginId: 'dev.example.broken',
        definition: pluginDeclaration({ actions: ['previous', 'nope'] }) as never,
        grantedPermissions: ['player.read', 'player.control'],
      },
    ]);
    expect(getPluginTransportCatalog()).toHaveLength(0);
    expect(listTransportPresets('window').map((preset) => preset.id)).toEqual([
      BUILTIN_TRANSPORT_WINDOW_ID,
      BUILTIN_TRANSPORT_FULLSCREEN_ID,
    ]);
  });

  it('lists authorized plugin presets per surface', () => {
    const definition = validateTransportDefinition(pluginDeclaration())!;
    grant({ definition }, ['player.read', 'player.control']);
    const presets = listTransportPresets('window');
    expect(presets.map((preset) => preset.id)).toEqual([
      BUILTIN_TRANSPORT_WINDOW_ID,
      BUILTIN_TRANSPORT_FULLSCREEN_ID,
      definition.id,
    ]);
    expect(presets[2]?.source).toBe('plugin');
    expect(listTransportPresets('fullscreen')).toEqual([
      {
        id: BUILTIN_TRANSPORT_WINDOW_ID,
        nameKey: 'transportWindowBuiltin',
        source: 'built-in',
      },
      {
        id: BUILTIN_TRANSPORT_FULLSCREEN_ID,
        nameKey: 'transportFullscreenBuiltin',
        source: 'built-in',
      },
    ]);
  });

  it('keeps the schema version explicit for the DTO', () => {
    expect(LYRICS_TRANSPORT_SCHEMA_VERSION).toBe(1);
    expect(validateTransportDefinition(pluginDeclaration())?.schemaVersion).toBe(1);
  });
});
