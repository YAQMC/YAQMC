import type { LyricCoverLayout } from './preferences';
import { logger } from './logger';

export const LYRICS_PRESET_SCHEMA_VERSION = 2 as const;
export const LYRICS_SCENE_RENDERER_VERSION = 1 as const;
export const LYRICS_PRESET_LAYOUT_MALFORMED = 'lyrics.preset.layout.malformed';

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
export const FOLLOW_ANCHOR_DEFAULT = 0.35;
export const LYRICS_FONT_BASE_MIN_PX = 18;
export const LYRICS_FONT_BASE_MAX_PX = 96;
export const LYRICS_FONT_BASE_CQH = 0.056;
export const SECONDARY_FONT_RATIO = 0.42;

export type LyricsPresetSource = 'built-in' | 'custom' | 'plugin';
export type LyricsArtworkStyle = 'square' | 'vinyl';
export type LyricsArtworkRenderer = 'square' | 'rounded' | 'vinyl';
export type LyricsBackgroundFit = 'cover' | 'contain';
export type LyricsBackgroundKind =
  'color' | 'artwork' | 'image' | 'gradient' | 'video' | 'colorField';
export type LyricsPreviewFrame = 'desktop' | 'window' | 'ultrawide';
export type WidgetAnchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';
export type LyricsAlign = 'left' | 'center' | 'right';
export type SceneWidgetId = 'background' | 'artwork' | 'metadata' | 'lyrics' | 'transport';
export type ExtraSceneWidgetKind = 'text' | 'image' | 'video';
export type SceneTextBinding =
  'track.title' | 'track.artist' | 'track.album' | 'playback.position' | 'playback.duration';
export type ColorFieldPosition = 'left' | 'right' | 'top' | 'bottom' | 'center';
export type ArtworkColorBind = 'artworkPrimary' | 'artworkSecondary';

export const COLOR_FIELD_POSITIONS: readonly ColorFieldPosition[] = [
  'left',
  'right',
  'top',
  'bottom',
  'center',
];

export interface SceneAssetRef {
  kind: 'plugin' | 'managed';
  pluginId?: string;
  path: string;
}

export interface ColorFieldEmitter {
  id: string;
  position: ColorFieldPosition;
  color: string;
  intensity: number;
  falloff: number;
  radius: number;
  bind?: ArtworkColorBind | null;
}

export interface ColorFieldConfig {
  emitters: ColorFieldEmitter[];
}

export const SCENE_WIDGET_IDS: readonly SceneWidgetId[] = [
  'background',
  'artwork',
  'metadata',
  'lyrics',
  'transport',
];

export const WIDGET_ANCHORS: readonly WidgetAnchor[] = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

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

export interface WidgetTransform {
  x: number;
  y: number;
  width: number;
  height: number;
  anchor: WidgetAnchor;
  zIndex: number;
  visible: boolean;
  locked: boolean;
}

export interface BackgroundWidget {
  id: 'background';
  kind: 'background';
  zIndex: number;
  visible: boolean;
  locked: boolean;
  source: LyricsBackgroundKind;
  fit: LyricsBackgroundFit;
  fallbackColor: string;
  opacity: number;
  influence: number;
  blur: number;
  colorField?: ColorFieldConfig;
  gradient?: { from: string; to: string; angle: number };
  media?: SceneAssetRef;
}

export interface ArtworkWidget extends WidgetTransform {
  id: 'artwork';
  kind: 'artwork';
  renderer: LyricsArtworkRenderer;
  opacity: number;
  radius: number;
}

export interface MetadataWidget extends WidgetTransform {
  id: 'metadata';
  kind: 'metadata';
  align: LyricsAlign;
  titleScale: number;
  artistScale: number;
}

export interface LyricsWidget extends WidgetTransform {
  id: 'lyrics';
  kind: 'lyrics';
  align: LyricsAlign;
  followAnchor: number;
}

export interface TransportWidget extends WidgetTransform {
  id: 'transport';
  kind: 'transport';
  align: LyricsAlign;
}

export interface ExtraSceneWidget extends WidgetTransform {
  id: string;
  kind: ExtraSceneWidgetKind;
  text?: string;
  bind?: SceneTextBinding | null;
  align?: LyricsAlign;
  opacity?: number;
  asset?: SceneAssetRef;
  source?: 'artwork';
  fit?: LyricsBackgroundFit;
}

