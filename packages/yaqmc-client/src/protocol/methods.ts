import type {
  AccountLoginMethod,
  AccountPlaylistDetail,
  AccountPlaylistSummary,
  AccountSnapshot,
  ActivePluginResources,
  Album,
  AreaFeed,
  AudioOutputDevice,
  AudioQualityPreference,
  BundleExportResult,
  CacheStats,
  CollectPlaylistRequest,
  CreatePlaylistRequest,
  DebugPerfSample,
  DeletePlaylistRequest,
  DesktopIntegrationStatus,
  DiagnosticsBundleRequest,
  DiagnosticsRequest,
  DiagnosticsSnapshot,
  DiscoverFeed,
  ErrorRecord,
  FavoriteMutationRequest,
  FavoriteMutationResult,
  FrontendLogEntry,
  HomeFeed,
  IssueDraft,
  IssuePreview,
  LibrarySnapshot,
  LocalApiStatus,
  LogLevel,
  LyricDocument,
  LyricSurfaceProjection,
  ManagedBackgroundImage,
  NamedRequest,
  OAuthPrepareResult,
  PingResult,
  PlatformDiagnostics,
  PlayTracksRequest,
  PlayerSnapshot,
  Playlist,
  PlaylistMutationResult,
  PlaylistTrackMutationRequest,
  PluginAsset,
  PluginBridgeRequest,
  PluginDiagnostic,
  PluginEnableRequest,
  PluginInspectResult,
  PluginInstallRequest,
  PluginRecord,
  PluginSettingsWrite,
  PluginUninstallRequest,
  PrimaryPlaybackMode,
  ProviderStatus,
  RecordErrorRequest,
  RemotePlayHistoryItem,
  RenamePlaylistRequest,
  RepeatMode,
  SearchResult,
  Song,
  SurfaceCapabilities,
  SurfaceInteraction,
  SurfaceRuntimeMap,
  Page,
} from './dto';
import type { PlatformAttach } from './types';

export const TAURI_METHOD_NAMES = [
  'platform_diagnostics',
  'platform_export_diagnostics',
  'system_integration_status',
  'system_shortcuts_set_enabled',
  'audio_output_devices',
  'audio_set_output_device',
  'qqmusic_status',
  'qqmusic_home',
  'qqmusic_discover',
  'qqmusic_area',
  'qqmusic_guess_next',
  'qqmusic_library',
  'qqmusic_search',
  'qqmusic_album',
  'qqmusic_playlist',
  'qqmusic_lyrics',
  'qqmusic_cache_artwork',
  'qqmusic_set_preferred_quality',
  'qqmusic_set_current_quality',
  'qqmusic_account_snapshot',
  'qqmusic_favorite_songs',
  'qqmusic_account_playlists',
  'qqmusic_account_playlist_tracks',
  'qqmusic_account_recently_played',
  'qqmusic_set_favorite',
  'qqmusic_create_playlist',
  'qqmusic_rename_playlist',
  'qqmusic_add_playlist_track',
  'qqmusic_remove_playlist_track',
  'qqmusic_delete_playlist',
  'qqmusic_set_playlist_collected',
  'qqmusic_auth_start',
  'qqmusic_auth_oauth_start',
  'qqmusic_auth_heartbeat',
  'qqmusic_auth_cancel',
  'qqmusic_auth_refresh',
  'qqmusic_sign_out',
  'qqmusic_cache_stats',
  'qqmusic_clear_cache',
  'player_snapshot',
  'player_hydrate_queue',
  'player_play_tracks',
  'player_play_from_queue',
  'player_play_queue_entry',
  'player_play',
  'player_pause',
  'player_toggle',
  'player_next',
  'player_previous',
  'player_seek',
  'player_set_volume',
  'player_toggle_muted',
  'player_toggle_shuffle',
  'player_set_shuffle',
  'player_cycle_repeat',
  'player_set_repeat',
  'player_set_primary_playback_mode',
  'player_add_to_queue',
  'player_add_tracks_to_queue',
  'player_remove_from_queue',
  'player_remove_queue_entry',
  'player_reorder_queue_entry',
  'player_play_next_queue_entry',
  'player_set_lyrics',
  'player_lyrics',
  'lyrics_surface_projection',
  'app_preferences_get',
  'app_preferences_set',
  'appearance_pick_background',
  'appearance_background_load',
  'lyrics_surfaces_reconcile',
  'lyrics_surface_capabilities',
  'lyrics_surface_status',
  'lyrics_surfaces_unlock_all',
  'lyrics_surface_unlock',
  'lyrics_surface_close',
  'lyrics_surface_set_interaction',
  'lyrics_surface_reset_position',
  'lyrics_surface_show_settings',
  'local_api_status',
  'local_api_set_enabled',
  'local_api_set_port',
  'local_api_reveal_token',
  'local_api_regenerate_token',
  'debug_perf_sample',
  'diagnostics_snapshot',
  'diagnostics_export_bundle',
  'diagnostics_reveal_bundle',
  'diagnostics_open_log_folder',
  'diagnostics_clear_logs',
  'diagnostics_set_log_level',
  'diagnostics_current_level',
  'diagnostics_recent_errors',
  'diagnostics_record_error',
  'diagnostics_log_frontend',
  'issue_reporter_preview',
  'issue_reporter_validate_url',
  'plugin_list',
  'plugin_pick_package',
  'plugin_inspect_path',
  'plugin_install',
  'plugin_set_enabled',
  'plugin_uninstall',
  'plugin_set_safe_mode',
  'plugin_set_developer_mode',
  'plugin_active_resources',
  'plugin_diagnostics',
  'plugin_runtime_start',
  'plugin_runtime_stop',
  'plugin_mark_failed',
  'plugin_bridge',
  'plugin_pick_directory',
  'plugin_install_unpacked',
  'plugin_reload',
  'plugin_read_asset',
  'plugin_settings_get',
  'plugin_settings_set',
] as const;

