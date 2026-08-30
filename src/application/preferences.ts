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
import {
  defaultLyricsPresetState,
  normalizeLyricsPresetState,
  presetIdForLayout,
  resolveLyricsPreset,
  type LyricsPresetState,
} from './lyrics-preset';
import { logger } from './logger';
import { isNativeRuntime } from './native-player-runtime';
import { getYaqmcClient } from './yaqmc-runtime';

const PREFERENCES_CACHE_KEY = 'yaqmc.preferences.v2';
const LEGACY_PREFERENCES_CACHE_KEY = 'music-client.preferences.v1';

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
export type InterfaceFontFamily = 'application' | 'system' | 'serif' | 'monospace';
export type CloseBehavior = 'hide-to-tray' | 'quit';

export interface SystemSettings {
  closeBehavior: CloseBehavior;
  globalShortcutsEnabled: boolean;
  deepLinksEnabled: boolean;
}

export interface DebugSettings {
  showFpsCounter: boolean;
}

export interface AppearanceSettings {
  colorMode: ColorModePreference;
  /** Whole-application interface type scale, expressed as a percentage. */
  interfaceFontScale: number;
  /** A curated, platform-safe interface font stack. */
  interfaceFontFamily: InterfaceFontFamily;
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

export type LyricWordEffect = 'fill' | 'jump';
export const LYRIC_FONT_WEIGHTS = ['400', '500', '600', '700', '800', '900'] as const;
export type LyricFontWeight = (typeof LYRIC_FONT_WEIGHTS)[number];

export interface LyricDisplaySettings {
  translation: SecondaryLyricVisibility;
  romanization: SecondaryLyricVisibility;
  timingOffsetMs: number;
  fontSize: LyricFontSize;
  coverLayout: LyricCoverLayout;
  focusSidebarCollapsed: boolean;
  wordEffect: LyricWordEffect;
  fontWeight: LyricFontWeight;
}

/** Settings forwarded to the official Apple Music-like Lyrics renderer. */
export interface AmllSettings {
  enableSpring: boolean;
  enableScale: boolean;
  enableBlur: boolean;
  hidePassedLines: boolean;
  wordFadeWidth: number;
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
  amll: AmllSettings;
  lyricsPresets: LyricsPresetState;
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
    interfaceFontScale: 100,
    interfaceFontFamily: 'application',
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
    wordEffect: 'jump',
    fontWeight: '700',
  },
  amll: {
    enableSpring: true,
    enableScale: true,
    enableBlur: true,
    hidePassedLines: false,
    wordFadeWidth: 0.5,
  },
  lyricsPresets: defaultLyricsPresetState,
  surfaces: {
    desktop: defaultSurface('desktop'),
    island: defaultSurface('island'),
  },
  system: {
    closeBehavior: 'hide-to-tray',
    globalShortcutsEnabled: false,
    deepLinksEnabled: true,
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
  const amll = (
    source.amll && typeof source.amll === 'object' ? source.amll : {}
  ) as Partial<AmllSettings>;
  const surfaces = (
    source.surfaces && typeof source.surfaces === 'object' ? source.surfaces : {}
  ) as Partial<Record<SurfaceKind, LyricSurfaceSettings>>;
  const system = (
    source.system && typeof source.system === 'object' ? source.system : {}
  ) as Partial<SystemSettings>;
  const debug = (
    source.debug && typeof source.debug === 'object' ? source.debug : {}
  ) as Partial<DebugSettings>;
  const coverLayout = valueIn(lyrics.coverLayout, ['split', 'full', 'vinyl'], 'split');
  const lyricsPresets = normalizeLyricsPresetState(
    'lyricsPresets' in source ? (source as { lyricsPresets?: unknown }).lyricsPresets : undefined,
    {
      coverLayout,
      preserveContainFit:
        !('lyricsPresets' in source) &&
        valueIn(appearance.backgroundFit, ['cover', 'contain'], 'cover') === 'contain',
    },
  );
  const resolvedPreset = resolveLyricsPreset(lyricsPresets);
  return {
    version: 2,
    locale: valueIn(source.locale, ['system', 'en-US', 'zh-CN'], 'system'),
    appearance: {
      colorMode: valueIn(appearance.colorMode, ['system', 'light', 'dark'], 'system'),
      interfaceFontScale: numberInRange(appearance.interfaceFontScale, 100, 80, 130),
      interfaceFontFamily: valueIn(
        appearance.interfaceFontFamily,
        ['application', 'system', 'serif', 'monospace'],
        'application',
      ),
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
      coverLayout: resolvedPreset.layout,
      focusSidebarCollapsed:
        typeof lyrics.focusSidebarCollapsed === 'boolean' ? lyrics.focusSidebarCollapsed : false,
      wordEffect: valueIn(lyrics.wordEffect, ['fill', 'jump'], 'jump'),
      fontWeight:
        typeof lyrics.fontWeight === 'string' &&
        LYRIC_FONT_WEIGHTS.includes(lyrics.fontWeight as LyricFontWeight)
          ? (lyrics.fontWeight as LyricFontWeight)
          : '700',
    },
    amll: {
      enableSpring: typeof amll.enableSpring === 'boolean' ? amll.enableSpring : true,
      enableScale: typeof amll.enableScale === 'boolean' ? amll.enableScale : true,
      enableBlur: typeof amll.enableBlur === 'boolean' ? amll.enableBlur : true,
      hidePassedLines: typeof amll.hidePassedLines === 'boolean' ? amll.hidePassedLines : false,
      wordFadeWidth: numberInRange(amll.wordFadeWidth, 0.5, 0.05, 1),
    },
    lyricsPresets,
    surfaces: {
      desktop: normalizeSurface(surfaces.desktop, 'desktop', legacyPreferences),
      island: normalizeSurface(surfaces.island, 'island', legacyPreferences),
    },
    system: {
      closeBehavior: valueIn(system.closeBehavior, ['hide-to-tray', 'quit'], 'hide-to-tray'),
      globalShortcutsEnabled:
        typeof system.globalShortcutsEnabled === 'boolean' ? system.globalShortcutsEnabled : false,
      deepLinksEnabled:
        typeof system.deepLinksEnabled === 'boolean' ? system.deepLinksEnabled : true,
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
    amll?: Record<string, unknown>;
  };
  if (
    source.version !== 2 ||
    source.surfaces?.taskbar ||
    !(source as { lyricsPresets?: unknown }).lyricsPresets ||
    !source.system ||
    !['hide-to-tray', 'quit'].includes(String(source.system.closeBehavior)) ||
    typeof source.system.globalShortcutsEnabled !== 'boolean' ||
    typeof source.system.deepLinksEnabled !== 'boolean' ||
    typeof source.amll?.enableSpring !== 'boolean' ||
    typeof source.amll?.enableScale !== 'boolean' ||
    typeof source.amll?.enableBlur !== 'boolean' ||
    typeof source.amll?.hidePassedLines !== 'boolean' ||
    typeof source.amll?.wordFadeWidth !== 'number' ||
    !LYRIC_FONT_WEIGHTS.includes(
      String(
        (source as { lyrics?: Record<string, unknown> }).lyrics?.fontWeight,
      ) as LyricFontWeight,
    )
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
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistQueued: AppPreferences | null = null;
let persistInFlight = false;

export const PREFERENCES_PERSIST_DEBOUNCE_MS = 200;

export function hasPendingPreferencePersist(): boolean {
  return persistQueued !== null || persistInFlight;
}

/** Host-owned lock/unlock must survive an in-flight Main appearance persist. */
export function mergePendingPersistSurfaceInteraction(incoming: AppPreferences): void {
  if (!persistQueued) {
    return;
  }
  persistQueued = {
    ...persistQueued,
    surfaces: {
      desktop: {
        ...persistQueued.surfaces.desktop,
        interaction: incoming.surfaces.desktop.interaction,
      },
      island: {
        ...persistQueued.surfaces.island,
        interaction: incoming.surfaces.island.interaction,
      },
    },
  };
}

/** A preferences snapshot cannot unlock a surface; only the host interaction event can. */
export function mergeHydratedSurfaces(
  current: AppPreferences['surfaces'],
  incoming: AppPreferences['surfaces'],
): AppPreferences['surfaces'] {
  return {
    desktop: {
      ...incoming.desktop,
      interaction:
        current.desktop.interaction === 'passive-locked'
          ? 'passive-locked'
          : incoming.desktop.interaction,
    },
    island: {
      ...incoming.island,
      interaction:
        current.island.interaction === 'passive-locked'
          ? 'passive-locked'
          : incoming.island.interaction,
    },
  };
}

export function flushPreferencesPersist(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const preferences = persistQueued;
  persistQueued = null;
  if (!preferences || !isNativeRuntime) {
    return;
  }
  const generation = ++persistGeneration;
  persistInFlight = true;
  void getYaqmcClient()
    .invoke('app_preferences_set', { value: JSON.stringify(preferences) })
    .catch((error) => {
      if (generation === persistGeneration) {
        usePreferencesStore.setState({ persistenceError: String(error) });
      }
    })
    .finally(() => {
      if (generation === persistGeneration) {
        persistInFlight = false;
      }
    });
}

export function resetPreferencesPersistForTest(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistQueued = null;
  persistInFlight = false;
  persistGeneration = 0;
}

function persist(preferences: AppPreferences, options?: { immediate?: boolean }): void {
  writeCache(preferences);
  if (!isNativeRuntime) return;
  persistQueued = preferences;
  if (options?.immediate) {
    flushPreferencesPersist();
    return;
  }
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushPreferencesPersist();
  }, PREFERENCES_PERSIST_DEBOUNCE_MS);
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
  updateAmll: (patch: Partial<AmllSettings>) => void;
  updateLyricsPresets: (
    recipe: LyricsPresetState | ((current: LyricsPresetState) => LyricsPresetState),
  ) => void;
  selectLyricsPreset: (id: string) => void;
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
    amll: state.amll,
    lyricsPresets: state.lyricsPresets,
    surfaces: state.surfaces,
    system: state.system,
    debug: state.debug,
  };
}

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  ...initialPreferences,
  hydrated: !isNativeRuntime,
  persistenceError: null,
  backgroundImageData: null,
  backgroundImageMissing: false,
  setLocale: (locale) => {
    set({ locale, persistenceError: null });
    persist(persistedSlice(get()), { immediate: true });
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
    set((state) => {
      const lyricsPresets =
        patch.coverLayout && patch.coverLayout !== state.lyrics.coverLayout
          ? { ...state.lyricsPresets, selectedId: presetIdForLayout(patch.coverLayout) }
          : state.lyricsPresets;
      if (patch.coverLayout && patch.coverLayout !== state.lyrics.coverLayout) {
        logger.info('lyrics.preset.select', 'selected lyrics preset', {
          id: presetIdForLayout(patch.coverLayout),
        });
      }
      const normalized = normalizePreferences({
        ...persistedSlice(state),
        lyrics: { ...state.lyrics, ...patch },
        lyricsPresets,
      });
      return {
        lyrics: normalized.lyrics,
        lyricsPresets: normalized.lyricsPresets,
        persistenceError: null,
      };
    });
    persist(persistedSlice(get()));
  },
  updateAmll: (patch) => {
    set((state) => ({
      amll: normalizePreferences({
        ...persistedSlice(state),
        amll: { ...state.amll, ...patch },
      }).amll,
      persistenceError: null,
    }));
    persist(persistedSlice(get()));
  },
  updateLyricsPresets: (recipe) => {
    set((state) => {
      const next = typeof recipe === 'function' ? recipe(state.lyricsPresets) : recipe;
      const normalized = normalizePreferences({
        ...persistedSlice(state),
        lyricsPresets: next,
      });
      return {
        lyrics: normalized.lyrics,
        lyricsPresets: normalized.lyricsPresets,
        persistenceError: null,
      };
    });
    persist(persistedSlice(get()));
  },
  selectLyricsPreset: (id) => {
    logger.info('lyrics.preset.select', 'selected lyrics preset', { id });
    get().updateLyricsPresets((current) => ({ ...current, selectedId: id }));
  },
  updateSystem: (patch) => {
    set((state) => ({
      system: normalizePreferences({
        ...persistedSlice(state),
        system: { ...state.system, ...patch },
      }).system,
      persistenceError: null,
    }));
    persist(persistedSlice(get()), { immediate: true });
  },
  updateDebug: (patch) => {
    set((state) => ({
      debug: normalizePreferences({
        ...persistedSlice(state),
        debug: { ...state.debug, ...patch },
      }).debug,
      persistenceError: null,
    }));
    persist(persistedSlice(get()), { immediate: true });
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
    set((state) => {
      if (state.surfaces[kind].interaction === interaction) {
        return state.persistenceError === null ? state : { persistenceError: null };
      }
      return {
        surfaces: {
          ...state.surfaces,
          [kind]: { ...state.surfaces[kind], interaction },
        },
        persistenceError: null,
      };
    });
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
    persist(persistedSlice(get()), { immediate: true });
  },
  setBackgroundImageState: (backgroundImageData, backgroundImageMissing) =>
    set({ backgroundImageData, backgroundImageMissing }),
  hydrate: (preferences) => {
    const current = get();
    const next = {
      ...preferences,
      surfaces: mergeHydratedSurfaces(current.surfaces, preferences.surfaces),
    };
    writeCache(next);
    set({ ...next, hydrated: true, persistenceError: null });
  },
}));

