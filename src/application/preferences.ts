import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import i18n, { LOCALE_CACHE_KEY, resolveLocale, type LocalePreference } from '../i18n';
import {
  generateThemeTokens,
  isValidHexColor,
  normalizeHexColor,
  palettePresets,
  type ColorModePreference,
  type PaletteId,
  type ResolvedColorMode,
} from './theme-tokens';

const PREFERENCES_CACHE_KEY = 'yaqmc.preferences.v2';
const LEGACY_PREFERENCES_CACHE_KEY = 'music-client.preferences.v1';
const nativeRuntime = isTauri();

export type SecondaryLyricVisibility = 'auto' | 'show' | 'hide';
export type LyricFontSize = 'small' | 'medium' | 'large';
export type LyricCoverLayout = 'split' | 'full' | 'vinyl';
export type BackgroundMode = 'default' | 'artwork' | 'color' | 'image';
export type MaterialMode = 'opaque' | 'translucent';
export type SurfaceKind = 'desktop' | 'island';
export type SurfaceInteraction = 'interactive' | 'passive-locked';
export type SurfaceLineMode = 'single' | 'double';
export type SurfaceAlignment = 'left' | 'center' | 'right';
export type SurfaceWidth = 'compact' | 'regular' | 'wide';
export type FontMode = 'system' | 'application' | 'custom';
export type CloseBehavior = 'hide-to-tray' | 'quit';

export interface SystemSettings {
  closeBehavior: CloseBehavior;
  globalShortcutsEnabled: boolean;
}

export interface DebugSettings {
  showFpsCounter: boolean;
}

export interface AppearanceSettings {
  colorMode: ColorModePreference;
  palette: PaletteId;
  primaryColor: string;
  secondaryColor: string;
  backgroundMode: BackgroundMode;
  backgroundColor: string;
  backgroundImageReference: string | null;
  backgroundFit: 'cover' | 'contain';
  artworkInfluence: number;
  surfaceOpacity: number;
  material: MaterialMode;
}

export interface LyricDisplaySettings {
  translation: SecondaryLyricVisibility;
  romanization: SecondaryLyricVisibility;
  timingOffsetMs: number;
  fontSize: LyricFontSize;
  coverLayout: LyricCoverLayout;
  focusSidebarCollapsed: boolean;
}

export interface LyricSurfaceSettings {
  enabled: boolean;
  alwaysOnTop: boolean;
  interaction: SurfaceInteraction;
  hideInFullscreen: boolean;
  lineMode: SurfaceLineMode;
  fontSize: number;
  fontMode: FontMode;
  customFontFamily: string;
  alignment: SurfaceAlignment;
  primaryColor: string;
  secondaryColor: string;
  backgroundOpacity: number;
  horizontalPosition: number;
  verticalOffset: number;
  width: SurfaceWidth;
}

export interface AppPreferences {
  version: 2;
  locale: LocalePreference;
  appearance: AppearanceSettings;
  lyrics: LyricDisplaySettings;
  surfaces: Record<SurfaceKind, LyricSurfaceSettings>;
  system: SystemSettings;
  debug: DebugSettings;
}

const defaultSurface = (kind: SurfaceKind): LyricSurfaceSettings => ({
  enabled: false,
  alwaysOnTop: true,
  interaction: 'interactive',
  hideInFullscreen: true,
  lineMode: kind === 'island' ? 'single' : 'double',
  fontSize: kind === 'desktop' ? 30 : 17,
  fontMode: 'system',
  customFontFamily: '',
  alignment: 'center',
  primaryColor: '#FFFFFF',
  secondaryColor: '#C7CBC2',
  backgroundOpacity: kind === 'desktop' ? 0 : 82,
  horizontalPosition: 0,
  verticalOffset: 24,
  width: kind === 'desktop' ? 'wide' : 'regular',
});

