# YAQMC 插件 API 参考

由 YAQMC 的 SDK 与公共文档生成。请在仓库执行 `npm run plugin:example:sync` 更新。

| 接口                                                                    | 权限                                               |
| ----------------------------------------------------------------------- | -------------------------------------------------- |
| `ctx.track.get/read`                                                    | `track.read`                                       |
| `ctx.lyrics.get/read`                                                   | `lyrics.read`                                      |
| `ctx.player.get/read`                                                   | `player.read`                                      |
| `ctx.player.play/pause/toggle/next/previous/seek`                       | `player.control`                                   |
| `ctx.theme.get`                                                         | `theme.read`                                       |
| `ctx.storage.get/set`, `ctx.settings.get/set`                           | `plugin.storage`                                   |
| `ctx.ui.lyrics.register/unregister`                                     | `ui.lyrics`（API v4）                              |
| `ctx.ui.contextMenu.track.register`                                     | `ui.contextMenu`                                   |
| `ctx.ui.playerBar.register`, `ctx.ui.sidebar.register`, `ctx.ui.notify` | 对应的同名 UI 权限                                 |
| `ctx.pages.*`, `ctx.navigation.*`, `ctx.layout.*`                       | `ui.pages`、`ui.navigation`、`ui.layout`（API v4） |
| `ctx.scenes.*`                                                          | `scene.register`                                   |
| `ctx.network.request`                                                   | `network:https://精确域名`                         |
| `ctx.events.on`, `ctx.log.info/warn/error`                              | 事件数据按权限过滤；日志不需额外权限               |

API v1/v2/v4 是 Worker 脚本，API v3 是独立的 Wasm Provider Component；两种包形状与权限不能混用。
脚本使用 `definePlugin({ activate(ctx) { … } })`。`activate` 可返回清理函数；宿主停用时自动清理 UI。
窗口动作必须声明到歌词按钮上，宿主仅在用户点击时执行。没有原始窗口、DOM、文件、进程或账号凭据接口。

- [插件开发](api/docs/zh-CN/plugin-development.md)
- [歌词工具栏](api/docs/zh-CN/plugin-lyrics-api.md)
- [页面、导航与布局](api/docs/zh-CN/plugin-pages-api.md)
- [清单与版本](api/docs/zh-CN/plugin-manifest.md)
- [Provider Component](api/docs/zh-CN/provider-component-api.md)
- [安全边界](api/docs/zh-CN/plugin-security.md)

以下类型直接来自 `sdk/plugin/src/index.ts`，包含完整参数、返回值与事件类型：

```ts
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
  /** Requires ui.songBadges. Declarative, with no worker or per-song IPC. */
  songBadges?: Array<{
    id: string;
    providerIds: string[];
    label: string;
    labels?: Record<string, string>;
    color?: string;
  }>;
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
  | 'ui.songBadges'
  /** API v4 */
  | 'ui.pages'
  | 'ui.navigation'
  | 'ui.layout'
  | 'ui.lyrics'
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

/** API v4. A window action runs in the host only after the user presses its button. */
export interface PluginLyricsAction extends PluginUiAction {
  icon?: 'minus' | 'maximize' | 'close' | 'settings' | 'info' | 'music';
  windowAction?: 'minimize' | 'toggleMaximize' | 'close';
}

export interface PluginLyricsActionEvent {
  id: string;
  slot: 'lyrics';
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

/**
 * API v4 page document. YAQMC renders every block with its own components; plugins never supply
 * markup, styles, images, or URLs. Limits: 40 blocks, 50 list items, 8 stats, 4 actions.
 */
export type PluginPageBlock =
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string; tone?: 'default' | 'secondary' }
  | { type: 'stats'; items: Array<{ label: string; value: string }> }
  | {
      type: 'list';
      items: Array<{ id: string; title: string; subtitle?: string; actionId?: string }>;
    }
  | {
      type: 'actions';
      items: Array<{ id: string; label: string; variant?: 'primary' | 'secondary' }>;
    }
  | { type: 'notice'; text: string; level?: 'info' | 'warning' | 'error' }
  | { type: 'divider' };

/** API v4 Home sections a plugin may reorder or hide. */
export type PluginHomeSection = 'for-you' | 'radar' | 'recommended-playlists';

export interface PluginHomeLayout {
  target: 'home';
  order?: PluginHomeSection[];
  hidden?: PluginHomeSection[];
}

/** Delivered as `ui.action` with `slot: 'page'` when a page button or list item is pressed. */
export interface PluginPageActionEvent {
  id: string;
  slot: 'page';
  pageId: string;
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
    /** API v4, `ui.lyrics`. Up to 4 actions per plugin, 12 in total. */
    lyrics: {
      register(action: PluginLyricsAction): Promise<{ ok: true }>;
      unregister(id: string): Promise<{ ok: true }>;
    };
    contextMenu: { track: { register(action: PluginUiAction): Promise<{ ok: true }> } };
    playerBar: { register(action: PluginUiAction): Promise<{ ok: true }> };
    sidebar: { register(action: PluginUiAction): Promise<{ ok: true }> };
    notify(options: PluginNotifyOptions | string): Promise<{ ok: true }>;
  };
  network: {
    request(request: PluginNetworkRequest): Promise<{ ok: boolean; status: number; body: string }>;
  };
  /** API v4, `ui.pages`. Pages are plugin-scoped; ids are 1-40 chars of [A-Za-z0-9._-]. */
  pages: {
    register(page: { id: string; title: string }): Promise<{ ok: true }>;
    render(pageId: string, blocks: PluginPageBlock[]): Promise<{ ok: true }>;
    unregister(pageId: string): Promise<{ ok: true }>;
    onMount(pageId: string, handler: (payload: { pageId: string }) => void): () => void;
    onUnmount(pageId: string, handler: (payload: { pageId: string }) => void): () => void;
  };
  /** API v4, `ui.navigation`. Entries can only open this plugin's own registered pages. */
  navigation: {
    register(entry: { id: string; label: string; pageId: string }): Promise<{ ok: true }>;
    unregister(id: string): Promise<{ ok: true }>;
  };
  /** API v4, `ui.layout`. Only host-defined knobs on supported YAQMC pages. */
  layout: {
    set(layout: PluginHomeLayout): Promise<{ ok: true }>;
    clear(target: 'home'): Promise<{ ok: true }>;
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
```