export const PROTOCOL_ONLY_METHODS = [
  'core_ping',
  'platform_attach',
  'core_shutdown_prepare',
  'auth_oauth_prepare',
  'auth_oauth_complete',
  'auth_oauth_cancel',
  'app_settings_get',
  'app_settings_set',
  'app_settings_remove',
  'diagnostics_export_bundle_to',
  'preferences_set_background_from',
  'plugin_install_from',
] as const;

export const METHOD_NAMES = [...TAURI_METHOD_NAMES, ...PROTOCOL_ONLY_METHODS] as const;

export type TauriMethodName = (typeof TAURI_METHOD_NAMES)[number];
export type ProtocolOnlyMethodName = (typeof PROTOCOL_ONLY_METHODS)[number];
export type MethodName = (typeof METHOD_NAMES)[number];

type Exhaustive<T extends Record<MethodName, unknown>> = T;

export type MethodParams = Exhaustive<{
  platform_diagnostics: void;
  platform_export_diagnostics: void;
  system_integration_status: void;
  system_shortcuts_set_enabled: { enabled: boolean };
  audio_output_devices: void;
  audio_set_output_device: { deviceId: string };
  qqmusic_status: void;
  qqmusic_home: { refresh: boolean };
  qqmusic_discover: { refresh: boolean };
  qqmusic_area: { encArea: string };
  qqmusic_guess_next: { limit: number };
  qqmusic_library: void;
  qqmusic_search: { query: string; page: number; limit: number };
  qqmusic_album: { id: string };
  qqmusic_playlist: { id: string };
  qqmusic_lyrics: { songId: string };
  qqmusic_cache_artwork: { url: string };
  qqmusic_set_preferred_quality: { quality: AudioQualityPreference };
  qqmusic_set_current_quality: { quality: AudioQualityPreference };
  qqmusic_account_snapshot: void;
  qqmusic_favorite_songs: { cursor: string | null; limit: number };
  qqmusic_account_playlists: { cursor: string | null; limit: number };
  qqmusic_account_playlist_tracks: {
    playlist: AccountPlaylistSummary;
    cursor: string | null;
    limit: number;
  };
  qqmusic_account_recently_played: { cursor: string | null; limit: number };
  qqmusic_set_favorite: NamedRequest<FavoriteMutationRequest>;
  qqmusic_create_playlist: NamedRequest<CreatePlaylistRequest>;
  qqmusic_rename_playlist: NamedRequest<RenamePlaylistRequest>;
  qqmusic_add_playlist_track: NamedRequest<PlaylistTrackMutationRequest>;
  qqmusic_remove_playlist_track: NamedRequest<PlaylistTrackMutationRequest>;
  qqmusic_delete_playlist: NamedRequest<DeletePlaylistRequest>;
  qqmusic_set_playlist_collected: NamedRequest<CollectPlaylistRequest>;
  qqmusic_auth_start: void;
  qqmusic_auth_oauth_start: { loginProvider: AccountLoginMethod };
  qqmusic_auth_heartbeat: { attemptId: string; ownerLeaseId: string };
  qqmusic_auth_cancel: { attemptId: string };
  qqmusic_auth_refresh: { attemptId: string | null };
  qqmusic_sign_out: void;
  qqmusic_cache_stats: void;
  qqmusic_clear_cache: void;
  player_snapshot: void;
  player_hydrate_queue: { tracks: Song[] };
  player_play_tracks: NamedRequest<PlayTracksRequest>;
  player_play_from_queue: { index: number };
  player_play_queue_entry: { entryId: string };
  player_play: void;
  player_pause: void;
  player_toggle: void;
  player_next: void;
  player_previous: void;
  player_seek: { positionMs: number };
  player_set_volume: { volume: number };
  player_toggle_muted: void;
  player_toggle_shuffle: void;
  player_set_shuffle: { enabled: boolean };
  player_cycle_repeat: void;
  player_set_repeat: { mode: RepeatMode };
  player_set_primary_playback_mode: { mode: PrimaryPlaybackMode };
  player_add_to_queue: { track: Song };
  player_add_tracks_to_queue: { tracks: Song[] };
  player_remove_from_queue: { index: number };
  player_remove_queue_entry: { entryId: string };
  player_reorder_queue_entry: { entryId: string; targetIndex: number };
  player_play_next_queue_entry: { entryId: string };
  player_set_lyrics: { document: LyricDocument | null };
  player_lyrics: void;
  lyrics_surface_projection: void;
  app_preferences_get: void;
  app_preferences_set: { value: string };
  appearance_pick_background: void;
  appearance_background_load: { reference: string };
  lyrics_surfaces_reconcile: { surfaces: SurfaceRuntimeMap };
  lyrics_surface_capabilities: void;
  lyrics_surface_status: void;
  lyrics_surfaces_unlock_all: void;
  lyrics_surface_unlock: { kind: string };
  lyrics_surface_close: { kind: string };
  lyrics_surface_set_interaction: {
    kind: string;
    interaction: SurfaceInteraction;
    value: string;
  };
  lyrics_surface_reset_position: { kind: string };
  lyrics_surface_show_settings: void;
  local_api_status: void;
  local_api_set_enabled: { enabled: boolean };
  local_api_set_port: { port: number };
  local_api_reveal_token: void;
  local_api_regenerate_token: void;
  debug_perf_sample: { sample: DebugPerfSample };
  diagnostics_snapshot: NamedRequest<DiagnosticsRequest>;
  diagnostics_export_bundle: NamedRequest<DiagnosticsBundleRequest>;
  diagnostics_reveal_bundle: { path: string };
  diagnostics_open_log_folder: void;
  diagnostics_clear_logs: void;
  diagnostics_set_log_level: { level: LogLevel };
  diagnostics_current_level: void;
  diagnostics_recent_errors: void;
  diagnostics_record_error: NamedRequest<RecordErrorRequest>;
  diagnostics_log_frontend: { entries: FrontendLogEntry[] };
  issue_reporter_preview: { draft: IssueDraft; request: DiagnosticsRequest };
  issue_reporter_validate_url: { url: string };
  plugin_list: void;
  plugin_pick_package: void;
  plugin_inspect_path: { path: string };
  plugin_install: NamedRequest<PluginInstallRequest>;
  plugin_set_enabled: NamedRequest<PluginEnableRequest>;
  plugin_uninstall: NamedRequest<PluginUninstallRequest>;
  plugin_set_safe_mode: { enabled: boolean };
  plugin_set_developer_mode: { enabled: boolean };
  plugin_active_resources: void;
  plugin_diagnostics: void;
  plugin_runtime_start: { pluginId: string };
  plugin_runtime_stop: { token: string };
  plugin_mark_failed: { id: string; reason: string };
  plugin_bridge: NamedRequest<PluginBridgeRequest>;
  plugin_pick_directory: void;
  plugin_install_unpacked: NamedRequest<PluginInstallRequest>;
  plugin_reload: { id: string };
  plugin_read_asset: { pluginId: string; path: string };
  plugin_settings_get: { id: string };
  plugin_settings_set: NamedRequest<PluginSettingsWrite>;
  core_ping: void;
  platform_attach: PlatformAttach;
  core_shutdown_prepare: void;
  auth_oauth_prepare: { providerKind: AccountLoginMethod };
  auth_oauth_complete: { attemptId: string; callbackUrl: string };
  auth_oauth_cancel: { attemptId: string };
  app_settings_get: { key: string };
  app_settings_set: { key: string; value: string };
  app_settings_remove: { key: string };
  diagnostics_export_bundle_to: { path: string; request: DiagnosticsBundleRequest };
  preferences_set_background_from: { path: string };
  plugin_install_from: NamedRequest<PluginInstallRequest>;
}>;