export const defaultPreferences: AppPreferences = {
  version: 2,
  locale: 'system',
  appearance: {
    colorMode: 'system',
    palette: 'default',
    primaryColor: '#A8C95E',
    secondaryColor: '#7FA3A0',
    backgroundMode: 'default',
    backgroundColor: '#20231C',
    backgroundImageReference: null,
    backgroundFit: 'cover',
    artworkInfluence: 38,
    surfaceOpacity: 96,
    material: 'opaque',
  },
  lyrics: {
    translation: 'auto',
    romanization: 'auto',
    timingOffsetMs: 0,
    fontSize: 'medium',
    coverLayout: 'split',
    focusSidebarCollapsed: false,
  },
  surfaces: {
    desktop: defaultSurface('desktop'),
    island: defaultSurface('island'),
  },
  system: {
    closeBehavior: 'hide-to-tray',
    globalShortcutsEnabled: false,
  },
  debug: {
    showFpsCounter: false,
  },
};

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function valueIn<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? (value as T) : fallback;
}

type LegacySurfaceSettings = Partial<LyricSurfaceSettings> & {
  locked?: boolean;
  clickThrough?: boolean;
};

function normalizeSurface(
  value: unknown,
  kind: SurfaceKind,
  legacyPreferences: boolean,
): LyricSurfaceSettings {
  const fallback = defaultSurface(kind);
  const source = value && typeof value === 'object' ? (value as LegacySurfaceSettings) : {};
  const migratedInteraction =
    source.locked === true || source.clickThrough === true ? 'passive-locked' : 'interactive';
  const backgroundOpacity =
    legacyPreferences && kind === 'desktop' && source.backgroundOpacity === 48
      ? 0
      : source.backgroundOpacity;
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
    alwaysOnTop:
      typeof source.alwaysOnTop === 'boolean' ? source.alwaysOnTop : fallback.alwaysOnTop,
    interaction: valueIn(
      source.interaction,
      ['interactive', 'passive-locked'],
      legacyPreferences ? migratedInteraction : fallback.interaction,
    ),
    hideInFullscreen:
      typeof source.hideInFullscreen === 'boolean'
        ? source.hideInFullscreen
        : fallback.hideInFullscreen,
    lineMode: valueIn(source.lineMode, ['single', 'double'], fallback.lineMode),
    fontSize: numberInRange(source.fontSize, fallback.fontSize, 12, 64),
    fontMode: valueIn(source.fontMode, ['system', 'application', 'custom'], fallback.fontMode),
    customFontFamily:
      typeof source.customFontFamily === 'string'
        ? source.customFontFamily.slice(0, 80)
        : fallback.customFontFamily,
    alignment: valueIn(source.alignment, ['left', 'center', 'right'], fallback.alignment),
    primaryColor: normalizeHexColor(
      source.primaryColor ?? fallback.primaryColor,
      fallback.primaryColor,
    ),
    secondaryColor: normalizeHexColor(
      source.secondaryColor ?? fallback.secondaryColor,
      fallback.secondaryColor,
    ),
    backgroundOpacity: numberInRange(backgroundOpacity, fallback.backgroundOpacity, 0, 100),
    horizontalPosition: numberInRange(
      source.horizontalPosition,
      fallback.horizontalPosition,
      -100,
      100,
    ),
    verticalOffset: numberInRange(source.verticalOffset, fallback.verticalOffset, 0, 240),
    width: valueIn(source.width, ['compact', 'regular', 'wide'], fallback.width),
  };
}