export interface LyricsSceneLayout {
  background: BackgroundWidget;
  artwork: ArtworkWidget;
  metadata: MetadataWidget;
  lyrics: LyricsWidget;
  transport: TransportWidget;
  extras?: ExtraSceneWidget[];
}

export type SceneWidget =
  BackgroundWidget | ArtworkWidget | MetadataWidget | LyricsWidget | TransportWidget;

export interface LyricsPresetDefinition {
  schemaVersion: typeof LYRICS_PRESET_SCHEMA_VERSION;
  id: string;
  nameKey: string;
  name?: string;
  source: LyricsPresetSource;
  pluginId?: string;
  pluginName?: string;
  forkedFromPluginId?: string;
  layout: LyricCoverLayout;
  typography: LyricsPresetTypography;
  artwork: LyricsPresetArtwork;
  background: LyricsPresetBackground;
  scene: LyricsSceneLayout;
}

export type LyricsPresetPatch = {
  typography?: Partial<LyricsPresetTypography>;
  artwork?: Partial<LyricsPresetArtwork>;
  background?: Partial<LyricsPresetBackground>;
  layout?: LyricCoverLayout;
  name?: string;
  scene?: Partial<{
    background: Partial<BackgroundWidget>;
    artwork: Partial<ArtworkWidget>;
    metadata: Partial<MetadataWidget>;
    lyrics: Partial<LyricsWidget>;
    transport: Partial<TransportWidget>;
    extras: ExtraSceneWidget[];
  }>;
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

function widgetBox(
  x: number,
  y: number,
  width: number,
  height: number,
  extras: { anchor?: WidgetAnchor; zIndex: number; locked?: boolean; visible?: boolean },
): WidgetTransform {
  return {
    x,
    y,
    width,
    height,
    anchor: extras.anchor ?? 'center',
    zIndex: extras.zIndex,
    visible: extras.visible ?? true,
    locked: extras.locked ?? false,
  };
}

function factoryBackground(
  extras: Partial<Pick<BackgroundWidget, 'blur' | 'influence' | 'fit'>> = {},
): BackgroundWidget {
  return {
    id: 'background',
    kind: 'background',
    zIndex: 0,
    visible: true,
    locked: false,
    source: 'artwork',
    fit: extras.fit ?? 'cover',
    fallbackColor: defaultBackground.fallbackColor,
    opacity: 1,
    influence: extras.influence ?? 0.38,
    blur: extras.blur ?? 22,
  };
}

function factoryTransport(layout: LyricCoverLayout = 'split'): TransportWidget {
  const leftColumn = layout !== 'full';
  return {
    ...widgetBox(leftColumn ? 0.225 : 0.5, leftColumn ? 0.94 : 0.97, 0.26, 0.13, {
      anchor: 'bottom-center',
      zIndex: 8,
    }),
    id: 'transport',
    kind: 'transport',
    align: 'center',
  };
}

export function factoryScene(layout: LyricCoverLayout): LyricsSceneLayout {
  if (layout === 'full') {
    return {
      background: factoryBackground({ blur: 0, influence: 0.55 }),
      artwork: {
        ...widgetBox(0.25, 0.5, 0.5, 1, { zIndex: 1 }),
        id: 'artwork',
        kind: 'artwork',
        renderer: 'square',
        opacity: 1,
        radius: 0,
      },
      metadata: {
        ...widgetBox(0.76, 0.11, 0.42, 0.12, { anchor: 'top-center', zIndex: 4 }),
        id: 'metadata',
        kind: 'metadata',
        align: 'left',
        titleScale: 1,
        artistScale: 0.72,
      },
      lyrics: {
        ...widgetBox(0.76, 0.55, 0.44, 0.7, { zIndex: 5 }),
        id: 'lyrics',
        kind: 'lyrics',
        align: 'left',
        followAnchor: FOLLOW_ANCHOR_DEFAULT,
      },
      transport: factoryTransport('full'),
    };
  }
  if (layout === 'vinyl') {
    return {
      background: factoryBackground(),
      artwork: {
        ...widgetBox(0.225, 0.4, 0.34, 0.48, { zIndex: 3 }),
        id: 'artwork',
        kind: 'artwork',
        renderer: 'vinyl',
        opacity: 1,
        radius: 0.5,
      },
      metadata: {
        ...widgetBox(0.225, 0.7, 0.36, 0.14, { zIndex: 4 }),
        id: 'metadata',
        kind: 'metadata',
        align: 'center',
        titleScale: 1,
        artistScale: 0.72,
      },
      lyrics: {
        ...widgetBox(0.73, 0.46, 0.5, 0.72, { zIndex: 5 }),
        id: 'lyrics',
        kind: 'lyrics',
        align: 'left',
        followAnchor: FOLLOW_ANCHOR_DEFAULT,
      },
      transport: factoryTransport('vinyl'),
    };
  }
  return {
    background: factoryBackground(),
    artwork: {
      ...widgetBox(0.225, 0.4, 0.3, 0.42, { zIndex: 3 }),
      id: 'artwork',
      kind: 'artwork',
      renderer: 'square',
      opacity: 1,
      radius: 0.06,
    },
    metadata: {
      ...widgetBox(0.225, 0.68, 0.36, 0.14, { zIndex: 4 }),
      id: 'metadata',
      kind: 'metadata',
      align: 'center',
      titleScale: 1,
      artistScale: 0.72,
    },
    lyrics: {
      ...widgetBox(0.73, 0.46, 0.5, 0.72, { zIndex: 5 }),
      id: 'lyrics',
      kind: 'lyrics',
      align: 'left',
      followAnchor: FOLLOW_ANCHOR_DEFAULT,
    },
    transport: factoryTransport('split'),
  };
}

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
    scene: factoryScene('split'),
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
    scene: factoryScene('full'),
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
    scene: factoryScene('vinyl'),
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

const COVER_CYCLE_ORDER: readonly LyricCoverLayout[] = ['split', 'full', 'vinyl'];

export function orderedPresetsForCycle(state: LyricsPresetState): LyricsPresetDefinition[] {
  const presets = listResolvedPresets(state);
  return COVER_CYCLE_ORDER.flatMap((layout) =>
    presets.filter((preset) => preset.layout === layout),
  );
}

export function nextResolvedPreset(state: LyricsPresetState): LyricsPresetDefinition {
  const presets = orderedPresetsForCycle(state);
  const index = presets.findIndex((preset) => preset.id === state.selectedId);
  const nextIndex = index < 0 ? 0 : (index + 1) % Math.max(presets.length, 1);
  return presets[nextIndex] ?? presets[0]!;
}

export function isPluginPresetId(id: string): boolean {
  return id.startsWith('plugin:');
}

let pluginPresetCatalog: LyricsPresetDefinition[] = [];

export function setPluginPresetCatalog(presets: LyricsPresetDefinition[]): void {
  pluginPresetCatalog = presets;
}

export function getPluginPresetCatalog(): LyricsPresetDefinition[] {
  return pluginPresetCatalog;
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

export function clampFollowAnchor(value: number): number {
  return Math.min(0.85, Math.max(0.15, value));
}

export function resolvePrimaryFontSizePx(fontScale: number, containerHeightPx: number): number {
  const height = Number.isFinite(containerHeightPx) ? Math.max(0, containerHeightPx) : 0;
  const fontBase = Math.min(
    LYRICS_FONT_BASE_MAX_PX,
    Math.max(LYRICS_FONT_BASE_MIN_PX, height * LYRICS_FONT_BASE_CQH),
  );
  return fontBase * clampFontScale(fontScale);
}

export function resolveSecondaryFontSizePx(primaryPx: number): number {
  return Math.max(11, primaryPx * SECONDARY_FONT_RATIO);
}

export function lineGapFromLineHeight(lineHeight: number): number {
  const span = LINE_HEIGHT_MAX - LINE_HEIGHT_MIN;
  const t = (clampLineHeight(lineHeight) - LINE_HEIGHT_MIN) / Math.max(span, 0.0001);
  return Math.round((0.35 + t * 2) * 1000) / 1000;
}

function clampUnit(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(1.2, Math.max(-0.2, value)) : fallback;
}

function clampPositive(value: number, fallback: number, max = 1.2): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(0.04, value)) : fallback;
}

