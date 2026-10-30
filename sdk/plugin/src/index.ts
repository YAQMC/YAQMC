/**
 * YAQMC runtime plugin SDK (compile-time types).
 *
 * This is not an Electron extension API. Application code must not be imported
 * from `src/`. Build TypeScript to `dist/main.js` and ship it inside a
 * `*.yaqmc-plugin` package. The production host executes that JavaScript in an
 * isolated worker; it does not compile TypeScript at runtime.
 */

/** Optional manifest release metadata. Build IDs do not affect SemVer ordering. */
export interface PluginReleaseInfo {
  channel: 'stable' | 'beta' | 'nightly';
  buildId: string;
  /** Positive, monotonically increasing safe integer across all channels. */
  releaseSequence: number;
}

export interface PluginProviderManifest {
  id: string;
  name?: string;
  witVersion: string;
  world:
    | 'provider'
    | 'provider-storage'
    | 'provider-network'
    | 'provider-network-storage'
    | 'provider-account';
  capabilities: Array<
    | 'provider.catalog'
    | 'provider.playback'
    | 'provider.recommendation'
    | 'provider.lyrics'
    | 'provider.comments'
    | 'provider.account'
  >;
  platform?: string;
  /** Defaults to 1. Increment when saved sessions cannot be reused safely. */
  sessionSchemaVersion?: number;
}

export interface PluginManifest {
  manifestVersion: number;
  apiVersion: number;
  id: string;
  name: string;
  version: string;
  release?: PluginReleaseInfo;
  description?: string;
  authors?: string[];
  homepage?: string;
  repository?: string;
  license?: string;
  engines?: { yaqmc?: string };
  platforms?: string[];
  architectures?: string[];
  entrypoints?: { styles?: string[]; scenes?: string[]; script?: string; component?: string };
  provider?: PluginProviderManifest;
  providers?: PluginProviderManifest[];
  federations?: Array<{
    id: string;
    name?: string;
    members?: string[];
    includeDefaultProvider?: boolean;
  }>;
  permissions?: string[];
  dependencies?: Record<string, string>;
  conflicts?: string[];
  settingsSchema?: unknown;
}

export type PluginPermission =
  | 'track.read'
  | 'lyrics.read'
  | 'player.read'
  | 'player.control'
  | 'theme.read'
  | 'plugin.storage'
  | 'scene.register'
  | 'style.register'
  | 'ui.contextMenu'
  | 'ui.playerBar'
  | 'ui.sidebar'
  | 'ui.notify'
  | `network:https://${string}`;

/** Reserved capabilities. Raw fetch, filesystem, and account credentials stay denied. */
export type FuturePluginPermission =
  'network' | 'filesystem' | 'provider' | 'account' | 'native' | 'shell';

/** API v3 Wasm capability, declared in both provider.capabilities and permissions.
 * invoke("provider.comments", "comments.list", JSON.stringify(request))
 * The host renders the drawer and lyrics overlay; this capability is read-only.
 */
export type PluginCommentSort = 'hot' | 'new';
export interface PluginSongCommentsRequest {
  songId: string;
  sort: PluginCommentSort;
  cursor?: string | null;
  limit: number;
  parentId?: string | null;
}
export interface PluginSongComment {
  id: string;
  content: string;
  author: string;
  likedCount: number;
  avatarUrl?: string | null;
  timeMs?: number | null;
  replyCount?: number | null;
  replyTo?: { author: string; content: string } | null;
}
export interface PluginSongCommentsPage {
  items: PluginSongComment[];
  nextCursor: string | null;
  total: number | null;
  supportedSorts: PluginCommentSort[];
  repliesSupported: boolean;
}

export type PluginEventName =
  | 'track.changed'
  | 'playback.stateChanged'
  | 'playback.position'
  | 'playback.positionCommitted'
  | 'playback.modeChanged'
  | 'queue.changed'
  | 'lyrics.documentChanged'
  | 'lyrics.lineChanged'
  | 'theme.changed'
  | 'scene.changed'
  | 'settings.changed'
  | 'ui.action';

export interface PluginTrack {
  id: string | null;
  title: string | null;
  artists?: string[];
  album?: string | null;
  durationMs?: number;
  quality?: string;
  artwork?: { alt?: string; dominantColor?: string };
  queueEntryId?: string | null;
  sessionId?: number;
}

export interface PluginPlaybackSnapshot {
  state?: string;
  isPlaying: boolean;
  positionMs: number;
  durationMs?: number | null;
  volume?: number;
  muted?: boolean;
  sessionId: number;
  snapshotRevision?: number;
  repeat?: string;
  playbackOrder?: string;
  primaryPlaybackMode?: string;
  queueEntryId?: string | null;
}

