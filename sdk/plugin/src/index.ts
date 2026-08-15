/**
 * YAQMC runtime plugin SDK (compile-time types).
 *
 * This is not a Tauri framework plugin API. Application code must not be imported
 * from `src/`. Build TypeScript to `dist/main.js` and ship it inside a
 * `*.yaqmc-plugin` package. The production host executes that JavaScript in an
 * isolated worker; it does not compile TypeScript at runtime.
 */

export type PluginPermission =
  | 'track.read'
  | 'lyrics.read'
  | 'player.read'
  | 'player.control'
  | 'theme.read'
  | 'plugin.storage'
  | 'scene.register'
  | 'style.register';

/** Reserved for future API versions. v1 does not implement these. */
export type FuturePluginPermission =
  'network' | 'filesystem' | 'provider' | 'account' | 'native' | 'shell';

export type PluginEventName =
  | 'track.changed'
  | 'playback.stateChanged'
  | 'playback.positionCommitted'
  | 'lyrics.lineChanged'
  | 'theme.changed';

export interface PluginTrack {
  id: string | null;
  title: string | null;
  artists?: string[];
  album?: string | null;
  durationMs?: number;
  queueEntryId?: string | null;
  sessionId?: number;
}

export interface PluginPlaybackSnapshot {
  isPlaying: boolean;
  positionMs: number;
  sessionId: number;
  snapshotRevision?: number;
}

export interface PluginStorage {
  get(key: string): Promise<{ value: string | null }>;
  set(key: string, value: string): Promise<{ ok: true }>;
}

export interface PluginEvents {
  on(event: PluginEventName, handler: (payload: unknown) => void): () => void;
}

export interface PluginContext {
  events: PluginEvents;
  track: { get(): Promise<PluginTrack> };
  lyrics: { get(): Promise<{ songId?: string; lines: string[] }> };
  player: {
    get(): Promise<PluginPlaybackSnapshot>;
    play(): Promise<{ ok: true }>;
    pause(): Promise<{ ok: true }>;
    toggle(): Promise<{ ok: true }>;
    next(): Promise<{ ok: true }>;
    previous(): Promise<{ ok: true }>;
    seek(positionMs: number): Promise<{ ok: true; positionMs: number }>;
  };
  theme: { get(): Promise<{ source: string }> };
  storage: PluginStorage;
  log: {
    info(message: string): Promise<{ ok: true }>;
    warn(message: string): Promise<{ ok: true }>;
    error(message: string): Promise<{ ok: true }>;
  };
}

export interface PluginDefinition {
  activate(ctx: PluginContext): void | (() => void);
}

export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition;
}

/** Future UI slots. Not implemented in Plugin Platform v1. */
export type ReservedUiSlot = 'sidebar' | 'playerBar' | 'contextMenu' | 'settings' | 'home';