export function normalizePreferences(value: unknown): AppPreferences {
  const source = value && typeof value === 'object' ? (value as Partial<AppPreferences>) : {};
  const legacyPreferences = source.version !== 2;
  const appearance = (
    source.appearance && typeof source.appearance === 'object' ? source.appearance : {}
  ) as Partial<AppearanceSettings>;
  const lyrics = (
    source.lyrics && typeof source.lyrics === 'object' ? source.lyrics : {}
  ) as Partial<LyricDisplaySettings>;
  const surfaces = (
    source.surfaces && typeof source.surfaces === 'object' ? source.surfaces : {}
  ) as Partial<Record<SurfaceKind, LyricSurfaceSettings>>;
  const system = (
    source.system && typeof source.system === 'object' ? source.system : {}
  ) as Partial<SystemSettings>;
  const debug = (
    source.debug && typeof source.debug === 'object' ? source.debug : {}
  ) as Partial<DebugSettings>;
  return {
    version: 2,
    locale: valueIn(source.locale, ['system', 'en-US', 'zh-CN'], 'system'),
    appearance: {
      colorMode: valueIn(appearance.colorMode, ['system', 'light', 'dark'], 'system'),
      palette: valueIn(
        appearance.palette,
        ['default', 'ember', 'ocean', 'violet', 'sakura', 'mint', 'mono', 'custom'],
        'default',
      ),
      primaryColor: normalizeHexColor(appearance.primaryColor ?? '#A8C95E'),
      secondaryColor: normalizeHexColor(appearance.secondaryColor ?? '#7FA3A0', '#7FA3A0'),
      backgroundMode: valueIn(
        appearance.backgroundMode,
        ['default', 'artwork', 'color', 'image'],
        'default',
      ),
      backgroundColor: normalizeHexColor(appearance.backgroundColor ?? '#20231C', '#20231C'),
      backgroundImageReference:
        typeof appearance.backgroundImageReference === 'string'
          ? appearance.backgroundImageReference.slice(0, 160)
          : null,
      backgroundFit: valueIn(appearance.backgroundFit, ['cover', 'contain'], 'cover'),
      artworkInfluence: numberInRange(appearance.artworkInfluence, 38, 0, 100),
      surfaceOpacity: numberInRange(appearance.surfaceOpacity, 96, 85, 100),
      material: valueIn(appearance.material, ['opaque', 'translucent'], 'opaque'),
    },
    lyrics: {
      translation: valueIn(lyrics.translation, ['auto', 'show', 'hide'], 'auto'),
      romanization: valueIn(lyrics.romanization, ['auto', 'show', 'hide'], 'auto'),
      timingOffsetMs: numberInRange(lyrics.timingOffsetMs, 0, -2_000, 2_000),
      fontSize: valueIn(lyrics.fontSize, ['small', 'medium', 'large'], 'medium'),
      coverLayout: valueIn(lyrics.coverLayout, ['split', 'full', 'vinyl'], 'split'),
      focusSidebarCollapsed:
        typeof lyrics.focusSidebarCollapsed === 'boolean' ? lyrics.focusSidebarCollapsed : false,
    },
    surfaces: {
      desktop: normalizeSurface(surfaces.desktop, 'desktop', legacyPreferences),
      island: normalizeSurface(surfaces.island, 'island', legacyPreferences),
    },
    system: {
      closeBehavior: valueIn(system.closeBehavior, ['hide-to-tray', 'quit'], 'hide-to-tray'),
      globalShortcutsEnabled:
        typeof system.globalShortcutsEnabled === 'boolean' ? system.globalShortcutsEnabled : false,
    },
    debug: {
      showFpsCounter: typeof debug.showFpsCounter === 'boolean' ? debug.showFpsCounter : false,
    },
  };
}

export function preferencesRequireMigration(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  const source = value as {
    version?: unknown;
    surfaces?: Record<string, unknown>;
    system?: Record<string, unknown>;
  };
  if (
    source.version !== 2 ||
    source.surfaces?.taskbar ||
    !source.system ||
    !['hide-to-tray', 'quit'].includes(String(source.system.closeBehavior)) ||
    typeof source.system.globalShortcutsEnabled !== 'boolean'
  ) {
    return true;
  }
  return ['desktop', 'island'].some((kind) => {
    const surface = source.surfaces?.[kind];
    return Boolean(
      surface && typeof surface === 'object' && ('locked' in surface || 'clickThrough' in surface),
    );
  });
}

