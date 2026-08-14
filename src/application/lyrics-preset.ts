import type { LyricCoverLayout } from './preferences';

export const LYRICS_PRESET_SCHEMA_VERSION = 1 as const;

export const BUILTIN_CLASSIC_ID = 'builtin.classic';
export const BUILTIN_IMMERSIVE_ID = 'builtin.immersive';
export const BUILTIN_VINYL_ID = 'builtin.vinyl';

export const BUILTIN_PRESET_IDS = [
  BUILTIN_CLASSIC_ID,
  BUILTIN_IMMERSIVE_ID,
  BUILTIN_VINYL_ID,
] as const;

export type BuiltinLyricsPresetId = (typeof BUILTIN_PRESET_IDS)[number];

export const FONT_SCALE_MIN = 0.7;
export const FONT_SCALE_MAX = 1.45;
export const FONT_SCALE_DEFAULT = 1;
export const LINE_HEIGHT_MIN = 1.05;
export const LINE_HEIGHT_MAX = 1.6;
export const LINE_HEIGHT_DEFAULT = 1.16;

export type LyricsPresetSource = 'built-in' | 'custom';
export type LyricsArtworkStyle = 'square' | 'vinyl';
export type LyricsBackgroundFit = 'cover' | 'contain';
/** Editor preview frames. `ultrawide` is reserved for a later Scene Engine pass. */
export type LyricsPreviewFrame = 'desktop' | 'window' | 'ultrawide';

export interface LyricsPresetTypography {
  fontScale: number;
  lineHeight: number;
}

export interface LyricsPresetArtwork {
  style: LyricsArtworkStyle;
}

export interface LyricsPresetBackground {
  fit: LyricsBackgroundFit;
  fallbackColor: string;
}

export interface LyricsPresetDefinition {
  schemaVersion: typeof LYRICS_PRESET_SCHEMA_VERSION;
  id: string;
  nameKey: string;
  name?: string;
  source: LyricsPresetSource;
  layout: LyricCoverLayout;
  typography: LyricsPresetTypography;
  artwork: LyricsPresetArtwork;
  background: LyricsPresetBackground;
}

export type LyricsPresetPatch = {
  typography?: Partial<LyricsPresetTypography>;
  artwork?: Partial<LyricsPresetArtwork>;
  background?: Partial<LyricsPresetBackground>;
  layout?: LyricCoverLayout;
  name?: string;
};

export interface LyricsPresetState {
  schemaVersion: typeof LYRICS_PRESET_SCHEMA_VERSION;
  selectedId: string;
  overrides: Record<string, LyricsPresetPatch>;
  custom: LyricsPresetDefinition[];
}

export const defaultTypography: LyricsPresetTypography = {
  fontScale: FONT_SCALE_DEFAULT,
  lineHeight: LINE_HEIGHT_DEFAULT,
};

export const defaultBackground: LyricsPresetBackground = {
  fit: 'cover',
  fallbackColor: '#20231C',
};

export const builtinPresetCatalog: readonly LyricsPresetDefinition[] = [
  {
    schemaVersion: LYRICS_PRESET_SCHEMA_VERSION,
    id: BUILTIN_CLASSIC_ID,
    nameKey: 'classic',
    source: 'built-in',
    layout: 'split',
    typography: defaultTypography,
    artwork: { style: 'square' },
    background: defaultBackground,
  },
  {
    schemaVersion: LYRICS_PRESET_SCHEMA_VERSION,
    id: BUILTIN_IMMERSIVE_ID,
    nameKey: 'immersive',
    source: 'built-in',
    layout: 'full',
    typography: defaultTypography,
    artwork: { style: 'square' },
    background: defaultBackground,
  },
  {
    schemaVersion: LYRICS_PRESET_SCHEMA_VERSION,
    id: BUILTIN_VINYL_ID,
    nameKey: 'vinyl',
    source: 'built-in',
    layout: 'vinyl',
    typography: defaultTypography,
    artwork: { style: 'vinyl' },
    background: defaultBackground,
  },
];

export const defaultLyricsPresetState: LyricsPresetState = {
  schemaVersion: LYRICS_PRESET_SCHEMA_VERSION,
  selectedId: BUILTIN_CLASSIC_ID,
  overrides: {},
  custom: [],
};

export function presetIdForLayout(layout: LyricCoverLayout): BuiltinLyricsPresetId {
  if (layout === 'full') return BUILTIN_IMMERSIVE_ID;
  if (layout === 'vinyl') return BUILTIN_VINYL_ID;
  return BUILTIN_CLASSIC_ID;
}

