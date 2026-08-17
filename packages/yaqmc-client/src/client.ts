import type { HostBridge, HostShellBridge, HostWindowBridge, InvokeArgs } from './bridge';
import {
  CHANNEL_LYRICS_DOCUMENT,
  CHANNEL_LYRICS_PROJECTION,
  CHANNEL_PLAYER_SNAPSHOT,
  CORE_EVENT_CHANNELS,
  HOST_EVENT_CHANNELS,
  type ChannelName,
  type ChannelPayload,
} from './protocol/events';
import type { MethodName, MethodParams, MethodResult } from './protocol/methods';

export const READY_QUEUE_TIMEOUT_MS = 15_000;

export class CoreUnavailableError extends Error {
  readonly code = 'core.unavailable';

  constructor(message = 'core.unavailable') {
    super(message);
    this.name = 'CoreUnavailableError';
  }
}

type Listener<C extends ChannelName> = (payload: ChannelPayload[C]) => void;

const ALL_CHANNELS: ChannelName[] = [...CORE_EVENT_CHANNELS, ...HOST_EVENT_CHANNELS];

export class YaqmcClient {
  private ready = false;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (error: CoreUnavailableError) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private readonly listeners = new Map<ChannelName, Set<Listener<ChannelName>>>();
  private readonly stopListening: Array<() => void> = [];

  readonly player = {
    snapshot: () => this.invoke('player_snapshot'),
    hydrateQueue: (tracks: MethodParams['player_hydrate_queue']['tracks']) =>
      this.invoke('player_hydrate_queue', { tracks }),
    playTracks: (request: MethodParams['player_play_tracks']['request']) =>
      this.invoke('player_play_tracks', { request }),
    playFromQueue: (index: number) => this.invoke('player_play_from_queue', { index }),
    playQueueEntry: (entryId: string) => this.invoke('player_play_queue_entry', { entryId }),
    play: () => this.invoke('player_play'),
    pause: () => this.invoke('player_pause'),
    toggle: () => this.invoke('player_toggle'),
    next: () => this.invoke('player_next'),
    previous: () => this.invoke('player_previous'),
    seek: (positionMs: number) => this.invoke('player_seek', { positionMs }),
    setVolume: (volume: number) => this.invoke('player_set_volume', { volume }),
    toggleMuted: () => this.invoke('player_toggle_muted'),
    toggleShuffle: () => this.invoke('player_toggle_shuffle'),
    setShuffle: (enabled: boolean) => this.invoke('player_set_shuffle', { enabled }),
    cycleRepeat: () => this.invoke('player_cycle_repeat'),
    setRepeat: (mode: MethodParams['player_set_repeat']['mode']) =>
      this.invoke('player_set_repeat', { mode }),
    setPrimaryPlaybackMode: (mode: MethodParams['player_set_primary_playback_mode']['mode']) =>
      this.invoke('player_set_primary_playback_mode', { mode }),
    addToQueue: (track: MethodParams['player_add_to_queue']['track']) =>
      this.invoke('player_add_to_queue', { track }),
    addTracksToQueue: (tracks: MethodParams['player_add_tracks_to_queue']['tracks']) =>
      this.invoke('player_add_tracks_to_queue', { tracks }),
    removeFromQueue: (index: number) => this.invoke('player_remove_from_queue', { index }),
    removeQueueEntry: (entryId: string) => this.invoke('player_remove_queue_entry', { entryId }),
    reorderQueueEntry: (entryId: string, targetIndex: number) =>
      this.invoke('player_reorder_queue_entry', { entryId, targetIndex }),
    playNextQueueEntry: (entryId: string) =>
      this.invoke('player_play_next_queue_entry', { entryId }),
    setLyrics: (document: MethodParams['player_set_lyrics']['document']) =>
      this.invoke('player_set_lyrics', { document }),
    lyrics: () => this.invoke('player_lyrics'),
    projection: () => this.invoke('lyrics_surface_projection'),
  };