function clamp01(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function isAnchor(value: unknown): value is WidgetAnchor {
  return typeof value === 'string' && (WIDGET_ANCHORS as readonly string[]).includes(value);
}

function isAlign(value: unknown): value is LyricsAlign {
  return value === 'left' || value === 'center' || value === 'right';
}

function isRenderer(value: unknown): value is LyricsArtworkRenderer {
  return value === 'square' || value === 'rounded' || value === 'vinyl';
}

function isBackgroundKind(value: unknown): value is LyricsBackgroundKind {
  return (
    value === 'color' ||
    value === 'artwork' ||
    value === 'image' ||
    value === 'gradient' ||
    value === 'video' ||
    value === 'colorField'
  );
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value);
}

function normalizeAsset(value: unknown): SceneAssetRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Partial<SceneAssetRef>;
  if (typeof source.path !== 'string' || source.path.length === 0 || source.path.length > 180) {
    return undefined;
  }
  if (source.path.includes('..') || source.path.includes(':') || source.path.startsWith('/')) {
    return undefined;
  }
  const kind = source.kind === 'managed' ? 'managed' : 'plugin';
  const pluginId =
    typeof source.pluginId === 'string' && source.pluginId.length < 80
      ? source.pluginId
      : undefined;
  return { kind, pluginId, path: source.path.replaceAll('\\', '/') };
}

