import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('./yaqmc-runtime', () => ({
  getYaqmcClient: () => ({
    invoke: invokeMock,
    on: () => () => undefined,
  }),
}));

vi.mock('./native-player-runtime', () => ({
  isNativeRuntime: true,
}));

import {
  defaultPreferences,
  flushPreferencesPersist,
  hasPendingPreferencePersist,
  PREFERENCES_PERSIST_DEBOUNCE_MS,
  resetPreferencesPersistForTest,
  usePreferencesStore,
} from './preferences';

function preferenceSets(): unknown[] {
  return invokeMock.mock.calls
    .filter((call) => call[0] === 'app_preferences_set')
    .map((call) => call[1]);
}

describe('preference persist coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    resetPreferencesPersistForTest();
    usePreferencesStore.setState({
      ...defaultPreferences,
      appearance: { ...defaultPreferences.appearance },
      system: { ...defaultPreferences.system },
      hydrated: true,
      persistenceError: null,
    });
  });

  afterEach(() => {
    resetPreferencesPersistForTest();
    vi.useRealTimers();
  });

  it('coalesces rapid appearance slider writes into one app_preferences_set', async () => {
    for (const surfaceOpacity of [85, 88, 91, 94, 97, 100, 93, 90]) {
      usePreferencesStore.getState().updateAppearance({ surfaceOpacity });
    }
    expect(usePreferencesStore.getState().appearance.surfaceOpacity).toBe(90);
    expect(hasPendingPreferencePersist()).toBe(true);
    expect(preferenceSets()).toEqual([]);

    vi.advanceTimersByTime(PREFERENCES_PERSIST_DEBOUNCE_MS);
    await Promise.resolve();

    expect(preferenceSets()).toHaveLength(1);
    const payload = preferenceSets()[0] as { value: string };
    expect(JSON.parse(payload.value).appearance.surfaceOpacity).toBe(90);
  });

  it('persists system shortcut preference immediately so restart can restore it', async () => {
    usePreferencesStore.getState().updateSystem({ globalShortcutsEnabled: true });
    await Promise.resolve();
    expect(preferenceSets()).toHaveLength(1);
    const payload = preferenceSets()[0] as { value: string };
    expect(JSON.parse(payload.value).system.globalShortcutsEnabled).toBe(true);
  });

  it('keeps a local persist generation pending until flush completes', () => {
    usePreferencesStore.getState().updateAppearance({ surfaceOpacity: 92 });
    expect(hasPendingPreferencePersist()).toBe(true);
    vi.advanceTimersByTime(PREFERENCES_PERSIST_DEBOUNCE_MS);
    expect(hasPendingPreferencePersist()).toBe(true);
    flushPreferencesPersist();
    expect(preferenceSets().length).toBeGreaterThanOrEqual(1);
  });
});