export function isBuiltinPresetId(id: string): id is BuiltinLyricsPresetId {
  return (BUILTIN_PRESET_IDS as readonly string[]).includes(id);
}

export function clampFontScale(value: number): number {
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, value));
}

export function clampLineHeight(value: number): number {
  return Math.min(LINE_HEIGHT_MAX, Math.max(LINE_HEIGHT_MIN, value));
}

function builtinById(id: string): LyricsPresetDefinition | undefined {
  return builtinPresetCatalog.find((preset) => preset.id === id);
}

function applyPatch(
  base: LyricsPresetDefinition,
  patch: LyricsPresetPatch | undefined,
): LyricsPresetDefinition {
  if (!patch) return base;
  return {
    ...base,
    layout: patch.layout ?? base.layout,
    name: patch.name ?? base.name,
    typography: {
      fontScale: clampFontScale(patch.typography?.fontScale ?? base.typography.fontScale),
      lineHeight: clampLineHeight(patch.typography?.lineHeight ?? base.typography.lineHeight),
    },
    artwork: {
      style: patch.artwork?.style ?? base.artwork.style,
    },
    background: {
      fit: patch.background?.fit ?? base.background.fit,
      fallbackColor: patch.background?.fallbackColor ?? base.background.fallbackColor,
    },
  };
}

export function hasBuiltinOverride(state: LyricsPresetState, id: string): boolean {
  return isBuiltinPresetId(id) && Boolean(state.overrides[id]);
}

export function patchFromDefinition(preset: LyricsPresetDefinition): LyricsPresetPatch {
  return {
    layout: preset.layout,
    name: preset.name,
    typography: { ...preset.typography },
    artwork: { ...preset.artwork },
    background: { ...preset.background },
  };
}

export function findCustomPreset(
  state: LyricsPresetState,
  id: string,
): LyricsPresetDefinition | undefined {
  return state.custom.find((preset) => preset.id === id);
}

export function resolveLyricsPreset(
  state: LyricsPresetState,
  id: string = state.selectedId,
): LyricsPresetDefinition {
  const custom = findCustomPreset(state, id);
  if (custom) return applyPatch(custom, undefined);
  const builtin = builtinById(id) ?? builtinPresetCatalog[0]!;
  return applyPatch(builtin, state.overrides[id]);
}

export function listResolvedPresets(state: LyricsPresetState): LyricsPresetDefinition[] {
  return [
    ...builtinPresetCatalog.map((preset) => applyPatch(preset, state.overrides[preset.id])),
    ...state.custom,
  ];
}

export function mergePresetPatch(
  current: LyricsPresetPatch | undefined,
  patch: LyricsPresetPatch,
): LyricsPresetPatch {
  return {
    layout: patch.layout ?? current?.layout,
    name: patch.name ?? current?.name,
    typography: { ...current?.typography, ...patch.typography },
    artwork: { ...current?.artwork, ...patch.artwork },
    background: { ...current?.background, ...patch.background },
  };
}

export function applyOverride(
  state: LyricsPresetState,
  id: string,
  patch: LyricsPresetPatch,
): LyricsPresetState {
  if (!isBuiltinPresetId(id)) {
    return {
      ...state,
      custom: state.custom.map((preset) => (preset.id === id ? applyPatch(preset, patch) : preset)),
    };
  }
  return {
    ...state,
    overrides: {
      ...state.overrides,
      [id]: mergePresetPatch(state.overrides[id], patch),
    },
  };
}

export function resetOverride(state: LyricsPresetState, id: string): LyricsPresetState {
  if (!(id in state.overrides)) return state;
  const overrides = { ...state.overrides };
  delete overrides[id];
  return { ...state, overrides };
}

export function createCustomPresetId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  return `custom.${random}`;
}

export function saveAsNewPreset(
  state: LyricsPresetState,
  sourceId: string,
  options: { name?: string; patch?: LyricsPresetPatch } = {},
): { state: LyricsPresetState; id: string } {
  const resolved = applyPatch(resolveLyricsPreset(state, sourceId), options.patch);
  const id = createCustomPresetId();
  const created: LyricsPresetDefinition = {
    ...resolved,
    id,
    nameKey: 'custom',
    name: options.name ?? `Custom ${state.custom.length + 1}`,
    source: 'custom',
  };
  return {
    id,
    state: {
      ...state,
      selectedId: id,
      custom: [...state.custom, created],
    },
  };
}