function normalizeColorField(value: unknown): ColorFieldConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const emitters = (value as ColorFieldConfig).emitters;
  if (!Array.isArray(emitters)) return undefined;
  const next = emitters.slice(0, 5).flatMap((emitter, index) => {
    if (!emitter || typeof emitter !== 'object') return [];
    const position = COLOR_FIELD_POSITIONS.includes(emitter.position as ColorFieldPosition)
      ? (emitter.position as ColorFieldPosition)
      : 'center';
    const color = isHexColor(emitter.color) ? emitter.color : '#FFFFFF';
    const bind =
      emitter.bind === 'artworkPrimary' || emitter.bind === 'artworkSecondary'
        ? emitter.bind
        : null;
    return [
      {
        id:
          typeof emitter.id === 'string' && emitter.id.length > 0
            ? emitter.id.slice(0, 24)
            : `emitter-${index}`,
        position,
        color,
        intensity: clamp01(typeof emitter.intensity === 'number' ? emitter.intensity : 0.6, 0.6),
        falloff: clamp01(typeof emitter.falloff === 'number' ? emitter.falloff : 0.45, 0.45),
        radius: clamp01(typeof emitter.radius === 'number' ? emitter.radius : 0.55, 0.55),
        bind,
      },
    ];
  });
  return next.length > 0 ? { emitters: next } : undefined;
}

const TEXT_BINDINGS: readonly SceneTextBinding[] = [
  'track.title',
  'track.artist',
  'track.album',
  'playback.position',
  'playback.duration',
];

function normalizeExtraWidget(value: unknown, index: number): ExtraSceneWidget | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<ExtraSceneWidget>;
  const kind =
    source.kind === 'image' || source.kind === 'video' || source.kind === 'text'
      ? source.kind
      : null;
  if (!kind) return null;
  const id =
    typeof source.id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(source.id)
      ? source.id
      : `extra-${index}`;
  const box = normalizeTransform(source, {
    x: 0.5,
    y: 0.2 + index * 0.12,
    width: 0.28,
    height: 0.1,
    anchor: 'center',
    zIndex: 6 + index,
    visible: true,
    locked: false,
  });
  const bind = TEXT_BINDINGS.includes(source.bind as SceneTextBinding)
    ? (source.bind as SceneTextBinding)
    : null;
  return {
    ...box,
    id,
    kind,
    text: typeof source.text === 'string' ? source.text.slice(0, 80) : undefined,
    bind,
    align: isAlign(source.align) ? source.align : 'center',
    opacity: clamp01(typeof source.opacity === 'number' ? source.opacity : 1, 1),
    asset: normalizeAsset(source.asset),
    source: source.source === 'artwork' ? 'artwork' : undefined,
    fit: source.fit === 'contain' ? 'contain' : 'cover',
  };
}