function readCachedPreferences(): AppPreferences {
  if (typeof window === 'undefined') return defaultPreferences;
  try {
    const cached =
      window.localStorage.getItem(PREFERENCES_CACHE_KEY) ??
      window.localStorage.getItem(LEGACY_PREFERENCES_CACHE_KEY);
    return cached ? normalizePreferences(JSON.parse(cached)) : defaultPreferences;
  } catch {
    return defaultPreferences;
  }
}

export const initialPreferences = readCachedPreferences();

function writeCache(preferences: AppPreferences): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(PREFERENCES_CACHE_KEY, JSON.stringify(preferences));
  window.localStorage.removeItem(LEGACY_PREFERENCES_CACHE_KEY);
  if (preferences.locale === 'system') window.localStorage.removeItem(LOCALE_CACHE_KEY);
  else window.localStorage.setItem(LOCALE_CACHE_KEY, preferences.locale);
}

let persistGeneration = 0;
function persist(preferences: AppPreferences): void {
  writeCache(preferences);
  if (!nativeRuntime) return;
  const generation = ++persistGeneration;
  void invoke('app_preferences_set', { value: JSON.stringify(preferences) }).catch((error) => {
    if (generation === persistGeneration) {
      usePreferencesStore.setState({ persistenceError: String(error) });
    }
  });
}

interface PreferencesState extends AppPreferences {
  hydrated: boolean;
  persistenceError: string | null;
  backgroundImageData: string | null;
  backgroundImageMissing: boolean;
  setLocale: (locale: LocalePreference) => void;
  updateAppearance: (patch: Partial<AppearanceSettings>) => void;
  selectPalette: (palette: PaletteId) => void;
  resetAppearance: () => void;
  updateLyrics: (patch: Partial<LyricDisplaySettings>) => void;
  updateSystem: (patch: Partial<SystemSettings>) => void;
  updateDebug: (patch: Partial<DebugSettings>) => void;
  updateSurface: (kind: SurfaceKind, patch: Partial<LyricSurfaceSettings>) => void;
  setSurfaceInteractionLocal: (kind: SurfaceKind, interaction: SurfaceInteraction) => void;
  setManagedBackground: (reference: string, dataUri: string) => void;
  setBackgroundImageState: (dataUri: string | null, missing: boolean) => void;
  hydrate: (preferences: AppPreferences) => void;
}