let hydration: Promise<void> | null = null;
export function hydratePreferences(): Promise<void> {
  if (!isNativeRuntime) return Promise.resolve();
  hydration ??= getYaqmcClient()
    .invoke('app_preferences_get')
    .then((value) => {
      const parsed = value ? JSON.parse(value) : null;
      const preferences = value ? normalizePreferences(parsed) : initialPreferences;
      usePreferencesStore.getState().hydrate(preferences);
      if (!value || preferencesRequireMigration(parsed)) persist(preferences, { immediate: true });
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
  if (!isNativeRuntime) return null;
  const client = getYaqmcClient();
  const picked = await client.host.dialog?.pickFile({ kind: 'background-image' });
  if (picked == null) return null;
  if (typeof picked !== 'string' || picked.trim().length === 0) {
    throw new Error('selected image path is missing');
  }
  return client.invoke('preferences_set_background_from', { path: picked });
}

const FILESYSTEM_PATH_IN_MESSAGE =
  /(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp)\/|\\Users\\|APPDATA)/i;

/** Surface Core/host failure text when it is already generic; never show filesystem paths. */
export function formatBackgroundPickerError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 240 || FILESYSTEM_PATH_IN_MESSAGE.test(trimmed)) {
    return fallback;
  }
  return trimmed;
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
  root.style.setProperty('--ui-font-scale', `${appearance.interfaceFontScale / 100}`);
  const fonts: Record<InterfaceFontFamily, { text: string; display: string }> = {
    application: {
      text: "'YAQMC Text', 'PingFang SC', 'Segoe UI Variable', 'Segoe UI', 'Noto Sans SC', system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      display:
        "'YAQMC Display', 'PingFang SC', 'SF Pro Display', 'Segoe UI Variable Display', 'Segoe UI Variable', 'Segoe UI', sans-serif",
    },
    system: {
      text: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', sans-serif",
      display:
        "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', sans-serif",
    },
    serif: {
      text: "ui-serif, 'Noto Serif CJK SC', 'Songti SC', Georgia, serif",
      display: "ui-serif, 'Noto Serif CJK SC', 'Songti SC', Georgia, serif",
    },
    monospace: {
      text: "ui-monospace, 'SFMono-Regular', Consolas, 'Liberation Mono', 'Noto Sans Mono CJK SC', monospace",
      display:
        "ui-monospace, 'SFMono-Regular', Consolas, 'Liberation Mono', 'Noto Sans Mono CJK SC', monospace",
    },
  };
  const font = fonts[appearance.interfaceFontFamily];
  root.style.setProperty('--font-ui-text', font.text);
  root.style.setProperty('--font-ui-display', font.display);
}