function cloneScene(scene: LyricsSceneLayout): LyricsSceneLayout {
  return {
    background: {
      ...scene.background,
      colorField: scene.background.colorField
        ? { emitters: scene.background.colorField.emitters.map((emitter) => ({ ...emitter })) }
        : undefined,
      gradient: scene.background.gradient ? { ...scene.background.gradient } : undefined,
      media: scene.background.media ? { ...scene.background.media } : undefined,
    },
    artwork: { ...scene.artwork },
    metadata: { ...scene.metadata },
    lyrics: { ...scene.lyrics },
    transport: { ...scene.transport },
    extras: (scene.extras ?? []).map((widget) => ({
      ...widget,
      asset: widget.asset ? { ...widget.asset } : undefined,
    })),
  };
}

function styleFromRenderer(renderer: LyricsArtworkRenderer): LyricsArtworkStyle {
  return renderer === 'vinyl' ? 'vinyl' : 'square';
}

function syncDerived(preset: LyricsPresetDefinition): LyricsPresetDefinition {
  return {
    ...preset,
    schemaVersion: LYRICS_PRESET_SCHEMA_VERSION,
    artwork: { style: styleFromRenderer(preset.scene.artwork.renderer) },
    background: {
      fit: preset.scene.background.fit,
      fallbackColor: preset.scene.background.fallbackColor,
    },
  };
}

function normalizeTransform(
  value: Partial<WidgetTransform> | undefined,
  fallback: WidgetTransform,
): WidgetTransform {
  return {
    x: clampUnit(typeof value?.x === 'number' ? value.x : fallback.x, fallback.x),
    y: clampUnit(typeof value?.y === 'number' ? value.y : fallback.y, fallback.y),
    width: clampPositive(
      typeof value?.width === 'number' ? value.width : fallback.width,
      fallback.width,
    ),
    height: clampPositive(
      typeof value?.height === 'number' ? value.height : fallback.height,
      fallback.height,
    ),
    anchor: isAnchor(value?.anchor) ? value.anchor : fallback.anchor,
    zIndex:
      typeof value?.zIndex === 'number' && Number.isFinite(value.zIndex)
        ? Math.round(value.zIndex)
        : fallback.zIndex,
    visible: typeof value?.visible === 'boolean' ? value.visible : fallback.visible,
    locked: typeof value?.locked === 'boolean' ? value.locked : fallback.locked,
  };
}

