import { describe, expect, it } from 'vitest';
import {
  defaultPreferences,
  formatBackgroundPickerError,
  normalizePreferences,
  preferencesRequireMigration,
  usePreferencesStore,
} from './preferences';

describe('preference persistence model', () => {
  it('falls back cleanly for missing or future-shaped data', () => {
    expect(normalizePreferences(null)).toEqual(defaultPreferences);
    const normalized = normalizePreferences({ version: 99, locale: 'fr-FR' });
    expect(normalized.version).toBe(2);
    expect(normalized.locale).toBe('system');
  });

  it('clamps unsafe appearance and lyric-surface values', () => {
    const normalized = normalizePreferences({
      appearance: { surfaceOpacity: 12, artworkInfluence: 500, primaryColor: 'broken' },
      lyrics: { timingOffsetMs: 8_000 },
      surfaces: { desktop: { fontSize: 500, backgroundOpacity: -4 } },
    });
    expect(normalized.appearance.surfaceOpacity).toBe(85);
    expect(normalized.appearance.artworkInfluence).toBe(100);
    expect(normalized.appearance.primaryColor).toBe('#A8C95E');
    expect(normalized.lyrics.timingOffsetMs).toBe(2_000);
    expect(normalized.surfaces.desktop.fontSize).toBe(64);
    expect(normalized.surfaces.desktop.backgroundOpacity).toBe(0);
  });

  it('preserves independent UI locale and lyric presentation choices', () => {
    const normalized = normalizePreferences({
      locale: 'zh-CN',
      lyrics: { translation: 'hide', romanization: 'show', timingOffsetMs: -320 },
    });
    expect(normalized.locale).toBe('zh-CN');
    expect(normalized.lyrics).toEqual({
      translation: 'hide',
      romanization: 'show',
      timingOffsetMs: -320,
      fontSize: 'medium',
      coverLayout: 'split',
      focusSidebarCollapsed: false,
      wordEffect: 'jump',
    });
  });

  it('normalizes the lyrics focus-sidebar preference as a boolean', () => {
    expect(normalizePreferences({ version: 2 }).lyrics.focusSidebarCollapsed).toBe(false);
    expect(
      normalizePreferences({ version: 2, lyrics: { focusSidebarCollapsed: 'yes' } }).lyrics
        .focusSidebarCollapsed,
    ).toBe(false);
    expect(
      normalizePreferences({ version: 2, lyrics: { focusSidebarCollapsed: true } }).lyrics
        .focusSidebarCollapsed,
    ).toBe(true);
  });

  it('defaults and validates the lyrics word effect', () => {
    expect(normalizePreferences({ version: 2 }).lyrics.wordEffect).toBe('jump');
    expect(
      normalizePreferences({ version: 2, lyrics: { wordEffect: 'jump' } }).lyrics.wordEffect,
    ).toBe('jump');
    expect(
      normalizePreferences({ version: 2, lyrics: { wordEffect: 'fill' } }).lyrics.wordEffect,
    ).toBe('fill');
    expect(
      normalizePreferences({ version: 2, lyrics: { wordEffect: 'unknown' } }).lyrics.wordEffect,
    ).toBe('jump');
  });

  it('updates the lyrics focus-sidebar preference without changing appearance', () => {
    usePreferencesStore.setState(defaultPreferences);
    usePreferencesStore.getState().updateLyrics({ focusSidebarCollapsed: true });
    expect(usePreferencesStore.getState().lyrics.focusSidebarCollapsed).toBe(true);
    expect(usePreferencesStore.getState().appearance).toEqual(defaultPreferences.appearance);
  });

  it('preserves the explicit lyric-surface interaction state', () => {
    const normalized = normalizePreferences({
      version: 2,
      surfaces: {
        desktop: {
          enabled: true,
          interaction: 'passive-locked',
          alwaysOnTop: false,
        },
      },
    });
    expect(normalized.surfaces.desktop).toEqual(
      expect.objectContaining({
        enabled: true,
        interaction: 'passive-locked',
        alwaysOnTop: false,
      }),
    );
  });

  it('migrates legacy lock/click-through and removes taskbar state', () => {
    const legacy = {
      version: 1,
      surfaces: {
        desktop: { locked: false, clickThrough: true, backgroundOpacity: 48 },
        island: { locked: true },
        taskbar: { enabled: true, locked: true },
      },
    };
    const normalized = normalizePreferences(legacy);
    expect(preferencesRequireMigration(legacy)).toBe(true);
    expect(normalized.version).toBe(2);
    expect(normalized.surfaces.desktop.interaction).toBe('passive-locked');
    expect(normalized.surfaces.desktop.backgroundOpacity).toBe(0);
    expect(normalized.surfaces.island.interaction).toBe('passive-locked');
    expect(normalized.surfaces).not.toHaveProperty('taskbar');
    expect(normalized.system).toEqual(defaultPreferences.system);
    expect(preferencesRequireMigration(normalized)).toBe(false);
  });

  it('resets appearance without deleting locale or lyric preferences', () => {
    usePreferencesStore.setState({
      locale: 'zh-CN',
      appearance: { ...defaultPreferences.appearance, primaryColor: '#123456' },
      lyrics: { ...defaultPreferences.lyrics, timingOffsetMs: 320 },
    });
    usePreferencesStore.getState().resetAppearance();
    expect(usePreferencesStore.getState().appearance).toEqual(defaultPreferences.appearance);
    expect(usePreferencesStore.getState().locale).toBe('zh-CN');
    expect(usePreferencesStore.getState().lyrics.timingOffsetMs).toBe(320);
  });

  it('writes and clears the synchronous explicit-locale startup cache', () => {
    usePreferencesStore.getState().setLocale('zh-CN');
    expect(window.localStorage.getItem('yaqmc.locale')).toBe('zh-CN');
    usePreferencesStore.getState().setLocale('system');
    expect(window.localStorage.getItem('yaqmc.locale')).toBeNull();
  });

  it('normalizes desktop integration preferences conservatively', () => {
    expect(
      normalizePreferences({
        version: 2,
        system: { closeBehavior: 'quit', globalShortcutsEnabled: true },
      }).system,
    ).toEqual({ closeBehavior: 'quit', globalShortcutsEnabled: true });
    expect(
      normalizePreferences({ system: { closeBehavior: 'invalid', globalShortcutsEnabled: 'yes' } })
        .system,
    ).toEqual(defaultPreferences.system);
  });

  it('normalizes debug preferences and keeps the FPS counter opt-in by default', () => {
    expect(normalizePreferences({ version: 2 }).debug).toEqual({ showFpsCounter: false });
    expect(
      normalizePreferences({ version: 2, debug: { showFpsCounter: 'yes' } }).debug.showFpsCounter,
    ).toBe(false);
    expect(
      normalizePreferences({ version: 2, debug: { showFpsCounter: true } }).debug.showFpsCounter,
    ).toBe(true);
  });

  it('updates debug preferences without changing appearance or lyrics', () => {
    usePreferencesStore.setState(defaultPreferences);
    usePreferencesStore.getState().updateDebug({ showFpsCounter: true });
    expect(usePreferencesStore.getState().debug.showFpsCounter).toBe(true);
    expect(usePreferencesStore.getState().appearance).toEqual(defaultPreferences.appearance);
    expect(usePreferencesStore.getState().lyrics).toEqual(defaultPreferences.lyrics);
  });

  it('persists lyrics preset selection, overrides, and custom presets', () => {
    const selected = normalizePreferences({
      lyricsPresets: {
        schemaVersion: 1,
        selectedId: 'builtin.vinyl',
        overrides: { 'builtin.vinyl': { typography: { fontScale: 1.1 } } },
        custom: [],
      },
    });
    expect(selected.lyrics.coverLayout).toBe('vinyl');
    expect(selected.lyricsPresets.selectedId).toBe('builtin.vinyl');
    expect(selected.lyricsPresets.overrides['builtin.vinyl']?.typography?.fontScale).toBe(1.1);

    const created = normalizePreferences({
      lyricsPresets: {
        schemaVersion: 1,
        selectedId: 'custom.keep-me',
        overrides: {},
        custom: [
          {
            schemaVersion: 1,
            id: 'custom.keep-me',
            nameKey: 'custom',
            name: 'Studio',
            source: 'custom',
            layout: 'full',
            typography: { fontScale: 1.2, lineHeight: 1.3 },
            artwork: { style: 'square' },
            background: { fit: 'cover', fallbackColor: '#20231C' },
          },
        ],
      },
    });
    expect(created.lyricsPresets.custom[0]?.id).toBe('custom.keep-me');
    expect(created.lyrics.coverLayout).toBe('full');
    expect(preferencesRequireMigration({ version: 2 })).toBe(true);
  });
});

describe('formatBackgroundPickerError', () => {
  it('keeps generic Core messages and hides filesystem paths', () => {
    expect(
      formatBackgroundPickerError(
        new Error('payload length 1600000 exceeds cap 1048576'),
        'fallback',
      ),
    ).toBe('payload length 1600000 exceeds cap 1048576');
    expect(
      formatBackgroundPickerError(new Error('selected file is not a supported image'), 'fallback'),
    ).toBe('selected file is not a supported image');
    expect(
      formatBackgroundPickerError(new Error('C:\\Users\\alice\\Pictures\\wall.png'), 'fallback'),
    ).toBe('fallback');
    expect(formatBackgroundPickerError(new Error(''), 'fallback')).toBe('fallback');
  });
});
