import { normalizeHexColor } from './theme-tokens';
import { logger } from './logger';

/**
 * Versioned, declarative schema for the lyrics transport bars.
 *
 * The bar is the only place where playback state (position, duration, queue
 * entry) meets playback commands. Both built-in presets and plugin
 * declarations are described by this DTO, so the renderer never consumes raw
 * plugin payloads as JSX/HTML/CSS: an invalid declaration is rejected and the
 * surface falls back to its built-in preset.
 */
export const LYRICS_TRANSPORT_SCHEMA_VERSION = 1 as const;
export const LYRICS_TRANSPORT_REJECTED = 'lyrics.transport.rejected';

export const BUILTIN_TRANSPORT_WINDOW_ID = 'builtin.transport.window';
export const BUILTIN_TRANSPORT_FULLSCREEN_ID = 'builtin.transport.fullscreen';

export type LyricsTransportSurface = 'window' | 'fullscreen';
export type LyricsTransportLayout = 'bar' | 'compact' | 'stacked';
export type LyricsTransportActionId =
  'artwork' | 'track' | 'previous' | 'playPause' | 'next' | 'progress' | 'time';

export const LYRICS_TRANSPORT_ACTIONS: readonly LyricsTransportActionId[] = [
  'artwork',
  'track',
  'previous',
  'playPause',
  'next',
  'progress',
  'time',
];

/** Actions that read playback state and therefore require `player.read`. */
export const TRANSPORT_READ_ACTIONS: readonly LyricsTransportActionId[] = [
  'artwork',
  'track',
  'progress',
  'time',
];

/** Actions that change playback and therefore require `player.control`. */
export const TRANSPORT_CONTROL_ACTIONS: readonly LyricsTransportActionId[] = [
  'previous',
  'playPause',
  'next',
];

/** Actions whose glyph a declaration may pick from the bounded icon set. */
export type LyricsTransportControlActionId = 'previous' | 'playPause' | 'next';

export type LyricsTransportIconId =
  | 'skip-back'
  | 'chevrons-back'
  | 'play-pause'
  | 'circle-play'
  | 'skip-forward'
  | 'chevrons-forward';

/** Icon ids a declaration may use for each control action. */
export const TRANSPORT_ICON_IDS: Readonly<
  Record<LyricsTransportControlActionId, readonly LyricsTransportIconId[]>
> = {
  previous: ['skip-back', 'chevrons-back'],
  playPause: ['play-pause', 'circle-play'],
  next: ['skip-forward', 'chevrons-forward'],
};

export const TRANSPORT_DEFAULT_ICONS: Readonly<
  Record<LyricsTransportControlActionId, LyricsTransportIconId>
> = {
  previous: 'skip-back',
  playPause: 'play-pause',
  next: 'skip-forward',
};

export type LyricsTransportIcons = Partial<
  Record<LyricsTransportControlActionId, LyricsTransportIconId>
>;

export const MAX_TRANSPORT_ACTIONS = 7;
export const MIN_TRANSPORT_CONTROL_SIZE = 44;
export const MAX_TRANSPORT_CONTROL_SIZE = 72;

export interface LyricsTransportTokens {
  surface: string;
  text: string;
  muted: string;
  accent: string;
}

export interface LyricsTransportMetrics {
  artworkSize: number;
  controlSize: number;
  gap: number;
  radius: number;
}

export interface LyricsTransportDefinition {
  schemaVersion: typeof LYRICS_TRANSPORT_SCHEMA_VERSION;
  id: string;
  name?: string;
  surface: LyricsTransportSurface;
  layout: LyricsTransportLayout;
  actions: LyricsTransportActionId[];
  icons: LyricsTransportIcons;
  tokens: LyricsTransportTokens;
  metrics: LyricsTransportMetrics;
}

export interface LyricsTransportState {
  schemaVersion: typeof LYRICS_TRANSPORT_SCHEMA_VERSION;
  window: string;
  fullscreen: string;
}

/** Host-derived permissions; never accepted from a plugin declaration. */
export interface ResolvedLyricsTransportDefinition extends LyricsTransportDefinition {
  canSeek: boolean;
}

export const defaultLyricsTransportState: LyricsTransportState = {
  schemaVersion: LYRICS_TRANSPORT_SCHEMA_VERSION,
  window: BUILTIN_TRANSPORT_WINDOW_ID,
  fullscreen: BUILTIN_TRANSPORT_FULLSCREEN_ID,
};

const BUILTIN_WINDOW_TRANSPORT: LyricsTransportDefinition = {
  schemaVersion: LYRICS_TRANSPORT_SCHEMA_VERSION,
  id: BUILTIN_TRANSPORT_WINDOW_ID,
  surface: 'window',
  layout: 'compact',
  actions: ['previous', 'playPause', 'next', 'progress', 'time'],
  icons: {},
  tokens: {
    surface: '#101110',
    text: '#F1F3EC',
    muted: '#A7ABA2',
    accent: '#A8C95E',
  },
  metrics: { artworkSize: 0, controlSize: 44, gap: 8, radius: 14 },
};