export function normalizeScene(
  value: unknown,
  layout: LyricCoverLayout,
): { scene: LyricsSceneLayout; malformed: boolean } {
  const factory = factoryScene(layout);
  if (!value || typeof value !== 'object') return { scene: factory, malformed: value != null };
  const source = value as Partial<LyricsSceneLayout>;
  if (
    !source.artwork ||
    !source.metadata ||
    !source.lyrics ||
    !source.transport ||
    !source.background
  ) {
    return { scene: factory, malformed: true };
  }
  const backgroundSource = source.background as Partial<BackgroundWidget>;
  const artworkSource = source.artwork as Partial<ArtworkWidget>;
  const metadataSource = source.metadata as Partial<MetadataWidget>;
  const lyricsSource = source.lyrics as Partial<LyricsWidget>;
  const transportSource = source.transport as Partial<TransportWidget>;
  return {
    malformed: false,
    scene: {
      background: {
        id: 'background',
        kind: 'background',
        zIndex:
          typeof backgroundSource.zIndex === 'number' ? Math.round(backgroundSource.zIndex) : 0,
        visible: backgroundSource.visible !== false,
        locked: backgroundSource.locked === true,
        source: isBackgroundKind(backgroundSource.source) ? backgroundSource.source : 'artwork',
        fit: backgroundSource.fit === 'contain' ? 'contain' : 'cover',
        fallbackColor:
          typeof backgroundSource.fallbackColor === 'string' &&
          /^#[0-9A-Fa-f]{6}$/.test(backgroundSource.fallbackColor)
            ? backgroundSource.fallbackColor
            : factory.background.fallbackColor,
        opacity: clamp01(
          typeof backgroundSource.opacity === 'number' ? backgroundSource.opacity : 1,
          1,
        ),
        influence: clamp01(
          typeof backgroundSource.influence === 'number' ? backgroundSource.influence : 0.38,
          0.38,
        ),
        blur: Math.min(
          64,
          Math.max(
            0,
            typeof backgroundSource.blur === 'number'
              ? backgroundSource.blur
              : factory.background.blur,
          ),
        ),
        colorField: normalizeColorField(backgroundSource.colorField),
        gradient:
          backgroundSource.gradient &&
          isHexColor(backgroundSource.gradient.from) &&
          isHexColor(backgroundSource.gradient.to)
            ? {
                from: backgroundSource.gradient.from,
                to: backgroundSource.gradient.to,
                angle:
                  typeof backgroundSource.gradient.angle === 'number'
                    ? Math.min(360, Math.max(0, backgroundSource.gradient.angle))
                    : 160,
              }
            : undefined,
        media: normalizeAsset(backgroundSource.media),
      },
      artwork: {
        ...normalizeTransform(artworkSource, factory.artwork),
        id: 'artwork',
        kind: 'artwork',
        renderer: isRenderer(artworkSource.renderer)
          ? artworkSource.renderer
          : factory.artwork.renderer,
        opacity: clamp01(typeof artworkSource.opacity === 'number' ? artworkSource.opacity : 1, 1),
        radius: clamp01(
          typeof artworkSource.radius === 'number' ? artworkSource.radius : factory.artwork.radius,
          factory.artwork.radius,
        ),
      },
      metadata: {
        ...normalizeTransform(metadataSource, factory.metadata),
        id: 'metadata',
        kind: 'metadata',
        align: isAlign(metadataSource.align) ? metadataSource.align : factory.metadata.align,
        titleScale: clampPositive(
          typeof metadataSource.titleScale === 'number' ? metadataSource.titleScale : 1,
          1,
          2,
        ),
        artistScale: clampPositive(
          typeof metadataSource.artistScale === 'number' ? metadataSource.artistScale : 0.72,
          0.72,
          2,
        ),
      },
      lyrics: {
        ...normalizeTransform(lyricsSource, factory.lyrics),
        id: 'lyrics',
        kind: 'lyrics',
        align: isAlign(lyricsSource.align) ? lyricsSource.align : factory.lyrics.align,
        followAnchor: clampFollowAnchor(
          typeof lyricsSource.followAnchor === 'number'
            ? lyricsSource.followAnchor
            : FOLLOW_ANCHOR_DEFAULT,
        ),
      },
      transport: {
        ...normalizeTransform(transportSource, factory.transport),
        id: 'transport',
        kind: 'transport',
        align: isAlign(transportSource.align) ? transportSource.align : 'center',
      },
      extras: Array.isArray(source.extras)
        ? source.extras
            .slice(0, 8)
            .map((widget, index) => normalizeExtraWidget(widget, index))
            .filter((widget): widget is ExtraSceneWidget => widget !== null)
        : [],
    },
  };
}

function builtinById(id: string): LyricsPresetDefinition | undefined {
  return builtinPresetCatalog.find((preset) => preset.id === id);
}

function mergeWidget<T extends object>(base: T, patch?: Partial<T>): T {
  return patch ? { ...base, ...patch } : base;
}

export function mergeScene(
  base: LyricsSceneLayout,
  patch: LyricsPresetPatch['scene'] | undefined,
): LyricsSceneLayout {
  if (!patch) return cloneScene(base);
  return {
    background: mergeWidget(base.background, patch.background),
    artwork: mergeWidget(base.artwork, patch.artwork),
    metadata: mergeWidget(base.metadata, patch.metadata),
    lyrics: mergeWidget(base.lyrics, patch.lyrics),
    transport: mergeWidget(base.transport, patch.transport),
    extras: patch.extras ?? cloneScene(base).extras,
  };
}

