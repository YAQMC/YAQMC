import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultPreferences,
  finishAppearancePreview,
  previewAppearance,
  usePreferencesStore,
} from './preferences';

describe('appearance live preview', () => {
  let callbacks: FrameRequestCallback[];

  beforeEach(() => {
    callbacks = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    usePreferencesStore.setState({
      ...defaultPreferences,
      appearance: { ...defaultPreferences.appearance },
    });
  });

  afterEach(() => {
    finishAppearancePreview();
    vi.restoreAllMocks();
  });

  it('coalesces rapid input into one frame without mutating persisted state', () => {
    previewAppearance({ primaryColor: '#111111' });
    previewAppearance({ primaryColor: '#222222' });
    previewAppearance({ primaryColor: '#336699' });

    expect(window.requestAnimationFrame).toHaveBeenCalledOnce();
    expect(usePreferencesStore.getState().appearance.primaryColor).toBe('#A8C95E');

    callbacks[0]?.(16);
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('#336699');
    expect(usePreferencesStore.getState().appearance.primaryColor).toBe('#A8C95E');
  });
});
