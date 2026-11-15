import { afterEach, describe, expect, it } from 'vitest';
import {
  activatePluginShortcuts,
  applyPluginShortcutCall,
  clearPluginShortcuts,
  matchingPluginShortcut,
} from './plugin-shortcuts';
import { defaultPreferences, usePreferencesStore } from './preferences';

afterEach(() => {
  clearPluginShortcuts();
  usePreferencesStore.setState({ ...defaultPreferences, system: { ...defaultPreferences.system } });
});
describe('plugin commands', () => {
  it('validates candidate registrations but keeps them inert until the update commits', () => {
    applyPluginShortcutCall(
      'dev.a',
      'A',
      'shortcuts.register',
      { id: 'refresh', label: 'Refresh', accelerator: 'control+shift+L' },
      true,
    );
    const event = new KeyboardEvent('keydown', { code: 'KeyL', ctrlKey: true, shiftKey: true });
    expect(matchingPluginShortcut(event)).toBeUndefined();
    expect(applyPluginShortcutCall('dev.a', 'A', 'shortcuts.list', {})).toEqual([
      { id: 'refresh', label: 'Refresh', accelerator: 'control+shift+L' },
    ]);
    activatePluginShortcuts('dev.a');
    expect(matchingPluginShortcut(event)?.pluginId).toBe('dev.a');
  });
  it('isolates commands, persists overrides and unregisters on retirement', () => {
    applyPluginShortcutCall('dev.a', 'A', 'shortcuts.register', {
      id: 'refresh',
      label: 'Refresh',
      accelerator: 'control+shift+L',
    });
    expect(applyPluginShortcutCall('dev.b', 'B', 'shortcuts.list', {})).toEqual([]);
    expect(() =>
      applyPluginShortcutCall('dev.b', 'B', 'shortcuts.set', {
        id: 'refresh',
        accelerator: 'alt+L',
      }),
    ).toThrow('not-found');
    applyPluginShortcutCall('dev.a', 'A', 'shortcuts.set', { id: 'refresh', accelerator: 'alt+L' });
    expect(
      matchingPluginShortcut(new KeyboardEvent('keydown', { code: 'KeyL', altKey: true }))
        ?.pluginId,
    ).toBe('dev.a');
    clearPluginShortcuts('dev.a');
    expect(
      matchingPluginShortcut(new KeyboardEvent('keydown', { code: 'KeyL', altKey: true })),
    ).toBeUndefined();
    applyPluginShortcutCall('dev.a', 'A', 'shortcuts.register', {
      id: 'refresh',
      label: 'Refresh',
      accelerator: 'control+shift+L',
    });
    expect(applyPluginShortcutCall('dev.a', 'A', 'shortcuts.list', {})).toEqual([
      { id: 'refresh', label: 'Refresh', accelerator: 'alt+L' },
    ]);
  });
  it('rejects conflicts (including platform mod aliases) and quotas without replacing other commands', () => {
    expect(() =>
      applyPluginShortcutCall('dev.a', 'A', 'shortcuts.register', {
        id: 'search',
        label: 'Search',
        accelerator: 'mod+K',
      }),
    ).toThrow('conflict');
    for (let n = 1; n <= 8; n++)
      applyPluginShortcutCall('dev.a', 'A', 'shortcuts.register', {
        id: `c${n}`,
        label: 'Command',
        accelerator: null,
      });
    expect(() =>
      applyPluginShortcutCall('dev.a', 'A', 'shortcuts.register', {
        id: 'c9',
        label: 'Command',
        accelerator: null,
      }),
    ).toThrow('limit');
    expect(applyPluginShortcutCall('dev.a', 'A', 'shortcuts.list', {}) as unknown[]).toHaveLength(
      8,
    );
  });
});