let appearancePreviewFrame: number | null = null;
let pendingAppearancePreview: AppearanceSettings | null = null;

function currentResolvedMode(appearance: AppearanceSettings): ResolvedColorMode {
  if (appearance.colorMode !== 'system') return appearance.colorMode;
  const current = document.documentElement.dataset.theme;
  return current === 'light' || current === 'dark' ? current : resolveSystemMode();
}

export function previewAppearance(patch: Partial<AppearanceSettings>): void {
  if (typeof window === 'undefined') return;
  const current = usePreferencesStore.getState().appearance;
  pendingAppearancePreview = normalizePreferences({
    version: 2,
    appearance: { ...current, ...patch },
  }).appearance;
  if (appearancePreviewFrame !== null) return;
  appearancePreviewFrame = window.requestAnimationFrame(() => {
    appearancePreviewFrame = null;
    const appearance = pendingAppearancePreview;
    pendingAppearancePreview = null;
    if (appearance) applyAppearance(appearance, currentResolvedMode(appearance));
  });
}

export function finishAppearancePreview(): void {
  if (appearancePreviewFrame !== null) window.cancelAnimationFrame(appearancePreviewFrame);
  appearancePreviewFrame = null;
  pendingAppearancePreview = null;
}

export function restoreCommittedAppearance(): void {
  finishAppearancePreview();
  const appearance = usePreferencesStore.getState().appearance;
  applyAppearance(appearance, currentResolvedMode(appearance));
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
    if (!isNativeRuntime) return;
    let active = true;
    const client = getYaqmcClient();
    const stopChanged = client.on('preferences://changed', (payload) => {
      if (!active) return;
      try {
        const incoming = normalizePreferences(JSON.parse(payload as unknown as string));
        if (hasPendingPreferencePersist()) {
          mergePendingPersistSurfaceInteraction(incoming);
          return;
        }
        usePreferencesStore.getState().hydrate(incoming);
      } catch {
        // Invalid cross-window state is ignored; Rust validates persisted documents.
      }
    });
    const stopInteraction = client.on('lyrics://surface-interaction', (payload) => {
      if (!active) return;
      const kind = payload?.kind;
      const interaction = payload?.interaction;
      if (kind !== 'desktop' && kind !== 'island') return;
      if (interaction !== 'interactive' && interaction !== 'passive-locked') return;
      usePreferencesStore.getState().setSurfaceInteractionLocal(kind, interaction);
    });
    const stopClosed = client.on('lyrics://surface-closed', (payload) => {
      const kind = payload as unknown as string;
      if (!active || !['desktop', 'island'].includes(kind)) return;
      const store = usePreferencesStore.getState();
      if (store.surfaces[kind as SurfaceKind].enabled)
        store.updateSurface(kind as SurfaceKind, { enabled: false });
    });
    return () => {
      active = false;
      stopChanged();
      stopInteraction();
      stopClosed();
    };
  }, []);

  useEffect(() => {
    if (!isNativeRuntime) return;
    const flushHidden = () => {
      if (document.visibilityState === 'hidden') {
        flushPreferencesPersist();
      }
    };
    document.addEventListener('visibilitychange', flushHidden);
    window.addEventListener('pagehide', flushPreferencesPersist);
    return () => {
      document.removeEventListener('visibilitychange', flushHidden);
      window.removeEventListener('pagehide', flushPreferencesPersist);
      flushPreferencesPersist();
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
      !isNativeRuntime ||
      appearance.backgroundMode !== 'image' ||
      !appearance.backgroundImageReference
    ) {
      setBackgroundImageState(null, false);
      return;
    }
    let active = true;
    void getYaqmcClient()
      .invoke('appearance_background_load', {
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
    if (!isNativeRuntime || !reconcileSurfaces || !hydrated) return;
    const timer = window.setTimeout(() => {
      void getYaqmcClient()
        .invoke('lyrics_surfaces_reconcile', { surfaces })
        .catch((error) => {
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