function applyPatch(
  base: LyricsPresetDefinition,
  patch: LyricsPresetPatch | undefined,
): LyricsPresetDefinition {
  if (!patch) return syncDerived({ ...base, scene: cloneScene(base.scene) });
  const layout = patch.layout ?? base.layout;
  const layoutChanged = layout !== base.layout && !patch.scene;
  const merged = mergeScene(layoutChanged ? factoryScene(layout) : base.scene, patch.scene);
  if (patch.artwork?.style === 'vinyl') merged.artwork.renderer = 'vinyl';
  if (patch.artwork?.style === 'square' && merged.artwork.renderer === 'vinyl') {
    merged.artwork.renderer = 'square';
  }
  if (patch.background?.fit) merged.background.fit = patch.background.fit;
  if (patch.background?.fallbackColor) {
    merged.background.fallbackColor = patch.background.fallbackColor;
  }
  const next: LyricsPresetDefinition = {
    ...base,
    layout,
    name: patch.name ?? base.name,
    typography: {
      fontScale: clampFontScale(patch.typography?.fontScale ?? base.typography.fontScale),
      lineHeight: clampLineHeight(patch.typography?.lineHeight ?? base.typography.lineHeight),
    },
    scene: normalizeScene(merged, layout).scene,
  };
  return syncDerived(next);
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
    scene: cloneScene(preset.scene),
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
  const plugin = pluginPresetCatalog.find((preset) => preset.id === id);
  if (plugin) return applyPatch(plugin, undefined);
  if (isPluginPresetId(id)) return applyPatch(builtinPresetCatalog[0]!, undefined);
  const builtin = builtinById(id) ?? builtinPresetCatalog[0]!;
  return applyPatch(builtin, state.overrides[id]);
}

export function listResolvedPresets(state: LyricsPresetState): LyricsPresetDefinition[] {
  return [
    ...builtinPresetCatalog.map((preset) => applyPatch(preset, state.overrides[preset.id])),
    ...state.custom,
    ...pluginPresetCatalog,
  ];
}