export interface PluginLyricsSnapshot {
  songId?: string;
  syncMode?: string;
  lines: string[];
  timedLines?: Array<{
    id: string;
    text: string;
    translation?: string | null;
    romanization?: string | null;
    startMs?: number | null;
    endMs?: number | null;
  }>;
  currentLine?: number | null;
  positionMs?: number;
}

/** Declarative scene.lyrics.wordAnimation; the host owns timing and playback. */
export interface PluginLyricWordAnimation {
  easing?: 'linear' | 'ease-out' | 'ease-in-out';
  keyframes: Array<{
    offset: number;
    y?: number;
    scale?: number;
    rotate?: number;
    glow?: number;
  }>;
}

/** State supplied to a plugin-owned lyrics background surface. */
export interface PluginSceneBackgroundState {
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  visible: boolean;
  reducedMotion: boolean;
  songId: string | null;
  artwork: ImageBitmap | null;
  artworkColor: string;
}

/** A host-owned canvas transferred once to the plugin Worker. */
export interface PluginSceneBackgroundSurface extends PluginSceneBackgroundState {
  canvas: OffscreenCanvas;
}

export interface PluginSceneBackgroundHandlers {
  mount(surface: PluginSceneBackgroundSurface): void | Promise<void>;
  update?(state: PluginSceneBackgroundState): void | Promise<void>;
  unmount?(): void | Promise<void>;
}

export interface PluginStorage {
  get(key: string): Promise<{ value: string | null }>;
  set(key: string, value: string): Promise<{ ok: true }>;
}

export interface PluginEvents {
  on(event: PluginEventName, handler: (payload: unknown) => void): () => void;
}

export interface PluginUiAction {
  id: string;
  label: string;
  icon?: string;
}

export interface PluginNotifyOptions {
  level?: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export interface PluginNetworkRequest {
  url: string;
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
}

export interface PluginContext {
  plugin: { id: string };
  events: PluginEvents;
  track: { get(): Promise<PluginTrack>; read(): Promise<PluginTrack> };
  lyrics: { get(): Promise<PluginLyricsSnapshot>; read(): Promise<PluginLyricsSnapshot> };
  player: {
    get(): Promise<PluginPlaybackSnapshot>;
    read(): Promise<PluginPlaybackSnapshot>;
    play(): Promise<{ ok: true }>;
    pause(): Promise<{ ok: true }>;
    toggle(): Promise<{ ok: true }>;
    next(): Promise<{ ok: true }>;
    previous(): Promise<{ ok: true }>;
    seek(positionMs: number): Promise<{ ok: true; positionMs: number }>;
  };
  theme: { get(): Promise<{ source: string; colorMode?: string }> };
  storage: PluginStorage;
  settings: {
    get(): Promise<Record<string, unknown>>;
    set(values: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  ui: {
    contextMenu: { track: { register(action: PluginUiAction): Promise<{ ok: true }> } };
    playerBar: { register(action: PluginUiAction): Promise<{ ok: true }> };
    sidebar: { register(action: PluginUiAction): Promise<{ ok: true }> };
    notify(options: PluginNotifyOptions | string): Promise<{ ok: true }>;
  };
  network: {
    request(request: PluginNetworkRequest): Promise<{ ok: boolean; status: number; body: string }>;
  };
  scenes: {
    onMount(sceneId: string, handler: (payload: unknown) => void): () => void;
    onUnmount(sceneId: string, handler: (payload: unknown) => void): () => void;
    setVariable(name: string, value: string | number | boolean): Promise<{ ok: true }>;
    setState(name: string, value: string): Promise<{ ok: true }>;
    setWidgetProperty(
      widgetId: string,
      property: string,
      value: string | number | boolean,
    ): Promise<{ ok: true }>;
    animate(widgetId: string, property: string, value: string | number): Promise<{ ok: true }>;
    background: {
      register(sceneId: string, handlers: PluginSceneBackgroundHandlers): Promise<{ ok: true }>;
      unregister(sceneId: string): Promise<{ ok: true }>;
    };
  };
  log: {
    info(message: string): Promise<{ ok: true }>;
    warn(message: string): Promise<{ ok: true }>;
    error(message: string): Promise<{ ok: true }>;
  };
}

export interface PluginDefinition {
  activate(ctx: PluginContext): void | (() => void) | Promise<void | (() => void)>;
}

export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition;
}

export type ReservedUiSlot = 'sidebar' | 'playerBar' | 'contextMenu' | 'settings' | 'home';