const BUILTIN_FULLSCREEN_TRANSPORT: LyricsTransportDefinition = {
  schemaVersion: LYRICS_TRANSPORT_SCHEMA_VERSION,
  id: BUILTIN_TRANSPORT_FULLSCREEN_ID,
  surface: 'fullscreen',
  layout: 'stacked',
  actions: ['previous', 'playPause', 'next', 'progress', 'time'],
  icons: {},
  tokens: {
    surface: '#101110',
    text: '#F1F3EC',
    muted: '#A7ABA2',
    accent: '#A8C95E',
  },
  metrics: { artworkSize: 0, controlSize: 44, gap: 10, radius: 16 },
};

export const builtinTransportDefinitions: readonly LyricsTransportDefinition[] = [
  BUILTIN_WINDOW_TRANSPORT,
  BUILTIN_FULLSCREEN_TRANSPORT,
];

export function builtinTransportDefinition(
  surface: LyricsTransportSurface,
): LyricsTransportDefinition {
  return surface === 'window' ? BUILTIN_WINDOW_TRANSPORT : BUILTIN_FULLSCREEN_TRANSPORT;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(source: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(source).every((key) => allowed.includes(key));
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

function integerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function reject(reason: string, detail: Record<string, unknown> = {}): null {
  logger.warn(LYRICS_TRANSPORT_REJECTED, `lyrics transport declaration rejected: ${reason}`, {
    code: LYRICS_TRANSPORT_REJECTED,
    ...detail,
  });
  return null;
}

const TRANSPORT_KEYS = [
  'schemaVersion',
  'id',
  'name',
  'surface',
  'layout',
  'actions',
  'icons',
  'tokens',
  'metrics',
];
const TOKEN_KEYS = ['surface', 'text', 'muted', 'accent'];
const METRIC_KEYS = ['artworkSize', 'controlSize', 'gap', 'radius'];

/**
 * Strict validator for plugin-declared transport bars.
 *
 * Unknown fields, unknown actions, illegal colors/sizes, duplicated actions and
 * oversized action lists are rejected as a whole instead of being partially
 * applied.
 */
export function validateTransportDefinition(value: unknown): LyricsTransportDefinition | null {
  if (!isPlainObject(value)) return reject('declaration is not an object');
  if (!hasOnlyKeys(value, TRANSPORT_KEYS))
    return reject('unknown field', { keys: Object.keys(value) });
  if (value.schemaVersion !== LYRICS_TRANSPORT_SCHEMA_VERSION) {
    return reject('unsupported schema version', { schemaVersion: value.schemaVersion });
  }
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(id) || id.startsWith('builtin.')) {
    return reject('invalid id', { id });
  }
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 40)) {
    return reject('invalid name');
  }
  if (value.surface !== 'window' && value.surface !== 'fullscreen') {
    return reject('invalid surface');
  }
  if (value.layout !== 'bar' && value.layout !== 'compact' && value.layout !== 'stacked') {
    return reject('invalid layout');
  }
  if (!Array.isArray(value.actions)) return reject('actions must be an array');
  if (value.actions.length === 0 || value.actions.length > MAX_TRANSPORT_ACTIONS) {
    return reject('action count out of range', { count: value.actions.length });
  }
  const actions: LyricsTransportActionId[] = [];
  for (const action of value.actions) {
    if (
      typeof action !== 'string' ||
      !LYRICS_TRANSPORT_ACTIONS.includes(action as LyricsTransportActionId)
    ) {
      return reject('unknown action', { action });
    }
    if (actions.includes(action as LyricsTransportActionId)) {
      return reject('duplicate action', { action });
    }
    actions.push(action as LyricsTransportActionId);
  }
  let icons: LyricsTransportIcons = {};
  if (value.icons !== undefined) {
    if (!isPlainObject(value.icons)) return reject('icons must be an object');
    const slots = Object.keys(TRANSPORT_ICON_IDS);
    if (!hasOnlyKeys(value.icons, slots)) return reject('unknown icon slot');
    for (const [action, icon] of Object.entries(value.icons)) {
      if (!actions.includes(action as LyricsTransportActionId)) {
        return reject('icon for an undeclared action', { action });
      }
      const allowed = TRANSPORT_ICON_IDS[action as LyricsTransportControlActionId];
      if (typeof icon !== 'string' || !allowed.includes(icon as LyricsTransportIconId)) {
        return reject('unknown icon id', { action, icon });
      }
      icons = { ...icons, [action]: icon as LyricsTransportIconId };
    }
  }
  if (!isPlainObject(value.tokens)) return reject('tokens must be an object');
  if (!hasOnlyKeys(value.tokens, TOKEN_KEYS)) return reject('unknown token');
  const tokens = {} as LyricsTransportTokens;
  for (const key of TOKEN_KEYS) {
    const token = value.tokens[key];
    if (!isHexColor(token)) return reject('illegal color token', { token: key });
    tokens[key as keyof LyricsTransportTokens] = normalizeHexColor(token);
  }
  if (!isPlainObject(value.metrics)) return reject('metrics must be an object');
  if (!hasOnlyKeys(value.metrics, METRIC_KEYS)) return reject('unknown metric');
  const metrics = value.metrics;
  if (
    !integerInRange(metrics.artworkSize, 0, 96) ||
    (metrics.artworkSize !== 0 && metrics.artworkSize < 24)
  ) {
    return reject('illegal artwork size', { artworkSize: metrics.artworkSize });
  }
  if (
    !integerInRange(metrics.controlSize, MIN_TRANSPORT_CONTROL_SIZE, MAX_TRANSPORT_CONTROL_SIZE)
  ) {
    return reject('illegal control size', { controlSize: metrics.controlSize });
  }
  if (!integerInRange(metrics.gap, 0, 24)) return reject('illegal gap');
  if (!integerInRange(metrics.radius, 6, 32)) return reject('illegal radius');
  return {
    schemaVersion: LYRICS_TRANSPORT_SCHEMA_VERSION,
    id,
    ...(typeof value.name === 'string' && value.name.trim() ? { name: value.name.trim() } : {}),
    surface: value.surface,
    layout: value.layout,
    actions,
    icons,
    tokens,
    metrics: {
      artworkSize: metrics.artworkSize,
      controlSize: metrics.controlSize,
      gap: metrics.gap,
      radius: metrics.radius,
    },
  };
}