export type MethodResult = Exhaustive<{
  platform_diagnostics: PlatformDiagnostics;
  platform_export_diagnostics: string;
  system_integration_status: DesktopIntegrationStatus;
  system_shortcuts_set_enabled: DesktopIntegrationStatus;
  audio_output_devices: AudioOutputDevice[];
  audio_set_output_device: AudioOutputDevice[];
  qqmusic_status: ProviderStatus;
  qqmusic_home: HomeFeed;
  qqmusic_discover: DiscoverFeed;
  qqmusic_area: AreaFeed;
  qqmusic_guess_next: Song[];
  qqmusic_library: LibrarySnapshot;
  qqmusic_search: SearchResult;
  qqmusic_album: Album;
  qqmusic_playlist: Playlist;
  qqmusic_lyrics: LyricDocument | null;
  qqmusic_cache_artwork: string;
  qqmusic_set_preferred_quality: ProviderStatus;
  qqmusic_set_current_quality: PlayerSnapshot;
  qqmusic_account_snapshot: AccountSnapshot;
  qqmusic_favorite_songs: Page<Song>;
  qqmusic_account_playlists: Page<AccountPlaylistSummary>;
  qqmusic_account_playlist_tracks: AccountPlaylistDetail;
  qqmusic_account_recently_played: Page<RemotePlayHistoryItem>;
  qqmusic_set_favorite: FavoriteMutationResult;
  qqmusic_create_playlist: PlaylistMutationResult;
  qqmusic_rename_playlist: PlaylistMutationResult;
  qqmusic_add_playlist_track: PlaylistMutationResult;
  qqmusic_remove_playlist_track: PlaylistMutationResult;
  qqmusic_delete_playlist: PlaylistMutationResult;
  qqmusic_set_playlist_collected: PlaylistMutationResult;
  qqmusic_auth_start: AccountSnapshot;
  qqmusic_auth_oauth_start: AccountSnapshot;
  qqmusic_auth_heartbeat: AccountSnapshot;
  qqmusic_auth_cancel: AccountSnapshot;
  qqmusic_auth_refresh: AccountSnapshot;
  qqmusic_sign_out: AccountSnapshot;
  qqmusic_cache_stats: CacheStats;
  qqmusic_clear_cache: CacheStats;
  player_snapshot: PlayerSnapshot;
  player_hydrate_queue: PlayerSnapshot;
  player_play_tracks: PlayerSnapshot;
  player_play_from_queue: PlayerSnapshot;
  player_play_queue_entry: PlayerSnapshot;
  player_play: PlayerSnapshot;
  player_pause: PlayerSnapshot;
  player_toggle: PlayerSnapshot;
  player_next: PlayerSnapshot;
  player_previous: PlayerSnapshot;
  player_seek: PlayerSnapshot;
  player_set_volume: PlayerSnapshot;
  player_toggle_muted: PlayerSnapshot;
  player_toggle_shuffle: PlayerSnapshot;
  player_set_shuffle: PlayerSnapshot;
  player_cycle_repeat: PlayerSnapshot;
  player_set_repeat: PlayerSnapshot;
  player_set_primary_playback_mode: PlayerSnapshot;
  player_add_to_queue: PlayerSnapshot;
  player_add_tracks_to_queue: PlayerSnapshot;
  player_remove_from_queue: PlayerSnapshot;
  player_remove_queue_entry: PlayerSnapshot;
  player_reorder_queue_entry: PlayerSnapshot;
  player_play_next_queue_entry: PlayerSnapshot;
  player_set_lyrics: void;
  player_lyrics: LyricDocument | null;
  lyrics_surface_projection: LyricSurfaceProjection;
  app_preferences_get: string | null;
  app_preferences_set: void;
  appearance_pick_background: ManagedBackgroundImage | null;
  appearance_background_load: ManagedBackgroundImage | null;
  lyrics_surfaces_reconcile: SurfaceCapabilities;
  lyrics_surface_capabilities: SurfaceCapabilities;
  lyrics_surface_status: Record<string, boolean>;
  lyrics_surfaces_unlock_all: number;
  lyrics_surface_unlock: void;
  lyrics_surface_close: void;
  lyrics_surface_set_interaction: string;
  lyrics_surface_reset_position: void;
  lyrics_surface_show_settings: void;
  local_api_status: LocalApiStatus;
  local_api_set_enabled: LocalApiStatus;
  local_api_set_port: LocalApiStatus;
  local_api_reveal_token: string;
  local_api_regenerate_token: LocalApiStatus;
  debug_perf_sample: void;
  diagnostics_snapshot: DiagnosticsSnapshot;
  diagnostics_export_bundle: BundleExportResult;
  diagnostics_reveal_bundle: void;
  diagnostics_open_log_folder: string;
  diagnostics_clear_logs: number;
  diagnostics_set_log_level: LogLevel;
  diagnostics_current_level: LogLevel;
  diagnostics_recent_errors: ErrorRecord[];
  diagnostics_record_error: void;
  diagnostics_log_frontend: void;
  issue_reporter_preview: IssuePreview;
  issue_reporter_validate_url: void;
  plugin_list: PluginRecord[];
  plugin_pick_package: string | null;
  plugin_inspect_path: PluginInspectResult;
  plugin_install: PluginRecord;
  plugin_set_enabled: PluginRecord;
  plugin_uninstall: void;
  plugin_set_safe_mode: boolean;
  plugin_set_developer_mode: boolean;
  plugin_active_resources: ActivePluginResources;
  plugin_diagnostics: PluginDiagnostic[];
  plugin_runtime_start: string;
  plugin_runtime_stop: void;
  plugin_mark_failed: PluginRecord;
  plugin_bridge: unknown;
  plugin_pick_directory: string | null;
  plugin_install_unpacked: PluginRecord;
  plugin_reload: PluginRecord;
  plugin_read_asset: PluginAsset;
  plugin_settings_get: Record<string, unknown>;
  plugin_settings_set: Record<string, unknown>;
  core_ping: PingResult;
  platform_attach: void;
  core_shutdown_prepare: void;
  auth_oauth_prepare: OAuthPrepareResult;
  auth_oauth_complete: AccountSnapshot;
  auth_oauth_cancel: AccountSnapshot;
  app_settings_get: string | null;
  app_settings_set: void;
  app_settings_remove: void;
  diagnostics_export_bundle_to: BundleExportResult;
  preferences_set_background_from: ManagedBackgroundImage;
  plugin_install_from: PluginRecord;
}>;

export type ParamsOf<M extends MethodName> = MethodParams[M];
export type ResultOf<M extends MethodName> = MethodResult[M];