export function mergePresetPatch(
  current: LyricsPresetPatch | undefined,
  patch: LyricsPresetPatch,
): LyricsPresetPatch {
  const scene =
    current?.scene || patch.scene
      ? {
          background: { ...current?.scene?.background, ...patch.scene?.background },
          artwork: { ...current?.scene?.artwork, ...patch.scene?.artwork },
          metadata: { ...current?.scene?.metadata, ...patch.scene?.metadata },
          lyrics: { ...current?.scene?.lyrics, ...patch.scene?.lyrics },
          transport: { ...current?.scene?.transport, ...patch.scene?.transport },
          extras: patch.scene?.extras ?? current?.scene?.extras,
        }
      : undefined;
  return {
    layout: patch.layout ?? current?.layout,
    name: patch.name ?? current?.name,
    typography: { ...current?.typography, ...patch.typography },
    artwork: { ...current?.artwork, ...patch.artwork },
    background: { ...current?.background, ...patch.background },
    scene,
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
    pluginId: undefined,
    pluginName: undefined,
    forkedFromPluginId: resolved.pluginId ?? resolved.forkedFromPluginId,
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

function normalizeCoverLayout(value: unknown): LyricCoverLayout {
  return value === 'full' || value === 'vinyl' || value === 'split' ? value : 'split';
}

function normalizeDefinition(value: unknown, fallbackId: string): LyricsPresetDefinition | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<LyricsPresetDefinition> & { id?: unknown; scene?: unknown };
  const id = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : fallbackId;
  if (!id || id.length > 80) return null;
  const layout = normalizeCoverLayout(source.layout);
  const normalizedScene = normalizeScene(source.scene, layout);
  if (normalizedScene.malformed) {
    logger.warn(LYRICS_PRESET_LAYOUT_MALFORMED, 'malformed lyrics preset layout; using factory', {
      id,
      code: LYRICS_PRESET_LAYOUT_MALFORMED,
    });
  }
  const artworkStyle = source.artwork?.style === 'vinyl' ? 'vinyl' : 'square';
  if (!source.scene) {
    normalizedScene.scene.artwork.renderer =
      artworkStyle === 'vinyl' ? 'vinyl' : normalizedScene.scene.artwork.renderer;
  }
  if (source.background?.fit === 'contain' || source.background?.fit === 'cover') {
    normalizedScene.scene.background.fit = source.background.fit;
  }
  if (
    typeof source.background?.fallbackColor === 'string' &&
    /^#[0-9A-Fa-f]{6}$/.test(source.background.fallbackColor)
  ) {
    normalizedScene.scene.background.fallbackColor = source.background.fallbackColor;
  }
  return syncDerived({
    schemaVersion: LYRICS_PRESET_SCHEMA_VERSION,
    id,
    nameKey: typeof source.nameKey === 'string' ? source.nameKey.slice(0, 40) : 'custom',
    name: typeof source.name === 'string' ? source.name.slice(0, 80) : undefined,
    source: 'custom',
    layout,
    typography: normalizeTypography(source.typography),
    artwork: { style: artworkStyle },
    background: defaultBackground,
    scene: normalizedScene.scene,
  });
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
  if (source.background) {
    patch.background = {
      fit:
        source.background.fit === 'contain'
          ? 'contain'
          : source.background.fit === 'cover'
            ? 'cover'
            : 'cover',
      fallbackColor:
        typeof source.background.fallbackColor === 'string' &&
        /^#[0-9A-Fa-f]{6}$/.test(source.background.fallbackColor)
          ? source.background.fallbackColor
          : defaultBackground.fallbackColor,
    };
  }
  if (typeof source.name === 'string' && source.name.trim()) {
    patch.name = source.name.trim().slice(0, 80);
  }
  if (source.scene) {
    const layout = patch.layout ?? 'split';
    const normalized = normalizeScene(source.scene, layout);
    if (normalized.malformed) {
      logger.warn(LYRICS_PRESET_LAYOUT_MALFORMED, 'malformed lyrics preset override layout', {
        code: LYRICS_PRESET_LAYOUT_MALFORMED,
      });
      patch.scene = factoryScene(layout);
    } else {
      patch.scene = normalized.scene;
    }
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
    isBuiltinPresetId(requested) || customIds.has(requested) || isPluginPresetId(requested)
      ? requested
      : selectedFallback;
  if (options.preserveContainFit && Object.keys(overrides).length === 0 && !source.selectedId) {
    overrides[selectedId] = {
      background: { fit: 'contain' },
      scene: { background: { fit: 'contain' } },
    };
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
  rendererVersion: typeof LYRICS_SCENE_RENDERER_VERSION;
} {
  const resolved = resolveLyricsPreset(state);
  return {
    id: resolved.id,
    kind: resolved.source,
    schemaVersion: LYRICS_PRESET_SCHEMA_VERSION,
    rendererVersion: LYRICS_SCENE_RENDERER_VERSION,
  };
}

export function updateSceneWidget<K extends Exclude<SceneWidgetId, never>>(
  preset: LyricsPresetDefinition,
  id: K,
  patch: Partial<LyricsSceneLayout[K]>,
): LyricsPresetDefinition {
  return syncDerived({
    ...preset,
    scene: {
      ...preset.scene,
      [id]: { ...preset.scene[id], ...patch },
    },
  });
}

export function resetSceneWidget(
  preset: LyricsPresetDefinition,
  id: SceneWidgetId,
): LyricsPresetDefinition {
  const factory = factoryScene(preset.layout);
  return updateSceneWidget(preset, id, factory[id] as Partial<LyricsSceneLayout[typeof id]>);
}

export function resetSceneWidgetPosition(
  preset: LyricsPresetDefinition,
  id: Exclude<SceneWidgetId, 'background'>,
): LyricsPresetDefinition {
  const factory = factoryScene(preset.layout)[id];
  return updateSceneWidget(preset, id, {
    x: factory.x,
    y: factory.y,
    width: factory.width,
    height: factory.height,
    anchor: factory.anchor,
  });
}

export function listSceneWidgets(scene: LyricsSceneLayout): SceneWidget[] {
  return SCENE_WIDGET_IDS.map((id) => scene[id]).sort((left, right) => left.zIndex - right.zIndex);
}

export function listExtraSceneWidgets(scene: LyricsSceneLayout): ExtraSceneWidget[] {
  return [...(scene.extras ?? [])].sort((left, right) => left.zIndex - right.zIndex);
}

export function resolveSceneTextBinding(
  bind: SceneTextBinding | null | undefined,
  values: {
    title: string;
    artist: string;
    album: string;
    positionMs: number;
    durationMs: number;
  },
): string | null {
  switch (bind) {
    case 'track.title':
      return values.title;
    case 'track.artist':
      return values.artist;
    case 'track.album':
      return values.album;
    case 'playback.position':
      return formatBoundTime(values.positionMs);
    case 'playback.duration':
      return formatBoundTime(values.durationMs);
    default:
      return null;
  }
}

function formatBoundTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