  readonly catalog = {
    status: () => this.invoke('qqmusic_status'),
    home: (refresh: boolean) => this.invoke('qqmusic_home', { refresh }),
    discover: (refresh: boolean) => this.invoke('qqmusic_discover', { refresh }),
    area: (encArea: string) => this.invoke('qqmusic_area', { encArea }),
    guessNext: (limit: number) => this.invoke('qqmusic_guess_next', { limit }),
    library: () => this.invoke('qqmusic_library'),
    search: (query: string, page: number, limit: number) =>
      this.invoke('qqmusic_search', { query, page, limit }),
    album: (id: string) => this.invoke('qqmusic_album', { id }),
    playlist: (id: string) => this.invoke('qqmusic_playlist', { id }),
    lyrics: (songId: string) => this.invoke('qqmusic_lyrics', { songId }),
    cacheArtwork: (url: string) => this.invoke('qqmusic_cache_artwork', { url }),
    setPreferredQuality: (quality: MethodParams['qqmusic_set_preferred_quality']['quality']) =>
      this.invoke('qqmusic_set_preferred_quality', { quality }),
    setCurrentQuality: (quality: MethodParams['qqmusic_set_current_quality']['quality']) =>
      this.invoke('qqmusic_set_current_quality', { quality }),
    cacheStats: () => this.invoke('qqmusic_cache_stats'),
    clearCache: () => this.invoke('qqmusic_clear_cache'),
  };

  readonly account = {
    snapshot: () => this.invoke('qqmusic_account_snapshot'),
    favoriteSongs: (cursor: string | null, limit: number) =>
      this.invoke('qqmusic_favorite_songs', { cursor, limit }),
    playlists: (cursor: string | null, limit: number) =>
      this.invoke('qqmusic_account_playlists', { cursor, limit }),
    playlistTracks: (
      playlist: MethodParams['qqmusic_account_playlist_tracks']['playlist'],
      cursor: string | null,
      limit: number,
    ) => this.invoke('qqmusic_account_playlist_tracks', { playlist, cursor, limit }),
    recentlyPlayed: (cursor: string | null, limit: number) =>
      this.invoke('qqmusic_account_recently_played', { cursor, limit }),
    setFavorite: (request: MethodParams['qqmusic_set_favorite']['request']) =>
      this.invoke('qqmusic_set_favorite', { request }),
    createPlaylist: (request: MethodParams['qqmusic_create_playlist']['request']) =>
      this.invoke('qqmusic_create_playlist', { request }),
    renamePlaylist: (request: MethodParams['qqmusic_rename_playlist']['request']) =>
      this.invoke('qqmusic_rename_playlist', { request }),
    addPlaylistTrack: (request: MethodParams['qqmusic_add_playlist_track']['request']) =>
      this.invoke('qqmusic_add_playlist_track', { request }),
    removePlaylistTrack: (request: MethodParams['qqmusic_remove_playlist_track']['request']) =>
      this.invoke('qqmusic_remove_playlist_track', { request }),
    deletePlaylist: (request: MethodParams['qqmusic_delete_playlist']['request']) =>
      this.invoke('qqmusic_delete_playlist', { request }),
    setPlaylistCollected: (request: MethodParams['qqmusic_set_playlist_collected']['request']) =>
      this.invoke('qqmusic_set_playlist_collected', { request }),
    authStart: () => this.invoke('qqmusic_auth_start'),
    authOauthStart: (loginProvider: MethodParams['qqmusic_auth_oauth_start']['loginProvider']) =>
      this.invoke('qqmusic_auth_oauth_start', { loginProvider }),
    authHeartbeat: (attemptId: string, ownerLeaseId: string) =>
      this.invoke('qqmusic_auth_heartbeat', { attemptId, ownerLeaseId }),
    authCancel: (attemptId: string) => this.invoke('qqmusic_auth_cancel', { attemptId }),
    authRefresh: (attemptId: string | null) => this.invoke('qqmusic_auth_refresh', { attemptId }),
    signOut: () => this.invoke('qqmusic_sign_out'),
  };