/**
 * Hides actions the plugin is not granted. A declaration without any remaining
 * action is unusable and resolves back to the built-in preset.
 */
export function authorizeTransportDefinition(
  definition: LyricsTransportDefinition,
  granted: ReadonlySet<string>,
): ResolvedLyricsTransportDefinition | null {
  const readable = granted.has('player.read');
  const controllable = granted.has('player.control');
  const actions = definition.actions.filter((action) =>
    TRANSPORT_CONTROL_ACTIONS.includes(action) ? controllable : readable,
  );
  if (actions.length === 0) return null;
  const icons: LyricsTransportIcons = {};
  for (const [action, icon] of Object.entries(definition.icons)) {
    if (actions.includes(action as LyricsTransportActionId)) {
      icons[action as LyricsTransportControlActionId] = icon;
    }
  }
  return { ...definition, actions, icons, canSeek: readable && controllable };
}

export interface LyricsTransportCatalogEntry {
  pluginId: string;
  definition: LyricsTransportDefinition;
  grantedPermissions: readonly string[];
}

let pluginTransportCatalog: LyricsTransportCatalogEntry[] = [];
const catalogListeners = new Set<() => void>();
let catalogVersion = 0;

export function transportCatalogVersion(): number {
  return catalogVersion;
}

/** Lets the renderer re-resolve when plugins load, unload or lose grants. */
export function subscribeTransportCatalog(listener: () => void): () => void {
  catalogListeners.add(listener);
  return () => catalogListeners.delete(listener);
}

export function setPluginTransportCatalog(entries: readonly LyricsTransportCatalogEntry[]): void {
  const accepted: LyricsTransportCatalogEntry[] = [];
  for (const entry of entries) {
    const valid = validateTransportDefinition(entry.definition);
    if (!valid) continue;
    accepted.push({
      pluginId: entry.pluginId,
      definition: valid,
      grantedPermissions: [...entry.grantedPermissions],
    });
  }
  pluginTransportCatalog = accepted;
  catalogVersion += 1;
  for (const listener of [...catalogListeners]) listener();
}

export function getPluginTransportCatalog(): readonly LyricsTransportCatalogEntry[] {
  return pluginTransportCatalog;
}

export function isPluginTransportId(id: string): boolean {
  return pluginTransportCatalog.some((entry) => entry.definition.id === id);
}

export function listTransportPresets(surface: LyricsTransportSurface): Array<{
  id: string;
  nameKey?: string;
  name?: string;
  source: 'built-in' | 'plugin';
  pluginId?: string;
}> {
  const presets: Array<{
    id: string;
    nameKey?: string;
    name?: string;
    source: 'built-in' | 'plugin';
    pluginId?: string;
  }> = builtinTransportDefinitions.map((builtin) => ({
    id: builtin.id,
    nameKey:
      builtin.id === BUILTIN_TRANSPORT_WINDOW_ID
        ? 'transportWindowBuiltin'
        : 'transportFullscreenBuiltin',
    source: 'built-in',
  }));
  for (const entry of pluginTransportCatalog) {
    if (
      entry.definition.surface !== surface ||
      !authorizeTransportDefinition(entry.definition, new Set(entry.grantedPermissions))
    )
      continue;
    presets.push({
      id: entry.definition.id,
      name: entry.definition.name ?? entry.definition.id,
      source: 'plugin',
      pluginId: entry.pluginId,
    });
  }
  return presets;
}

