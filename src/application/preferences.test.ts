import { describe, expect, it } from 'vitest';
import {
  defaultPreferences,
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
    });
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
});
