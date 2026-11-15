import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, renderHook } from '@testing-library/react';
import { useGlobalShortcuts } from './use-global-shortcuts';
import { defaultPreferences, usePreferencesStore } from './preferences';
import { usePlayerStore } from './player-store';
vi.mock('./plugin-runtime', () => ({ dispatchPluginShortcut: vi.fn() }));

afterEach(() => {
  cleanup();
  usePreferencesStore.setState({ ...defaultPreferences, system: { ...defaultPreferences.system } });
});
describe('application shortcuts', () => {
  it('changes and clamps volume, ignores editable input and respects custom bindings', () => {
    const actions = { navigate: vi.fn(), closeLyrics: vi.fn(), toggleLyricsFullscreen: vi.fn() };
    usePlayerStore.setState({ volume: 0.98 });
    renderHook(() => useGlobalShortcuts(actions));
    fireEvent.keyDown(window, { code: 'ArrowUp', ctrlKey: true });
    expect(usePlayerStore.getState().volume).toBe(1);
    const input = document.createElement('input');
    document.body.append(input);
    fireEvent.keyDown(input, { code: 'ArrowDown', ctrlKey: true });
    expect(usePlayerStore.getState().volume).toBe(1);
    input.remove();
    usePreferencesStore.setState({
      system: {
        ...defaultPreferences.system,
        shortcutBindings: { ...defaultPreferences.system.shortcutBindings, volumeDown: 'alt+V' },
      },
    });
    fireEvent.keyDown(window, { code: 'ArrowDown', ctrlKey: true });
    expect(usePlayerStore.getState().volume).toBe(1);
    fireEvent.keyDown(window, { code: 'KeyV', altKey: true });
    expect(usePlayerStore.getState().volume).toBeCloseTo(0.95);
  });
});