  readonly plugins = {
    list: () => this.invoke('plugin_list'),
    pickPackage: () => this.invoke('plugin_pick_package'),
    inspectPath: (path: string) => this.invoke('plugin_inspect_path', { path }),
    install: (request: MethodParams['plugin_install']['request']) =>
      this.invoke('plugin_install', { request }),
    installFrom: (request: MethodParams['plugin_install_from']['request']) =>
      this.invoke('plugin_install_from', { request }),
    setEnabled: (request: MethodParams['plugin_set_enabled']['request']) =>
      this.invoke('plugin_set_enabled', { request }),
    uninstall: (request: MethodParams['plugin_uninstall']['request']) =>
      this.invoke('plugin_uninstall', { request }),
    setSafeMode: (enabled: boolean) => this.invoke('plugin_set_safe_mode', { enabled }),
    setDeveloperMode: (enabled: boolean) => this.invoke('plugin_set_developer_mode', { enabled }),
    activeResources: () => this.invoke('plugin_active_resources'),
    diagnostics: () => this.invoke('plugin_diagnostics'),
    runtimeStart: (pluginId: string) => this.invoke('plugin_runtime_start', { pluginId }),
    runtimeStop: (token: string) => this.invoke('plugin_runtime_stop', { token }),
    markFailed: (id: string, reason: string) => this.invoke('plugin_mark_failed', { id, reason }),
    bridge: (request: MethodParams['plugin_bridge']['request']) =>
      this.invoke('plugin_bridge', { request }),
    pickDirectory: () => this.invoke('plugin_pick_directory'),
    installUnpacked: (request: MethodParams['plugin_install_unpacked']['request']) =>
      this.invoke('plugin_install_unpacked', { request }),
    reload: (id: string) => this.invoke('plugin_reload', { id }),
    readAsset: (pluginId: string, path: string) =>
      this.invoke('plugin_read_asset', { pluginId, path }),
    settingsGet: (id: string) => this.invoke('plugin_settings_get', { id }),
    settingsSet: (request: MethodParams['plugin_settings_set']['request']) =>
      this.invoke('plugin_settings_set', { request }),
  };

  readonly host: {
    window: HostWindowBridge;
    shell: HostShellBridge;
    systemIntegrationStatus: () => Promise<MethodResult['system_integration_status']>;
    setShortcutsEnabled: (
      enabled: boolean,
    ) => Promise<MethodResult['system_shortcuts_set_enabled']>;
  };

  constructor(readonly bridge: HostBridge) {
    this.host = {
      window: bridge.window,
      shell: bridge.shell,
      systemIntegrationStatus: () => this.invoke('system_integration_status'),
      setShortcutsEnabled: (enabled: boolean) =>
        this.invoke('system_shortcuts_set_enabled', { enabled }),
    };
    for (const channel of ALL_CHANNELS) {
      this.stopListening.push(
        bridge.listen(channel, (payload) => {
          this.emit(channel, payload);
        }),
      );
    }
  }

  markReady(): void {
    this.ready = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  markUnavailable(): void {
    this.ready = false;
  }

  dispose(): void {
    for (const stop of this.stopListening) stop();
    this.stopListening.length = 0;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new CoreUnavailableError());
    }
  }

  on<C extends ChannelName>(channel: C, handler: Listener<C>): () => void {
    const bucket = this.listeners.get(channel) ?? new Set();
    bucket.add(handler as Listener<ChannelName>);
    this.listeners.set(channel, bucket);
    return () => {
      bucket.delete(handler as Listener<ChannelName>);
    };
  }

  invoke<M extends MethodName>(method: M, ...params: InvokeArgs<M>): Promise<MethodResult[M]> {
    return this.whenReady().then(() => this.bridge.invoke(method, ...params));
  }

  async resync(): Promise<{
    snapshot: MethodResult['player_snapshot'];
    projection: MethodResult['lyrics_surface_projection'];
    document: MethodResult['player_lyrics'];
    preferences: MethodResult['app_preferences_get'];
    plugins: MethodResult['plugin_list'];
  }> {
    const [snapshot, projection, document, preferences, plugins] = await Promise.all([
      this.invoke('player_snapshot'),
      this.invoke('lyrics_surface_projection'),
      this.invoke('player_lyrics'),
      this.invoke('app_preferences_get'),
      this.invoke('plugin_list'),
    ]);
    this.emit(CHANNEL_PLAYER_SNAPSHOT, snapshot);
    this.emit(CHANNEL_LYRICS_PROJECTION, projection);
    if (document) this.emit(CHANNEL_LYRICS_DOCUMENT, document);
    return { snapshot, projection, document, preferences, plugins };
  }

  private emit<C extends ChannelName>(channel: C, payload: ChannelPayload[C]): void {
    for (const handler of this.listeners.get(channel) ?? []) {
      (handler as Listener<C>)(payload);
    }
  }

  private whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new CoreUnavailableError());
        }, READY_QUEUE_TIMEOUT_MS),
      };
      this.waiters.push(waiter);
    });
  }
}