function persistedSlice(state: PreferencesState): AppPreferences {
  return {
    version: 2,
    locale: state.locale,
    appearance: state.appearance,
    lyrics: state.lyrics,
    surfaces: state.surfaces,
    system: state.system,
    debug: state.debug,
  };
}

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  ...initialPreferences,
  hydrated: !nativeRuntime,
  persistenceError: null,
  backgroundImageData: null,
  backgroundImageMissing: false,
  setLocale: (locale) => {
    set({ locale, persistenceError: null });
    persist(persistedSlice(get()));
  },
  updateAppearance: (patch) => {
    set((state) => ({
      appearance: normalizePreferences({
        ...persistedSlice(state),
        appearance: { ...state.appearance, ...patch },
      }).appearance,
      persistenceError: null,
    }));
    persist(persistedSlice(get()));
  },
  selectPalette: (palette) => {
    const preset = palettePresets.find((candidate) => candidate.id === palette);
    get().updateAppearance({
      palette,
      ...(preset ? { primaryColor: preset.primary, secondaryColor: preset.secondary } : {}),
    });
  },
  resetAppearance: () => {
    set({
      appearance: defaultPreferences.appearance,
      backgroundImageData: null,
      backgroundImageMissing: false,
      persistenceError: null,
    });
    persist(persistedSlice(get()));
  },
  updateLyrics: (patch) => {
    set((state) => ({
      lyrics: normalizePreferences({
        ...persistedSlice(state),
        lyrics: { ...state.lyrics, ...patch },
      }).lyrics,
      persistenceError: null,
    }));
    persist(persistedSlice(get()));
  },
  updateSystem: (patch) => {
    set((state) => ({
      system: normalizePreferences({
        ...persistedSlice(state),
        system: { ...state.system, ...patch },
      }).system,
      persistenceError: null,
    }));
    persist(persistedSlice(get()));
  },
  updateDebug: (patch) => {
    set((state) => ({
      debug: normalizePreferences({
        ...persistedSlice(state),
        debug: { ...state.debug, ...patch },
      }).debug,
      persistenceError: null,
    }));
    persist(persistedSlice(get()));
  },
  updateSurface: (kind, patch) => {
    set((state) => ({
      surfaces: {
        ...state.surfaces,
        [kind]: normalizeSurface({ ...state.surfaces[kind], ...patch }, kind, false),
      },
      persistenceError: null,
    }));
    persist(persistedSlice(get()));
  },
  setSurfaceInteractionLocal: (kind, interaction) => {
    set((state) => ({
      surfaces: {
        ...state.surfaces,
        [kind]: { ...state.surfaces[kind], interaction },
      },
      persistenceError: null,
    }));
  },
  setManagedBackground: (reference, dataUri) => {
    set((state) => ({
      appearance: {
        ...state.appearance,
        backgroundImageReference: reference,
        backgroundMode: 'image',
      },
      backgroundImageData: dataUri,
      backgroundImageMissing: false,
    }));
    persist(persistedSlice(get()));
  },
  setBackgroundImageState: (backgroundImageData, backgroundImageMissing) =>
    set({ backgroundImageData, backgroundImageMissing }),
  hydrate: (preferences) => {
    writeCache(preferences);
    set({ ...preferences, hydrated: true, persistenceError: null });
  },
}));

let hydration: Promise<void> | null = null;
export function hydratePreferences(): Promise<void> {
  if (!nativeRuntime) return Promise.resolve();
  hydration ??= invoke<string | null>('app_preferences_get')
    .then((value) => {
      const parsed = value ? JSON.parse(value) : null;
      const preferences = value ? normalizePreferences(parsed) : initialPreferences;
      usePreferencesStore.getState().hydrate(preferences);
      if (!value || preferencesRequireMigration(parsed)) persist(preferences);
    })
    .catch((error) => {
      usePreferencesStore.setState({ hydrated: true, persistenceError: String(error) });
    });
  return hydration;
}

export interface ManagedBackgroundImage {
  reference: string;
  dataUri: string;
}

export async function pickManagedBackgroundImage(): Promise<ManagedBackgroundImage | null> {
  if (!nativeRuntime) return null;
  return invoke<ManagedBackgroundImage | null>('appearance_pick_background');
}

function resolveSystemMode(): ResolvedColorMode {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

export function useResolvedColorMode(preference: ColorModePreference): ResolvedColorMode {
  const [systemMode, setSystemMode] = useState<ResolvedColorMode>(resolveSystemMode);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return;
    }
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const update = () => setSystemMode(media.matches ? 'light' : 'dark');
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return preference === 'system' ? systemMode : preference;
}

export function applyAppearance(
  appearance: AppearanceSettings,
  resolvedMode: ResolvedColorMode,
): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = resolvedMode;
  root.dataset.material = appearance.material;
  root.dataset.background = appearance.backgroundMode;
  for (const [name, value] of Object.entries(
    generateThemeTokens({
      mode: resolvedMode,
      primary: appearance.primaryColor,
      secondary: appearance.secondaryColor,
      surfaceOpacity: appearance.surfaceOpacity,
      material: appearance.material,
    }),
  )) {
    root.style.setProperty(name, value);
  }
  root.style.setProperty('--custom-background-color', appearance.backgroundColor);
  root.style.setProperty('--artwork-influence', `${appearance.artworkInfluence / 100}`);
}