export function transportPresetIdForSurface(
  state: LyricsTransportState,
  surface: LyricsTransportSurface,
): string {
  const requested = surface === 'window' ? state.window : state.fullscreen;
  return typeof requested === 'string' && requested
    ? requested
    : builtinTransportDefinition(surface).id;
}

/**
 * Resolves the bar for a surface. Unknown, revoked or rejected selections fall
 * back to the built-in preset without touching playback.
 */
export function resolveLyricsTransport(
  state: LyricsTransportState,
  surface: LyricsTransportSurface,
): ResolvedLyricsTransportDefinition {
  const builtin = { ...builtinTransportDefinition(surface), canSeek: true };
  const requested = transportPresetIdForSurface(state, surface);
  const selectedBuiltin = builtinTransportDefinitions.find((preset) => preset.id === requested);
  if (selectedBuiltin) return { ...selectedBuiltin, surface, canSeek: true };
  const entry = pluginTransportCatalog.find(
    (candidate) =>
      candidate.definition.id === requested && candidate.definition.surface === surface,
  );
  if (!entry) return builtin;
  return (
    authorizeTransportDefinition(entry.definition, new Set(entry.grantedPermissions)) ?? builtin
  );
}

export function normalizeLyricsTransportState(value: unknown): LyricsTransportState {
  if (!isPlainObject(value)) return { ...defaultLyricsTransportState };
  if (value.schemaVersion !== LYRICS_TRANSPORT_SCHEMA_VERSION) {
    return { ...defaultLyricsTransportState };
  }
  const read = (surface: LyricsTransportSurface, fallback: string): string => {
    const candidate = surface === 'window' ? value.window : value.fullscreen;
    if (typeof candidate !== 'string') return fallback;
    const trimmed = candidate.trim();
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(trimmed)) return fallback;
    return trimmed;
  };
  return {
    schemaVersion: LYRICS_TRANSPORT_SCHEMA_VERSION,
    window: read('window', BUILTIN_TRANSPORT_WINDOW_ID),
    fullscreen: read('fullscreen', BUILTIN_TRANSPORT_FULLSCREEN_ID),
  };
}

/** True when a persisted document predates the transport block or is malformed. */
export function lyricsTransportRequiresMigration(value: unknown): boolean {
  if (!isPlainObject(value)) return true;
  if (value.schemaVersion !== LYRICS_TRANSPORT_SCHEMA_VERSION) return true;
  for (const surface of ['window', 'fullscreen'] as const) {
    const candidate = surface === 'window' ? value.window : value.fullscreen;
    if (typeof candidate !== 'string' || !candidate.trim()) return true;
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(candidate.trim())) return true;
  }
  return false;
}

/**
 * Clamps a playback snapshot for display. Non-finite positions (NaN,
 * -Infinity) and empty timelines resolve to 0 so the bar never writes an
 * invalid CSS value into `--range-progress`.
 */
export function clampTransportPositionMs(positionMs: number, durationMs: number): number {
  if (!Number.isFinite(positionMs) || positionMs <= 0) return 0;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return positionMs;
  return Math.min(positionMs, durationMs);
}

/** Percentage (0-100) of the timeline already played, safe for CSS values. */
export function transportProgressPercent(positionMs: number, durationMs: number): number {
  if (!Number.isFinite(positionMs) || !Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.min(100, Math.max(0, (positionMs / durationMs) * 100));
}

/** Resolves the glyph for a control action, falling back to the built-in one. */
export function transportIconIdFor(
  definition: LyricsTransportDefinition,
  action: LyricsTransportControlActionId,
): LyricsTransportIconId {
  return definition.icons[action] ?? TRANSPORT_DEFAULT_ICONS[action];
}

export function transportDefinitionCssVariables(
  definition: LyricsTransportDefinition,
): Record<string, string> {
  return {
    '--transport-surface': definition.tokens.surface,
    '--transport-text': definition.tokens.text,
    '--transport-muted': definition.tokens.muted,
    '--transport-accent': definition.tokens.accent,
    '--transport-gap': `${definition.metrics.gap}px`,
    '--transport-control-size': `${definition.metrics.controlSize}px`,
    '--transport-radius': `${definition.metrics.radius}px`,
    '--transport-artwork-size': `${definition.metrics.artworkSize}px`,
  };
}
