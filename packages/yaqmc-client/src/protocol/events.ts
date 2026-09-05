import type { LyricDocument, LyricSurfaceProjection, PlayerSnapshot } from './dto';

export const CHANNEL_API_EVENT = 'api://event';
export const CHANNEL_PLAYER_SNAPSHOT = 'player://snapshot';
export const CHANNEL_LYRICS_PROJECTION = 'lyrics://projection';
export const CHANNEL_LYRICS_DOCUMENT = 'lyrics://document';
export const CHANNEL_PLUGIN_CHANGED = 'plugin://changed';
export const CHANNEL_PREFERENCES_CHANGED = 'preferences://changed';
export const CHANNEL_HOST_COMMAND = 'host://command';
export const CHANNEL_HOST_CORE_STATUS = 'host://core-status';
export const CHANNEL_HOST_UPDATE = 'host://update';
export const CHANNEL_CORE_LOG = 'core://log';
export const CHANNEL_ACCOUNT_CHANGED = 'account://changed';
export const CHANNEL_LYRICS_SURFACE_CLOSED = 'lyrics://surface-closed';
export const CHANNEL_LYRICS_SURFACE_INTERACTION = 'lyrics://surface-interaction';
export const CHANNEL_APP_OPEN_SETTINGS = 'app://open-settings';
export const CHANNEL_APP_OPEN_CATALOG_SONG = 'app://open-catalog-song';

export const CORE_EVENT_CHANNELS = [
  CHANNEL_API_EVENT,
  CHANNEL_PLAYER_SNAPSHOT,
  CHANNEL_LYRICS_PROJECTION,
  CHANNEL_LYRICS_DOCUMENT,
  CHANNEL_PLUGIN_CHANGED,
  CHANNEL_PREFERENCES_CHANGED,
  CHANNEL_HOST_COMMAND,
  CHANNEL_CORE_LOG,
  CHANNEL_ACCOUNT_CHANGED,
] as const;

export const HOST_EVENT_CHANNELS = [
  CHANNEL_LYRICS_SURFACE_CLOSED,
  CHANNEL_LYRICS_SURFACE_INTERACTION,
  CHANNEL_APP_OPEN_SETTINGS,
  CHANNEL_APP_OPEN_CATALOG_SONG,
  CHANNEL_HOST_CORE_STATUS,
  CHANNEL_HOST_UPDATE,
] as const;

export type CoreChannelName = (typeof CORE_EVENT_CHANNELS)[number];
export type HostChannelName = (typeof HOST_EVENT_CHANNELS)[number];
export type ChannelName = CoreChannelName | HostChannelName;

export interface ApiEventPayload {
  version: number;
  type: string;
  timestampMs: number;
  data: unknown;
}

export interface PluginChangedPayload {
  pluginId: string;
  enabled: boolean;
}

export interface PreferencesChangedPayload {
  key: string;
}

export interface HostCommandPayload {
  command: 'raise' | 'quit';
}

export interface CoreLogPayload {
  level: string;
  target: string;
  message: string;
}

export interface AccountChangedPayload {
  signedIn: boolean;
}

export interface LyricsSurfaceClosedPayload {
  surface: string;
}

export interface LyricsSurfaceInteractionPayload {
  kind: 'desktop' | 'island';
  interaction: 'interactive' | 'passive-locked';
}

export interface OpenSettingsPayload {
  section: string;
}

export interface OpenCatalogSongPayload {
  providerId: string;
  entityId: string;
}

export type CoreStatus = 'down' | 'restarting' | 'ready' | 'safe-mode';

export interface CoreStatusPayload {
  status: CoreStatus;
}

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'error'
  | 'downloading'
  | 'ready-to-install';

export interface UpdatePayload {
  state: UpdateState;
  canInstall: boolean;
  allowPrerelease: boolean;
  channel: string;
  version?: string;
  releaseUrl?: string;
  releaseNotes?: string;
  error?: string;
}

export interface ChannelPayload {
  [CHANNEL_API_EVENT]: ApiEventPayload;
  [CHANNEL_PLAYER_SNAPSHOT]: PlayerSnapshot;
  [CHANNEL_LYRICS_PROJECTION]: LyricSurfaceProjection;
  [CHANNEL_LYRICS_DOCUMENT]: LyricDocument;
  [CHANNEL_PLUGIN_CHANGED]: PluginChangedPayload;
  [CHANNEL_PREFERENCES_CHANGED]: PreferencesChangedPayload;
  [CHANNEL_HOST_COMMAND]: HostCommandPayload;
  [CHANNEL_CORE_LOG]: CoreLogPayload;
  [CHANNEL_ACCOUNT_CHANGED]: AccountChangedPayload;
  [CHANNEL_LYRICS_SURFACE_CLOSED]: LyricsSurfaceClosedPayload;
  [CHANNEL_LYRICS_SURFACE_INTERACTION]: LyricsSurfaceInteractionPayload;
  [CHANNEL_APP_OPEN_SETTINGS]: OpenSettingsPayload;
  [CHANNEL_APP_OPEN_CATALOG_SONG]: OpenCatalogSongPayload;
  [CHANNEL_HOST_CORE_STATUS]: CoreStatusPayload;
  [CHANNEL_HOST_UPDATE]: UpdatePayload;
}