const initialMode =
  initialPreferences.appearance.colorMode === 'system'
    ? resolveSystemMode()
    : initialPreferences.appearance.colorMode;
applyAppearance(initialPreferences.appearance, initialMode);

export function usePreferencesRuntime(reconcileSurfaces: boolean): ResolvedColorMode {
  const locale = usePreferencesStore((state) => state.locale);
  const appearance = usePreferencesStore((state) => state.appearance);
  const surfaces = usePreferencesStore((state) => state.surfaces);
  const hydrated = usePreferencesStore((state) => state.hydrated);
  const setBackgroundImageState = usePreferencesStore((state) => state.setBackgroundImageState);
  const resolvedMode = useResolvedColorMode(appearance.colorMode);

  useEffect(() => {
    void hydratePreferences();
  }, []);

  useEffect(() => {
    if (!nativeRuntime) return;
    let active = true;
    const listeners: UnlistenFn[] = [];
    void listen<string>('preferences://changed', (event) => {
      if (!active) return;
      try {
        usePreferencesStore.getState().hydrate(normalizePreferences(JSON.parse(event.payload)));
      } catch {
        // Invalid cross-window state is ignored; Rust validates persisted documents.
      }
    }).then((unlisten) => (active ? listeners.push(unlisten) : unlisten()));
    void listen<string>('lyrics://surface-closed', (event) => {
      if (!active || !['desktop', 'island'].includes(event.payload)) return;
      const kind = event.payload as SurfaceKind;
      const store = usePreferencesStore.getState();
      if (store.surfaces[kind].enabled) store.updateSurface(kind, { enabled: false });
    }).then((unlisten) => (active ? listeners.push(unlisten) : unlisten()));
    return () => {
      active = false;
      listeners.forEach((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const resolved = resolveLocale(locale);
    document.documentElement.lang = resolved;
    void i18n.changeLanguage(resolved);
  }, [locale]);

  useEffect(() => applyAppearance(appearance, resolvedMode), [appearance, resolvedMode]);

  useEffect(() => {
    if (
      !nativeRuntime ||
      appearance.backgroundMode !== 'image' ||
      !appearance.backgroundImageReference
    ) {
      setBackgroundImageState(null, false);
      return;
    }
    let active = true;
    void invoke<ManagedBackgroundImage | null>('appearance_background_load', {
      reference: appearance.backgroundImageReference,
    })
      .then((image) => {
        if (active) setBackgroundImageState(image?.dataUri ?? null, !image);
      })
      .catch(() => {
        if (active) setBackgroundImageState(null, true);
      });
    return () => {
      active = false;
    };
  }, [appearance.backgroundImageReference, appearance.backgroundMode, setBackgroundImageState]);

  useEffect(() => {
    if (!nativeRuntime || !reconcileSurfaces || !hydrated) return;
    const timer = window.setTimeout(() => {
      void invoke('lyrics_surfaces_reconcile', { surfaces }).catch((error) => {
        usePreferencesStore.setState({ persistenceError: String(error) });
      });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [hydrated, reconcileSurfaces, surfaces]);

  return resolvedMode;
}

export function useBackgroundStyle(): {
  mode: BackgroundMode;
  source: string | null;
  fit: 'cover' | 'contain';
  color: string;
  influence: number;
  missing: boolean;
} {
  const appearance = usePreferencesStore((state) => state.appearance);
  const source = usePreferencesStore((state) => state.backgroundImageData);
  const missing = usePreferencesStore((state) => state.backgroundImageMissing);
  return useMemo(
    () => ({
      mode: appearance.backgroundMode,
      source,
      fit: appearance.backgroundFit,
      color: appearance.backgroundColor,
      influence: appearance.artworkInfluence,
      missing,
    }),
    [appearance, missing, source],
  );
}

export function validatedColorPatch(value: string, fallback: string): string | null {
  return isValidHexColor(value) ? normalizeHexColor(value, fallback) : null;
}