function normalizeTypography(value: unknown): LyricsPresetTypography {
  const source =
    value && typeof value === 'object' ? (value as Partial<LyricsPresetTypography>) : {};
  return {
    fontScale: clampFontScale(
      typeof source.fontScale === 'number' ? source.fontScale : FONT_SCALE_DEFAULT,
    ),
    lineHeight: clampLineHeight(
      typeof source.lineHeight === 'number' ? source.lineHeight : LINE_HEIGHT_DEFAULT,
    ),
  };
}

function normalizeBackground(value: unknown): LyricsPresetBackground {
  const source =
    value && typeof value === 'object' ? (value as Partial<LyricsPresetBackground>) : {};
  return {
    fit: source.fit === 'contain' ? 'contain' : 'cover',
    fallbackColor:
      typeof source.fallbackColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(source.fallbackColor)
        ? source.fallbackColor
        : defaultBackground.fallbackColor,
  };
}

function normalizeDefinition(value: unknown, fallbackId: string): LyricsPresetDefinition | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<LyricsPresetDefinition> & { id?: unknown };
  const id = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : fallbackId;
  if (!id || id.length > 80) return null;
  const layout =
    source.layout === 'full' || source.layout === 'vinyl' || source.layout === 'split'
      ? source.layout
      : 'split';
  return {
    schemaVersion: LYRICS_PRESET_SCHEMA_VERSION,
    id,
    nameKey: typeof source.nameKey === 'string' ? source.nameKey.slice(0, 40) : 'custom',
    name: typeof source.name === 'string' ? source.name.slice(0, 80) : undefined,
    source: 'custom',
    layout,
    typography: normalizeTypography(source.typography),
    artwork: { style: source.artwork?.style === 'vinyl' ? 'vinyl' : 'square' },
    background: normalizeBackground(source.background),
  };
}

function normalizePatch(value: unknown): LyricsPresetPatch | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as LyricsPresetPatch;
  const patch: LyricsPresetPatch = {};
  if (source.layout === 'split' || source.layout === 'full' || source.layout === 'vinyl') {
    patch.layout = source.layout;
  }
  if (source.typography) patch.typography = normalizeTypography(source.typography);
  if (source.artwork?.style === 'square' || source.artwork?.style === 'vinyl') {
    patch.artwork = { style: source.artwork.style };
  }
  if (source.background) patch.background = normalizeBackground(source.background);
  if (typeof source.name === 'string' && source.name.trim()) {
    patch.name = source.name.trim().slice(0, 80);
  }
  return patch;
}

export function normalizeLyricsPresetState(
  value: unknown,
  options: { coverLayout?: LyricCoverLayout; preserveContainFit?: boolean } = {},
): LyricsPresetState {
  const source = value && typeof value === 'object' ? (value as Partial<LyricsPresetState>) : {};
  const selectedFallback = presetIdForLayout(options.coverLayout ?? 'split');
  const custom = Array.isArray(source.custom)
    ? source.custom.flatMap((entry, index) => {
        const normalized = normalizeDefinition(entry, `custom.imported-${index}`);
        return normalized ? [normalized] : [];
      })
    : [];
  const customIds = new Set(custom.map((preset) => preset.id));
  const overrides: Record<string, LyricsPresetPatch> = {};
  if (source.overrides && typeof source.overrides === 'object') {
    for (const [id, patch] of Object.entries(source.overrides)) {
      if (!isBuiltinPresetId(id)) continue;
      const normalized = normalizePatch(patch);
      if (normalized) overrides[id] = normalized;
    }
  }
  const requested = typeof source.selectedId === 'string' ? source.selectedId : selectedFallback;
  const selectedId =
    isBuiltinPresetId(requested) || customIds.has(requested) ? requested : selectedFallback;
  if (options.preserveContainFit && Object.keys(overrides).length === 0 && !source.selectedId) {
    overrides[selectedId] = { background: { fit: 'contain' } };
  }
  return {
    schemaVersion: LYRICS_PRESET_SCHEMA_VERSION,
    selectedId,
    overrides,
    custom,
  };
}

export function lyricsPresetDiagnostics(state: LyricsPresetState): {
  id: string;
  kind: LyricsPresetSource;
  schemaVersion: typeof LYRICS_PRESET_SCHEMA_VERSION;
} {
  const resolved = resolveLyricsPreset(state);
  return {
    id: resolved.id,
    kind: resolved.source,
    schemaVersion: LYRICS_PRESET_SCHEMA_VERSION,
  };
}

export function lineGapFromLineHeight(lineHeight: number): number {
  return Math.max(0.25, (clampLineHeight(lineHeight) - 0.7) * 0.85);
}
